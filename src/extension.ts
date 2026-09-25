import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { registerSwitchCommand } from './switcher';
import { registerWindow, unregisterWindow } from './registry';

const CONFIG_SECTION = 'worktreeWatcher';

// git worktree add creates the folder before the .git file and checkout are
// complete, so newly seen folders are polled until they look like a worktree.
const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 15_000;

let output: vscode.OutputChannel;
let watchers: fs.FSWatcher[] = [];
let watchedDirs: string[] = [];
let rescanTimer: NodeJS.Timeout | undefined;
const pendingPolls = new Map<string, NodeJS.Timeout>();

// updateWorkspaceFolders applies asynchronously and rejects overlapping calls,
// so all workspace mutations are serialized through this queue.
let opQueue: Promise<void> = Promise.resolve();

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Worktree Watcher');
  context.subscriptions.push(output);

  context.subscriptions.push(
    vscode.commands.registerCommand('worktreeWatcher.scan', () => {
      scanWatchedDirectories();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(CONFIG_SECTION)) {
        restartWatchers();
      }
    }),
    // Opening/closing a repo should pull in / drop its worktrees. The scan is
    // idempotent, so the events fired by our own updates are harmless.
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (rescanTimer) {
        clearTimeout(rescanTimer);
      }
      rescanTimer = setTimeout(() => {
        rescanTimer = undefined;
        // Folder-scoped settings contribute to the watched set, so a folder
        // change can change which directories should be watched.
        const dirs = getWatchedDirectories();
        if (dirs.join('\n') !== watchedDirs.join('\n')) {
          restartWatchers();
        } else {
          scanWatchedDirectories();
        }
      }, 500);
    }),
    new vscode.Disposable(() => stopWatchers())
  );

  // The switcher advertises this window's worktrees so sibling windows can
  // decide whether to focus an existing window or open a new one.
  registerSwitchCommand(context, log);
  updateWindowRegistration();
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => updateWindowRegistration()),
    new vscode.Disposable(() => unregisterWindow())
  );

  restartWatchers();
}

export function deactivate(): void {
  stopWatchers();
  unregisterWindow();
}

function updateWindowRegistration(): void {
  const paths = (vscode.workspace.workspaceFolders ?? [])
    .filter((f) => f.uri.scheme === 'file')
    .map((f) => f.uri.fsPath);
  registerWindow(paths);
}

function log(message: string): void {
  output.appendLine(`[${new Date().toISOString()}] ${message}`);
}

function getWatchedDirectories(): string[] {
  // In a multi-root workspace, getConfiguration() without a resource only
  // sees user and workspace-file settings — folder-level .vscode/settings.json
  // values need a resource scope. Adding the first worktree converts a
  // single-folder window into a multi-root workspace, so folder scopes must
  // be included or the extension loses its own configuration.
  const configured = new Set<string>();
  const scopes: (vscode.Uri | undefined)[] = [
    undefined,
    ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri),
  ];
  for (const scope of scopes) {
    for (const entry of vscode.workspace
      .getConfiguration(CONFIG_SECTION, scope)
      .get<string[]>('directories', [])) {
      configured.add(entry);
    }
  }
  const dirs: string[] = [];
  for (const entry of configured) {
    const dir = expandPath(entry);
    if (dirs.includes(dir)) {
      continue;
    }
    try {
      if (fs.statSync(dir).isDirectory()) {
        dirs.push(dir);
        continue;
      }
    } catch {
      // fall through
    }
    log(`Skipping "${entry}": not an existing directory`);
  }
  return dirs;
}

function expandPath(p: string): string {
  if (p === '~' || p.startsWith('~/')) {
    p = path.join(os.homedir(), p.slice(1));
  }
  return path.resolve(p);
}

/**
 * A linked worktree has a `.git` file (not directory) whose gitdir points
 * inside the parent repository's `.git/worktrees/` directory.
 */
function isLinkedWorktree(dir: string): boolean {
  return getParentRepoRoot(dir) !== undefined;
}

