import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Each VS Code window advertises the worktrees it has open by writing a file
// named after its process id. The switcher in another window reads the whole
// directory to learn which worktrees already have a live window, so it can
// decide between focusing an existing window and opening a new one.
//
// An extension host cannot enumerate or query sibling windows, so this
// file-based registry is the only way to share that state. It self-heals:
// entries for dead processes (verified via signal 0) or ones that have stopped
// heartbeating are reaped on read. Registry accuracy is not safety-critical —
// the `code` CLI focuses an already-open folder regardless — so a stale entry
// only ever costs one wrong window action, never data.

const REGISTRY_DIR = path.join(os.tmpdir(), 'grove-windows');
const HEARTBEAT_MS = 30_000;
const STALE_MS = 90_000;

interface RegistryEntry {
  pid: number;
  paths: string[];
  updatedAt: number;
}

let heartbeat: NodeJS.Timeout | undefined;
let ownFile: string | undefined;
let ownPaths: string[] = [];

export function registerWindow(worktreePaths: string[]): void {
  ownPaths = worktreePaths.map(normalize);
  ownFile = path.join(REGISTRY_DIR, `${process.pid}.json`);
  writeOwnEntry();
  if (!heartbeat) {
    heartbeat = setInterval(writeOwnEntry, HEARTBEAT_MS);
  }
}

export function unregisterWindow(): void {
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = undefined;
  }
  if (ownFile) {
    try {
      fs.unlinkSync(ownFile);
    } catch {
      // already gone
    }
    ownFile = undefined;
  }
}

/** Absolute worktree paths that currently have a live window. */
export function getOpenWorktreePaths(): Set<string> {
  const open = new Set<string>();
  let files: string[];
  try {
    files = fs.readdirSync(REGISTRY_DIR);
  } catch {
    return open;
  }
  const now = Date.now();
  for (const file of files) {
    if (!file.endsWith('.json')) {
      continue;
    }
    const full = path.join(REGISTRY_DIR, file);
    let entry: RegistryEntry;
    try {
      entry = JSON.parse(fs.readFileSync(full, 'utf8')) as RegistryEntry;
    } catch {
      continue;
    }
    const fresh = now - (entry.updatedAt ?? 0) < STALE_MS;
    if (!fresh || !isAlive(entry.pid)) {
      // Reap dead/stale windows so the registry converges without a sweeper.
      try {
        fs.unlinkSync(full);
      } catch {
        // another window may have reaped it first
      }
      continue;
    }
    for (const p of entry.paths ?? []) {
      open.add(p);
    }
  }
  return open;
}

export function normalize(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function writeOwnEntry(): void {
  if (!ownFile) {
    return;
  }
  const entry: RegistryEntry = {
    pid: process.pid,
    paths: ownPaths,
    updatedAt: Date.now(),
  };
  try {
    fs.mkdirSync(REGISTRY_DIR, { recursive: true });
    // Write-then-rename so a concurrent reader never sees a half-written file.
    const tmp = `${ownFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entry));
    fs.renameSync(tmp, ownFile);
  } catch {
    // best effort; a missed heartbeat is recoverable
  }
}

function isAlive(pid: number): boolean {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is owned by someone else (shouldn't
    // happen for same-user windows) — treat as alive. ESRCH means it's gone.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
