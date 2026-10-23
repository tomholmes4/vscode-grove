<p align="center"><img src="icon.png" alt="Grove" width="240"></p>

# Grove

Watches one or more directories for new git worktrees and keeps them in sync with your workspace:

- When a new folder appears in a watched directory and it is a linked git worktree (its `.git` is a file pointing into the parent repo's `.git/worktrees/`), it is added to the workspace automatically — but only if the repository it belongs to is currently open in the workspace.
- When the worktree folder is deleted (e.g. `git worktree remove`), or its repository is closed, it is removed from the workspace.
- On startup, when workspace folders change, and via the **Grove: Scan Now** command, existing worktrees in watched directories are (re)synced against the open repositories.

## Switch Worktree

The **Grove: Switch Worktree** command (`cmd+alt+w` / `ctrl+alt+w`) opens a picker of the git repository's worktrees plus any Graphite-tracked branches that don't have a worktree yet:

- Selecting **New Branch** prompts for a task description, formats it into a Graphite-style branch name (`MM-DD-<slug>`, mirroring `gt branch create`, honouring your Graphite `user_config`), creates that branch off `master` (configurable via `grove.newBranchBase`) in a new worktree, marks it tracked with `gt track --parent <base>`, then opens it in a new window.
- Selecting a worktree that already has an open window **focuses that window** (via the `code` CLI, which raises an already-open folder — the extension API can't).
- Selecting a worktree with no open window **opens it in a new window** (`code -n`).
- Selecting a Graphite branch **creates a worktree** for it (`git worktree add`) under the configured base directory, then opens it in a new window.

While a worktree is being created, a notification walks through each step (`2/6 Tracking with Graphite`, …) with a progress bar and a per-step timer. The checkout shows files written out of the total, parsed from git's own `Updating files` progress, and the `node_modules` clone shows which folder it is on. If a step fails, the error names it and quotes git's message. **Show Log** (or **Grove: Show Log**) opens the output channel, which also records how long each step took.

To know which worktrees already have a window, each window records the worktrees it has open in a small registry under the OS temp directory (`grove-windows/<pid>.json`), heartbeated while the window lives and reaped when the process dies. If the registry is momentarily wrong, the `code` CLI's own de-duplication still focuses an already-open folder, so the worst case is one wrong window action, never lost work.

Graphite branches are listed by running `gt ls` and parsing its output. Graphite's on-disk cache (`.graphite_cache_persist`) and its `refs/branch-metadata/*` refs both go stale, so only `gt` itself reflects the live stack.

When creating a worktree, the extension also pins `NX_WORKSPACE_ROOT_PATH` to the new worktree in its `.vscode/settings.json` (under `terminal.integrated.env.<platform>`). Nx Console exports that variable globally and it leaks into every window's integrated terminals; with worktrees nested under the repo it points at the main checkout, so `nx` runs against the wrong root. The per-worktree workspace setting overrides the leaked value. Existing settings are merged, not overwritten.

Because `.vscode/settings.json` is usually a tracked, shared file, the pin would otherwise show up as a local modification. The extension marks it `git update-index --skip-worktree` in the new worktree afterwards, so git ignores the edit in that worktree's index while leaving the committed file and the main checkout untouched.

Anything else a new worktree needs, such as `mise trust` or a codegen step, goes in `grove.postCreateCommands`, which defaults to `["mise trust"]`. Those commands run in order after the built-in setup and before the window opens. Each one runs through `/bin/sh` from the new worktree, with these variables set:

| Variable | Value |
| --- | --- |
| `GROVE_WORKTREE_PATH` | the new worktree (also the working directory) |
| `GROVE_BRANCH` | its branch |
| `GROVE_MAIN_ROOT` | the main checkout |
| `GROVE_BASE_BRANCH` | the base, for branches made with **New Branch** only |

Output goes to the Grove log. stdin is closed, so a command that prompts fails instead of hanging. A failing command shows a warning but doesn't stop the commands after it, or the window from opening.

## Updates

Grove is released as a `.vsix` on the repository's GitHub releases rather than on the Marketplace, so VS Code's own extension auto-update never sees it. Instead, Grove checks the latest GitHub release itself: 15 seconds after a window opens and every 6 hours after that, skipping a check when any window has checked within the last hour. If the release is newer than the installed version, Grove downloads its `.vsix`, installs it, and offers **Reload Window** to start using it. `grove.autoUpdate` turns this off; **Grove: Check for Updates** checks on demand either way and reports what it found.

The repository is public, so checking and downloading need no GitHub sign-in.

## Configuration

```jsonc
{
  // Directories whose direct children are checked for worktrees.
  // Absolute paths; ~ is expanded.
  "grove.directories": [
    "~/code/core/.claude/worktrees"
  ],

  // Start point for branches created by the "New Branch" action.
  // Defaults to "master".
  "grove.newBranchBase": "master",

  // Shell commands run in each newly created worktree, in order.
  // Defaults to ["mise trust"]; set [] to run nothing.
  "grove.postCreateCommands": [
    "mise trust"
  ],

  // Install new GitHub releases of Grove automatically. Defaults to true.
  "grove.autoUpdate": true
}
```

Only direct children of the configured directories are considered; the watch is not recursive.

## Development

```sh
npm install
npm run compile
```

Then press F5 in VS Code to launch an Extension Development Host, or package with `npx vsce package` and install the `.vsix` via **Extensions: Install from VSIX…**.

`npm run release` packages the version in `package.json` and publishes it as a GitHub release, which installed copies then pick up through the update check.

## Notes

- `git worktree add` creates the folder before it is fully initialized, so the extension polls a new folder for up to 15 seconds waiting for it to become a worktree.
- Folders are only removed from the workspace if they sit directly inside a watched directory and have disappeared from disk (or their repo was closed) — manually added, unrelated workspace folders are never touched.
- "Repository is open" means a workspace folder is the repo root or a directory inside it. Workspace folders that are themselves worktrees don't count, so opening one worktree doesn't pull in its siblings.
