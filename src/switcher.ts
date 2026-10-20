import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { generateBranchName } from './branchName';
import { focusOrOpenWindow } from './code';
import {
  addWorktree,
  addWorktreeNewBranch,
  cloneWorktreeDependencies,
  graphiteTrack,
  listGraphiteBranches,
  listWorktrees,
  pinNxWorkspaceRoot,
  RepoContext,
  resolveRepo,
  Worktree,
} from './git';
import { PostCreateFailure, runPostCreateCommands } from './postCreate';
import { formatElapsed, StepProgress } from './progress';
import { getOpenWorktreePaths, normalize } from './registry';

const CONFIG_SECTION = 'grove';
const DEFAULT_NEW_BRANCH_BASE = 'master';
const DEFAULT_POST_CREATE_COMMANDS = ['mise trust'];
const SHOW_LOG = 'Show Log';

// `kind` is reserved by QuickPickItem (for separators), so the action
// discriminant lives on its own field.
type ActionItem = vscode.QuickPickItem &
  (
    | { action: 'worktree'; worktree: Worktree; open: boolean }
    | { action: 'create'; branch: string }
    | { action: 'new-branch' }
  );

export function registerSwitchCommand(
  context: vscode.ExtensionContext,
  log: (message: string) => void
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('grove.switchWorktree', () =>
      switchWorktree(log)
    )
  );
}

async function switchWorktree(log: (message: string) => void): Promise<void> {
  const cwd = currentRepoCwd();
  if (!cwd) {
    vscode.window.showErrorMessage(
      'Grove: no open folder to resolve a git repository from.'
    );
    return;
  }

  const repo = await resolveRepo(cwd);
  if (!repo) {
    vscode.window.showErrorMessage(
      `Grove: ${cwd} is not inside a git repository.`
    );
    return;
  }

  let worktrees: Worktree[];
  try {
    worktrees = await listWorktrees(repo.cwd);
  } catch (err) {
    vscode.window.showErrorMessage(`Grove: failed to list worktrees: ${err}`);
    return;
  }

  const openPaths = getOpenWorktreePaths();
  const branchesWithWorktree = new Set(
    worktrees.map((w) => w.branch).filter((b): b is string => !!b)
  );
  const graphiteBranches = (await listGraphiteBranches(repo.cwd)).filter(
    (b) => !branchesWithWorktree.has(b)
  );

  const items = buildItems(worktrees, openPaths, graphiteBranches);
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: 'Create a new branch, switch to a worktree, or create one for a Graphite branch',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!pick || !('action' in pick)) {
    return;
  }

  if (pick.action === 'worktree') {
    // `code <path>` focuses an open window; a not-open worktree needs -n so we
    // don't clobber the current window. The CLI's own de-dup is the safety net
    // if the registry is momentarily wrong.
    void focusOrOpenWindow(pick.worktree.path, !pick.open, log);
    return;
  }

  if (pick.action === 'new-branch') {
    await createNewBranch(repo, log);
    return;
  }

  await createAndOpen(repo, pick.branch, log);
}

/**
 * Prompts for a task description, formats it into a Graphite-style branch name,
 * then creates the branch (based on the configured base), a worktree for it,
 * tracks it with Graphite, and opens a new window.
 */
async function createNewBranch(
  repo: RepoContext,
  log: (message: string) => void
): Promise<void> {
  const base = newBranchBase(repo);
  const description = await vscode.window.showInputBox({
    prompt: `Describe the task — it becomes a branch off ${base}`,
    placeHolder: 'e.g. fix flaky connection test dashboard',
    validateInput: (value) =>
      value.trim() ? undefined : 'Enter a task description.',
  });
  if (description === undefined || !description.trim()) {
    return;
  }

  let branch: string;
  try {
    branch = generateBranchName(description);
  } catch (err) {
    vscode.window.showErrorMessage(`Grove: ${err}`);
    return;
  }

  await createAndOpen(repo, branch, log, { base });
}

