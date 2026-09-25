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