/**
 * Resolves the root of the repository a linked worktree belongs to, by
 * parsing its `.git` file (`gitdir: <repo>/.git/worktrees/<name>`).
 * Returns undefined if the directory is not a linked worktree.
 */
function getParentRepoRoot(dir: string): string | undefined {
  const gitPath = path.join(dir, '.git');
  let content: string;
  try {
    if (!fs.statSync(gitPath).isFile()) {
      return undefined;
    }
    content = fs.readFileSync(gitPath, 'utf8');
  } catch {
    return undefined;
  }
  const match = /^gitdir:\s*(.+)$/m.exec(content);
  if (!match) {
    return undefined;
  }
  const gitdir = path.resolve(dir, match[1].trim());
  const segments = gitdir.split(path.sep);
  const worktreesIndex = segments.lastIndexOf('worktrees');
  if (worktreesIndex <= 0) {
    return undefined;
  }
  let repoSegments = segments.slice(0, worktreesIndex);
  // Non-bare repos keep worktree metadata under <repo>/.git/worktrees/.
  if (repoSegments[repoSegments.length - 1] === '.git') {
    repoSegments = repoSegments.slice(0, -1);
  }
  return repoSegments.join(path.sep) || path.sep;
}

/**
 * True when the repository the worktree belongs to is open in the current
 * workspace: a workspace folder is the repo root or a directory inside it.
 * Workspace folders that are themselves linked worktrees don't count, so a
 * worktree being open doesn't pull in its siblings.
 */
function isParentRepoOpen(worktreeDir: string): boolean {
  const repoRoot = getParentRepoRoot(worktreeDir);
  if (!repoRoot) {
    return false;
  }
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const fsPath = folder.uri.fsPath;
    if (fsPath === repoRoot) {
      return true;
    }
    if (isSubPath(repoRoot, fsPath) && !isLinkedWorktree(fsPath)) {
      return true;
    }
  }
  return false;
}

function isSubPath(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function restartWatchers(): void {
  stopWatchers();
  const dirs = getWatchedDirectories();
  watchedDirs = dirs;
  for (const dir of dirs) {
    try {
      const watcher = fs.watch(dir, (_event, filename) => {
        if (filename) {
          handleDirectoryEvent(dir, filename.toString());
        } else {
          scanDirectory(dir);
        }
      });
      watcher.on('error', (err) => log(`Watcher error for ${dir}: ${err}`));
      watchers.push(watcher);
      log(`Watching ${dir}`);
    } catch (err) {
      log(`Failed to watch ${dir}: ${err}`);
    }
  }
  scanWatchedDirectories();
}

function stopWatchers(): void {
  for (const watcher of watchers) {
    watcher.close();
  }
  watchers = [];
  if (rescanTimer) {
    clearTimeout(rescanTimer);
    rescanTimer = undefined;
  }
  for (const timer of pendingPolls.values()) {
    clearTimeout(timer);
  }
  pendingPolls.clear();
}

function handleDirectoryEvent(watchedDir: string, filename: string): void {
  const child = path.join(watchedDir, filename);
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(child);
  } catch {
    stat = undefined;
  }

  if (stat?.isDirectory()) {
    pollForWorktree(child);
  } else if (!stat) {
    cancelPoll(child);
    // Only touch the workspace if the deleted entry was a workspace folder.
    if (findWorkspaceFolderIndex(child) >= 0) {
      removeWorkspaceFolder(child);
    }
  }
}

/** Poll a candidate folder until it becomes a worktree, vanishes, or times out. */
function pollForWorktree(dir: string): void {
  cancelPoll(dir);
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  const tick = () => {
    pendingPolls.delete(dir);
    try {
      if (!fs.statSync(dir).isDirectory()) {
        return;
      }
    } catch {
      return;
    }
    if (isLinkedWorktree(dir)) {
      if (isParentRepoOpen(dir)) {
        addWorkspaceFolder(dir);
      } else {
        log(`Ignoring ${dir}: its repository is not open in this workspace`);
      }
      return;
    }
    if (Date.now() < deadline) {
      pendingPolls.set(dir, setTimeout(tick, POLL_INTERVAL_MS));
    }
  };
  tick();
}

