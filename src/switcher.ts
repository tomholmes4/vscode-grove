import * as path from 'path';
import * as vscode from 'vscode';
import { focusOrOpenWindow } from './code';
import { listWorktrees, resolveRepo, Worktree } from './git';
import { getOpenWorktreePaths, normalize } from './registry';

// `kind` is reserved by QuickPickItem (for separators), so the action
// discriminant lives on its own field.
type ActionItem = vscode.QuickPickItem & {
  action: 'worktree';
  worktree: Worktree;
  open: boolean;
};

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

  const items = buildItems(worktrees, getOpenWorktreePaths());
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: 'Switch to a worktree',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!pick) {
    return;
  }

  // `code <path>` focuses an open window; a not-open worktree needs -n so we
  // don't clobber the current window. The CLI's own de-dup is the safety net
  // if the registry is momentarily wrong.
  focusOrOpenWindow(pick.worktree.path, !pick.open, log);
}

function buildItems(worktrees: Worktree[], openPaths: Set<string>): ActionItem[] {
  const items: ActionItem[] = [];
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
  return items;
}

function currentRepoCwd(): string | undefined {
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri?.scheme === 'file') {
    return path.dirname(activeUri.fsPath);
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}