async function createAndOpen(
  repo: RepoContext,
  branch: string,
  log: (message: string) => void,
  // When set, a new branch named `branch` is created at `base`, otherwise an
  // existing branch is checked out into the worktree.
  options?: { base: string }
): Promise<void> {
  const { mainRoot } = repo;
  const baseDir = worktreeBaseDir(repo);
  const worktreePath = path.join(baseDir, slugify(branch));
  if (fs.existsSync(worktreePath)) {
    vscode.window.showErrorMessage(
      `Grove: ${worktreePath} already exists; not overwriting.`
    );
    return;
  }
  const commands = postCreateCommands(repo);
  // Each step below calls steps.next(); keep this count in sync with them.
  const steps = new StepProgress((options ? 5 : 4) + (commands.length ? 1 : 0), log);
  const onCheckout = (done: number, total: number) =>
    steps.update(`${done.toLocaleString()} of ${total.toLocaleString()} files`, done / total);
  let opened: boolean;
  try {
    opened = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Creating worktree for ${branch}` },
      (progress) =>
        steps.run(progress, async () => {
          log(`Creating worktree for ${branch} at ${worktreePath}`);
          if (options) {
            steps.next(`Creating branch from ${options.base}`);
            fs.mkdirSync(baseDir, { recursive: true });
            await addWorktreeNewBranch(mainRoot, worktreePath, branch, options.base, onCheckout);
            steps.next('Tracking with Graphite');
            if (!(await graphiteTrack(worktreePath, branch, options.base, log))) {
              // Don't block on the notification; the worktree is still usable.
              offerLog(
                vscode.window.showWarningMessage(
                  `Grove: created ${branch}, but \`gt track --parent ${options.base}\` failed. ` +
                    'Run it manually in the worktree.',
                  SHOW_LOG
                )
              );
            }
          } else {
            steps.next('Checking out branch');
            fs.mkdirSync(baseDir, { recursive: true });
            await addWorktree(mainRoot, worktreePath, branch, onCheckout);
          }
          steps.next('Cloning node_modules');
          steps.update('finding folders…');
          // Copy-on-write clone deps from the main checkout, matching gt-wt.
          await cloneWorktreeDependencies(mainRoot, worktreePath, log, (done, total, current) =>
            steps.update(
              current
                ? `${done + 1} of ${total} · ${current.replace(/^\.\//, '')}`
                : total ? `${total} cloned` : 'nothing to clone',
              total ? done / total : 1
            )
          );
          steps.next('Pinning Nx workspace root');
          await pinNxWorkspaceRoot(worktreePath, log);
          if (commands.length) {
            steps.next('Running post-create commands');
            const failures = await runPostCreateCommands(
              commands,
              { worktreePath, branch, mainRoot, base: options?.base },
              log,
              (index, command) =>
                steps.update(
                  `${index + 1} of ${commands.length} · ${truncate(command, 60)}`,
                  index / commands.length
                )
            );
            if (failures.length) {
              warnPostCreateFailures(branch, failures);
            }
          }
          steps.next('Opening window');
          return focusOrOpenWindow(worktreePath, true, log);
        })
    );
  } catch (err) {
    log(`Failed to create worktree for ${branch} during "${steps.current}": ${err}`);
    offerLog(
      vscode.window.showErrorMessage(
        `Grove: couldn't create worktree for ${branch}. ${steps.current} failed: ` +
          (err instanceof Error ? err.message : String(err)),
        SHOW_LOG
      )
    );
    return;
  }

  const took = formatElapsed(steps.elapsedMs);
  log(`Worktree for ${branch} ready in ${took}`);
  if (opened) {
    // The new window takes focus; this is for when you come back to this one.
    vscode.window.setStatusBarMessage(`$(check) Grove: ${branch} ready (${took})`, 10_000);
    return;
  }
  const choice = await vscode.window.showErrorMessage(
    `Grove: created worktree for ${branch} in ${took}, but couldn't open a window for it.`,
    'Open Folder',
    SHOW_LOG
  );
  if (choice === 'Open Folder') {
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(worktreePath), {
      forceNewWindow: true,
    });
  } else if (choice === SHOW_LOG) {
    showLog();
  }
}

