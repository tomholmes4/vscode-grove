import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { focusOrOpenWindow } from './code';
import {
  addWorktree,
  listGraphiteBranches,
  listWorktrees,
  resolveRepo,
  Worktree,
} from './git';
import { getOpenWorktreePaths, normalize } from './registry';

const CONFIG_SECTION = 'worktreeWatcher';

// `kind` is reserved by QuickPickItem (for separators), so the action
// discriminant lives on its own field.
type ActionItem = vscode.QuickPickItem &
  (
    | { action: 'worktree'; worktree: Worktree; open: boolean }
    | { action: 'create'; branch: string }
  );

export function registerSwitchCommand(
  context: vscode.ExtensionContext,
  log: (message: string) => void
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('worktreeWatcher.switchWorktree', () =>
      switchWorktree(log)
    )
  );
}

async function switchWorktree(log: (message: string) => void): Promise<void> {
  const cwd = currentRepoCwd();
  if (!cwd) {
    vscode.window.showErrorMessage(
      'Worktree Watcher: no open folder to resolve a git repository from.'
    );
    return;
  }

  const repo = await resolveRepo(cwd);
  if (!repo) {
    vscode.window.showErrorMessage(
      `Worktree Watcher: ${cwd} is not inside a git repository.`
    );
    return;
  }

  let worktrees: Worktree[];
  try {
    worktrees = await listWorktrees(repo.cwd);
  } catch (err) {
    vscode.window.showErrorMessage(`Worktree Watcher: failed to list worktrees: ${err}`);
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
    placeHolder: 'Switch to a worktree, or create one for a Graphite branch',
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

  await createAndOpen(repo.mainRoot, pick.branch, log);
}

async function createAndOpen(
  mainRoot: string,
  branch: string,
  log: (message: string) => void
): Promise<void> {
  const baseDir = worktreeBaseDir(mainRoot);
  const worktreePath = path.join(baseDir, slugify(branch));
  if (fs.existsSync(worktreePath)) {
    vscode.window.showErrorMessage(
      `Worktree Watcher: ${worktreePath} already exists; not overwriting.`
    );
    return;
  }
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Creating worktree for ${branch}` },
      async () => {
        fs.mkdirSync(baseDir, { recursive: true });
        log(`Creating worktree for ${branch} at ${worktreePath}`);
        await addWorktree(mainRoot, worktreePath, branch);
      }
    );
  } catch (err) {
    vscode.window.showErrorMessage(
      `Worktree Watcher: failed to create worktree for ${branch}: ${err}`
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

function worktreeBaseDir(mainRoot: string): string {
  const configured = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<string>('worktreeBaseDir', '');
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.join(mainRoot, configured);
  }
  return path.join(mainRoot, '.claude', 'worktrees');
}

function slugify(branch: string): string {
  return branch.replace(/\//g, '-');
}
