# Worktree Watcher

Watches one or more directories for new git worktrees and keeps them in sync with your workspace:

- When a new folder appears in a watched directory and it is a linked git worktree (its `.git` is a file pointing into the parent repo's `.git/worktrees/`), it is added to the workspace automatically — but only if the repository it belongs to is currently open in the workspace.
- When the worktree folder is deleted (e.g. `git worktree remove`), or its repository is closed, it is removed from the workspace.
- On startup, when workspace folders change, and via the **Worktree Watcher: Scan Now** command, existing worktrees in watched directories are (re)synced against the open repositories.

## Configuration

```jsonc
{
  // Directories whose direct children are checked for worktrees.
  // Absolute paths; ~ is expanded.
  "worktreeWatcher.directories": [
    "~/code/core/.claude/worktrees"
  ]
}
```

Only direct children of the configured directories are considered; the watch is not recursive.

## Development

```sh
npm install
npm run compile
```

Then press F5 in VS Code to launch an Extension Development Host, or package with `npx vsce package` and install the `.vsix` via **Extensions: Install from VSIX…**.

## Notes

- `git worktree add` creates the folder before it is fully initialized, so the extension polls a new folder for up to 15 seconds waiting for it to become a worktree.
- Folders are only removed from the workspace if they sit directly inside a watched directory and have disappeared from disk (or their repo was closed) — manually added, unrelated workspace folders are never touched.
- "Repository is open" means a workspace folder is the repo root or a directory inside it. Workspace folders that are themselves worktrees don't count, so opening one worktree doesn't pull in its siblings.
