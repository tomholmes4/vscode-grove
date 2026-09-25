import { execFile } from 'child_process';
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

export async function addWorktree(
  cwd: string,
  worktreePath: string,
  branch: string
): Promise<void> {
  await execFileAsync('git', ['worktree', 'add', worktreePath, branch], { cwd });
}
