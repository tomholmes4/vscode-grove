import { execFile, spawn } from 'child_process';
import { existsSync, promises as fsp } from 'fs';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface Worktree {
  path: string;
  head?: string;
  branch?: string;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
}

export interface RepoContext {
  /** Working directory the repo was resolved from. */
  cwd: string;
  /** The main (non-linked) worktree root — where new worktrees are anchored. */
  mainRoot: string;
  /** Shared git directory, e.g. <mainRoot>/.git. */
  commonDir: string;
}

/**
 * Resolves the repository for a directory, including the main worktree root and
 * the shared git directory. Returns undefined when cwd is not inside a repo.
 */
export async function resolveRepo(cwd: string): Promise<RepoContext | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd }
    );
    const commonDir = stdout.trim();
    // The common dir is <mainRoot>/.git for a normal repo; its parent is the
    // main worktree that owns every linked worktree.
    const mainRoot =
      path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir;
    return { cwd, mainRoot, commonDir };
  } catch {
    return undefined;
  }
}

export async function listWorktrees(cwd: string): Promise<Worktree[]> {
  const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return parseWorktrees(stdout);
}

/** Parses `git worktree list --porcelain` output into structured records. */
export function parseWorktrees(out: string): Worktree[] {
  const trees: Worktree[] = [];
  let current: Worktree | undefined;
  const flush = () => {
    if (current) {
      trees.push(current);
      current = undefined;
    }
  };
  for (const raw of out.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line === '') {
      flush();
      continue;
    }
    const space = line.indexOf(' ');
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? '' : line.slice(space + 1);
    switch (key) {
      case 'worktree':
        flush();
        current = {
          path: value,
          detached: false,
          bare: false,
          locked: false,
          prunable: false,
        };
        break;
      case 'HEAD':
        if (current) current.head = value;
        break;
      case 'branch':
        if (current) current.branch = value.replace(/^refs\/heads\//, '');
        break;
      case 'detached':
        if (current) current.detached = true;
        break;
      case 'bare':
        if (current) current.bare = true;
        break;
      case 'locked':
        if (current) current.locked = true;
        break;
      case 'prunable':
        if (current) current.prunable = true;
        break;
    }
  }
  flush();
  return trees;
}

/**
 * Graphite-tracked branch names, obtained by running `gt ls`. Graphite's
 * on-disk cache (`.graphite_cache_persist`) and its `refs/branch-metadata/*`
 * refs both go stale — only invoking `gt` reflects the live stack — so we parse
 * its output despite that being less structured than a file read.
 */
export async function listGraphiteBranches(cwd: string): Promise<string[]> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('gt', ['ls', '--no-interactive'], {
      cwd,
      // NO_COLOR drops the ANSI styling; the tree glyphs still need stripping.
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      maxBuffer: 10 * 1024 * 1024,
    }));
  } catch {
    return [];
  }
  return parseGraphiteBranches(stdout);
}

/**
 * Extracts branch names from `gt ls` output. Each line is a stack graph row:
 * ANSI styling, then tree glyphs (│ ◯ ◉ ─ ┴ ┘ …), then the branch name, then
 * optional ` (needs restack)` / ` (<worktree-name>)` annotations. The branch
 * is the first whitespace token that starts with an alphanumeric.
 */
export function parseGraphiteBranches(out: string): string[] {
  const branches: string[] = [];
  for (const raw of out.split('\n')) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
    for (const token of line.split(/\s+/)) {
      if (/^[A-Za-z0-9][\w./-]*$/.test(token)) {
        branches.push(token);
        break;
      }
    }
  }
  return branches;
}

/** Reports checkout progress as files written so far out of the total. */
export type CheckoutProgress = (done: number, total: number) => void;

// During checkout git rewrites a `Updating files:  45% (2034/4500)` line on
// stderr (via \r). It does so even when stderr is a pipe, once the checkout has
// run for ~2s, so short checkouts report nothing.
const CHECKOUT_PROGRESS = /Updating files:\s+\d+% \((\d+)\/(\d+)\)/;

export async function addWorktree(
  cwd: string,
  worktreePath: string,
  branch: string,
  onProgress?: CheckoutProgress
): Promise<void> {
  await runWorktreeAdd(cwd, [worktreePath, branch], onProgress);
}

/**
 * Creates a new branch at `base` and checks it out in a new worktree, in one
 * step (`git worktree add -b <branch> <path> <base>`). Fails if the branch or
 * the path already exists.
 */
export async function addWorktreeNewBranch(
  cwd: string,
  worktreePath: string,
  branch: string,
  base: string,
  onProgress?: CheckoutProgress
): Promise<void> {
  await runWorktreeAdd(cwd, ['-b', branch, worktreePath, base], onProgress);
}

/**
 * Runs `git worktree add <args>`, streaming stderr so checkout progress can be
 * forwarded as it happens. On failure, rejects with git's own error line (e.g.
 * `fatal: invalid reference: master`) rather than execFile's echo of the whole
 * command line.
 */
function runWorktreeAdd(
  cwd: string,
  args: string[],
  onProgress?: CheckoutProgress
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['worktree', 'add', ...args], {
      cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const lines: string[] = [];
    let partial = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const parts = (partial + chunk).split(/[\r\n]/);
      partial = parts.pop() ?? '';
      for (const line of parts) {
        const match = CHECKOUT_PROGRESS.exec(line);
        if (match) {
          onProgress?.(Number(match[1]), Number(match[2]));
        } else if (line.trim()) {
          lines.push(line.trim());
        }
      }
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      if (partial.trim()) {
        lines.push(partial.trim());
      }
      const message =
        [...lines].reverse().find((line) => /^(fatal|error):/.test(line)) ??
        lines[lines.length - 1] ??
        `git worktree add exited with ${signal ?? `code ${code}`}`;
      reject(new Error(message));
    });
  });
}