/** Warns, without blocking, that some post-create commands failed. */
function warnPostCreateFailures(branch: string, failures: PostCreateFailure[]): void {
  const list = failures.map((f) => `\`${truncate(f.command, 60)}\` (${f.reason})`).join(', ');
  offerLog(
    vscode.window.showWarningMessage(
      failures.length === 1
        ? `Grove: created ${branch}, but post-create command ${list} failed.`
        : `Grove: created ${branch}, but ${failures.length} post-create commands failed: ${list}.`,
      SHOW_LOG
    )
  );
}

/** Adds the "Show Log" button's behaviour to a notification without awaiting it. */
function offerLog(choice: Thenable<string | undefined>): void {
  void choice.then((picked) => {
    if (picked === SHOW_LOG) {
      showLog();
    }
  });
}

function showLog(): void {
  void vscode.commands.executeCommand('grove.showLog');
}

function buildItems(
  worktrees: Worktree[],
  openPaths: Set<string>,
  graphiteBranches: string[]
): (ActionItem | vscode.QuickPickItem)[] {
  const items: (ActionItem | vscode.QuickPickItem)[] = [];
  items.push({
    action: 'new-branch',
    label: '$(add) New Branch',
    description: 'create a branch from a task description',
  });
  items.push({ label: 'Worktrees', kind: vscode.QuickPickItemKind.Separator });
  for (const worktree of worktrees) {
    // A prunable worktree points at a directory that no longer exists on disk.
    if (worktree.prunable || worktree.bare) {
      continue;
    }
    const open = openPaths.has(normalize(worktree.path));
    items.push({
      action: 'worktree',
      worktree,
      open,
      label: `${open ? '$(check) ' : '$(git-branch) '}${worktree.branch ?? '(detached)'}`,
      description: open ? 'open — focus' : 'open in new window',
      detail: worktree.path,
    });
  }

  if (graphiteBranches.length > 0) {
    items.push({
      label: 'Graphite branches without a worktree',
      kind: vscode.QuickPickItemKind.Separator,
    });
    for (const branch of graphiteBranches) {
      items.push({
        action: 'create',
        branch,
        label: `$(add) ${branch}`,
        description: 'create worktree',
      });
    }
  }

  return items;
}

function currentRepoCwd(): string | undefined {
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri?.scheme === 'file') {
    return path.dirname(activeUri.fsPath);
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

// Settings are scoped to the folder the repo was resolved from: once the watcher
// adds a worktree the window is multi-root, and unscoped reads would miss the
// repo's .vscode/settings.json.
function worktreeBaseDir(repo: RepoContext): string {
  const configured = vscode.workspace
    .getConfiguration(CONFIG_SECTION, vscode.Uri.file(repo.cwd))
    .get<string>('worktreeBaseDir', '');
  if (configured) {
    return path.isAbsolute(configured)
      ? configured
      : path.join(repo.mainRoot, configured);
  }
  return path.join(repo.mainRoot, '.claude', 'worktrees');
}

function newBranchBase(repo: RepoContext): string {
  const configured = vscode.workspace
    .getConfiguration(CONFIG_SECTION, vscode.Uri.file(repo.cwd))
    .get<string>('newBranchBase', '');
  return configured.trim() || DEFAULT_NEW_BRANCH_BASE;
}

function postCreateCommands(repo: RepoContext): string[] {
  const configured = vscode.workspace
    .getConfiguration(CONFIG_SECTION, vscode.Uri.file(repo.cwd))
    .get<unknown>('postCreateCommands', DEFAULT_POST_CREATE_COMMANDS);
  return Array.isArray(configured)
    ? configured.filter((c): c is string => typeof c === 'string' && c.trim() !== '')
    : [];
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function slugify(branch: string): string {
  return branch.replace(/\//g, '-');
}
