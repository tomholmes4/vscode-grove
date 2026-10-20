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
  trustMise,
  Worktree,
} from './git';
import { getOpenWorktreePaths, normalize } from './registry';

const CONFIG_SECTION = 'grove';
const DEFAULT_NEW_BRANCH_BASE = 'master';

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
    focusOrOpenWindow(pick.worktree.path, !pick.open, log);
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
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Creating worktree for ${branch}` },
      async (progress) => {
        fs.mkdirSync(baseDir, { recursive: true });
        log(`Creating worktree for ${branch} at ${worktreePath}`);
        if (options) {
          await addWorktreeNewBranch(mainRoot, worktreePath, branch, options.base);
          progress.report({ message: 'tracking with Graphite…' });
          if (!(await graphiteTrack(worktreePath, branch, options.base, log))) {
            // Don't block on the notification; the worktree is still usable.
            void vscode.window.showWarningMessage(
              `Grove: created ${branch}, but \`gt track --parent ${options.base}\` failed. ` +
                `Run it manually in the worktree; see the Grove output for details.`
            );
          }
        } else {
          await addWorktree(mainRoot, worktreePath, branch);
        }
        progress.report({ message: 'cloning node_modules…' });
        // Copy-on-write clone deps from the main checkout, matching gt-wt.
        await cloneWorktreeDependencies(mainRoot, worktreePath, log);
        progress.report({ message: 'mise trust…' });
        await trustMise(worktreePath, log);
        progress.report({ message: 'pinning Nx workspace root…' });
        await pinNxWorkspaceRoot(worktreePath, log);
      }
    );
  } catch (err) {
    vscode.window.showErrorMessage(
      `Grove: failed to create worktree for ${branch}: ${err}`
    );
    return;
  }
  focusOrOpenWindow(worktreePath, true, log);
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

function slugify(branch: string): string {
  return branch.replace(/\//g, '-');
}