function cancelPoll(dir: string): void {
  const timer = pendingPolls.get(dir);
  if (timer) {
    clearTimeout(timer);
    pendingPolls.delete(dir);
  }
}

function scanWatchedDirectories(): void {
  const dirs = getWatchedDirectories();
  for (const dir of dirs) {
    scanDirectory(dir);
  }
  // Drop workspace folders under a watched directory whose worktree no longer
  // exists (e.g. removed while VS Code was closed) or whose repository is no
  // longer open in this workspace.
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const fsPath = folder.uri.fsPath;
    if (!dirs.includes(path.dirname(fsPath))) {
      continue;
    }
    if (!fs.existsSync(fsPath)) {
      removeWorkspaceFolder(fsPath);
    } else if (isLinkedWorktree(fsPath) && !isParentRepoOpen(fsPath)) {
      removeWorkspaceFolder(fsPath);
    }
  }
}

function scanDirectory(dir: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    log(`Failed to read ${dir}: ${err}`);
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const child = path.join(dir, entry.name);
    if (isLinkedWorktree(child) && isParentRepoOpen(child)) {
      addWorkspaceFolder(child);
    }
  }
}

function findWorkspaceFolderIndex(fsPath: string): number {
  const folders = vscode.workspace.workspaceFolders ?? [];
  return folders.findIndex((f) => f.uri.fsPath === fsPath);
}

function addWorkspaceFolder(fsPath: string): void {
  enqueueWorkspaceOp(
    `add ${fsPath}`,
    () => {
      if (findWorkspaceFolderIndex(fsPath) >= 0) {
        return undefined;
      }
      log(`Adding worktree to workspace: ${fsPath}`);
      return vscode.workspace.updateWorkspaceFolders(
        vscode.workspace.workspaceFolders?.length ?? 0,
        0,
        { uri: vscode.Uri.file(fsPath), name: path.basename(fsPath) }
      );
    },
    async () => {
      // The git extension skips repository detection for folders added at
      // runtime when they sit inside an already-open repository (its
      // onDidChangeWorkspaceFolders handler filters them out), which is
      // exactly the layout of a worktree under <repo>/.claude/worktrees.
      // Opening the repository explicitly bypasses that filter; it is a
      // no-op if the repository is already open.
      try {
        await vscode.commands.executeCommand('git.openRepository', fsPath);
      } catch (err) {
        log(`git.openRepository failed for ${fsPath}: ${err}`);
      }
    }
  );
}

function removeWorkspaceFolder(fsPath: string): void {
  enqueueWorkspaceOp(`remove ${fsPath}`, () => {
    const index = findWorkspaceFolderIndex(fsPath);
    if (index < 0) {
      return undefined;
    }
    log(`Removing worktree from workspace: ${fsPath}`);
    return vscode.workspace.updateWorkspaceFolders(index, 1);
  });
}

/**
 * Runs a workspace mutation once prior ones have settled. The operation
 * returns undefined when there is nothing to do, true when the update was
 * accepted (we then wait for it to apply and run onApplied), or false to
 * retry.
 */
function enqueueWorkspaceOp(
  description: string,
  op: () => boolean | undefined,
  onApplied?: () => Promise<void>
): void {
  opQueue = opQueue.then(async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const result = op();
      if (result === undefined) {
        return;
      }
      if (result) {
        await waitForWorkspaceFoldersChange();
        await onApplied?.();
        return;
      }
      await delay(300);
    }
    log(`Giving up on workspace update: ${description}`);
  });
}

function waitForWorkspaceFoldersChange(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      listener.dispose();
      resolve();
    }, 2000);
    const listener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      clearTimeout(timer);
      listener.dispose();
      resolve();
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