/**
 * Registers `branch` with Graphite, parented on `parent`
 * (`gt track <branch> --parent <parent>`). The branch is named explicitly rather
 * than inferred from the worktree's HEAD. Run from the worktree that has it
 * checked out. Non-fatal: a freshly created worktree is still usable if
 * tracking fails, so this returns false instead of throwing.
 */
export async function graphiteTrack(
  worktreePath: string,
  branch: string,
  parent: string,
  log: (message: string) => void
): Promise<boolean> {
  try {
    log(`Tracking ${branch} with Graphite (parent ${parent})`);
    await execFileAsync(
      'gt',
      ['track', branch, '--parent', parent, '--no-interactive'],
      {
        cwd: worktreePath,
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      }
    );
    return true;
  } catch (err) {
    log(`gt track failed (continuing): ${err}`);
    return false;
  }
}

/**
 * Mirrors the repo's WorktreeCreate hook and the `gt-wt` CLI: copy-on-write
 * clone (APFS clonefile via `cp -c`) of every node_modules folder plus .env
 * files from the source checkout, so a freshly created worktree is usable
 * without an `npm ci`. Uses the same find/cp flags as gt-wt. Clone failures are
 * non-fatal — the worktree still works, just without dependencies.
 */
export async function cloneWorktreeDependencies(
  sourceRoot: string,
  worktreePath: string,
  log: (message: string) => void,
  // Called before each folder is cloned (with its path), then once at the end.
  onProgress?: (done: number, total: number, current?: string) => void
): Promise<void> {
  let found = '';
  try {
    ({ stdout: found } = await execFileAsync(
      'find',
      [
        '.',
        '-type', 'd',
        '-name', 'node_modules',
        '-prune',
        '-not', '-path', './.claude/*',
        '-not', '-path', './.git/*',
        '-print',
      ],
      { cwd: sourceRoot, maxBuffer: 10 * 1024 * 1024 }
    ));
  } catch {
    log('Unable to locate node_modules folders; continuing without clone.');
  }

  // Only clone where the worktree already has the parent dir and no copy yet.
  const targets = found
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((rel) => {
      const dest = path.join(worktreePath, rel);
      return existsSync(path.dirname(dest)) && !existsSync(dest);
    });
  for (const [index, rel] of targets.entries()) {
    onProgress?.(index, targets.length, rel);
    log(`Cloning ${rel}`);
    try {
      await execFileAsync('cp', ['-cR', path.join(sourceRoot, rel), path.join(worktreePath, rel)]);
    } catch {
      log(`Clone failed for ${rel} (continuing)`);
    }
  }
  onProgress?.(targets.length, targets.length);

  for (const file of ['.env', '.env.local']) {
    const src = path.join(sourceRoot, file);
    if (existsSync(src)) {
      try {
        await execFileAsync('cp', ['-c', src, path.join(worktreePath, file)]);
      } catch {
        // non-fatal
      }
    }
  }
}

/**
 * Pins Nx's workspace root for terminals opened in the worktree window.
 *
 * Nx Console (the VS Code extension) exports a global `NX_WORKSPACE_ROOT_PATH`
 * that leaks into the integrated terminals of every window; with worktrees
 * nested under the repo it points at the main checkout, so `nx` runs against the
 * wrong root. Setting `terminal.integrated.env.<platform>` in the worktree's
 * workspace settings overrides that inherited value for its own terminals.
 *
 * Merges into any existing `.vscode/settings.json` so the committed PATH entry
 * (and other settings) survive. Non-fatal: a parse failure leaves the file
 * untouched rather than clobbering hand-written config.
 */
export async function pinNxWorkspaceRoot(
  worktreePath: string,
  log: (message: string) => void
): Promise<void> {
  const vscodeDir = path.join(worktreePath, '.vscode');
  const settingsPath = path.join(vscodeDir, 'settings.json');
  const envKey =
    process.platform === 'darwin'
      ? 'terminal.integrated.env.osx'
      : process.platform === 'win32'
        ? 'terminal.integrated.env.windows'
        : 'terminal.integrated.env.linux';

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(await fsp.readFile(settingsPath, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        settings = parsed as Record<string, unknown>;
      }
    } catch (err) {
      log(`Skipping Nx root pin: ${settingsPath} is not plain JSON (${err}).`);
      return;
    }
  }

  const existingEnv = settings[envKey];
  const env: Record<string, unknown> =
    existingEnv && typeof existingEnv === 'object'
      ? { ...(existingEnv as Record<string, unknown>) }
      : {};
  if (env.NX_WORKSPACE_ROOT_PATH === worktreePath) {
    return;
  }
  env.NX_WORKSPACE_ROOT_PATH = worktreePath;
  settings[envKey] = env;

  try {
    await fsp.mkdir(vscodeDir, { recursive: true });
    await fsp.writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    log(`Pinned NX_WORKSPACE_ROOT_PATH in ${settingsPath}`);
  } catch (err) {
    log(`Failed to pin Nx workspace root (continuing): ${err}`);
    return;
  }

  // settings.json is a tracked, shared file, so the pin would otherwise show as a
  // local modification in every worktree. skip-worktree makes git ignore our edit
  // in this worktree's index (its own index, so the main checkout is untouched)
  // without reverting the committed file. No-op if the file isn't tracked here.
  try {
    await execFileAsync(
      'git',
      ['update-index', '--skip-worktree', path.join('.vscode', 'settings.json')],
      { cwd: worktreePath }
    );
    log('Marked .vscode/settings.json skip-worktree');
  } catch (err) {
    log(`Could not skip-worktree .vscode/settings.json (continuing): ${err}`);
  }
}
