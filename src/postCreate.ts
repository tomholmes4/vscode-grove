import { spawn } from 'child_process';

/** Describes the new worktree to post-create commands, via GROVE_* env vars. */
export interface PostCreateContext {
  worktreePath: string;
  branch: string;
  mainRoot: string;
  /** Set when the branch was created by Grove, off this base. */
  base?: string;
}

/** A command that didn't exit cleanly, and why. */
export interface PostCreateFailure {
  command: string;
  reason: string;
}

/**
 * Runs the user's `grove.postCreateCommands` in order, each through the shell
 * (`/bin/sh`, or cmd.exe on Windows) from the new worktree. Their output goes
 * to the log. A failing command doesn't stop the rest — the worktree is
 * already usable — so failures are returned for the caller to surface rather
 * than thrown.
 */
export async function runPostCreateCommands(
  commands: string[],
  context: PostCreateContext,
  log: (message: string) => void,
  onCommand?: (index: number, command: string) => void
): Promise<PostCreateFailure[]> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GROVE_WORKTREE_PATH: context.worktreePath,
    GROVE_BRANCH: context.branch,
    GROVE_MAIN_ROOT: context.mainRoot,
    ...(context.base ? { GROVE_BASE_BRANCH: context.base } : {}),
  };
  const failures: PostCreateFailure[] = [];
  for (const [index, command] of commands.entries()) {
    onCommand?.(index, command);
    log(`$ ${command}`);
    const reason = await runShell(command, context.worktreePath, env, (line) =>
      log(`  ${line}`)
    );
    if (reason) {
      log(`Post-create command failed (${reason}; continuing): ${command}`);
      failures.push({ command, reason });
    }
  }
  return failures;
}

/** Resolves to undefined on a zero exit, otherwise to why the command failed. */
function runShell(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  onLine: (line: string) => void
): Promise<string | undefined> {
  return new Promise((resolve) => {
    // stdin is closed so a command that prompts fails instead of hanging.
    const child = spawn(command, { cwd, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) {
      let partial = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        const lines = (partial + chunk).split(/\r\n|\n|\r/);
        partial = lines.pop() ?? '';
        lines.filter((line) => line.trim()).forEach(onLine);
      });
      stream.on('end', () => {
        if (partial.trim()) {
          onLine(partial);
        }
      });
    }
    child.on('error', (err) => resolve(err.message));
    child.on('close', (code, signal) =>
      resolve(code === 0 ? undefined : signal ? `killed by ${signal}` : `exit code ${code}`)
    );
  });
}
