import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

// Grove is released as a .vsix attached to GitHub releases rather than through
// the Marketplace, so VS Code's own extension auto-update never sees new
// versions. This checks the repository's latest release instead and installs
// its .vsix. The repository is private, so requests are made as the GitHub
// account the user is signed in to in VS Code.

const CONFIG_SECTION = 'grove';
const SHOW_LOG = 'Show Log';
const RELOAD = 'Reload Window';

const STARTUP_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60_000;
// Every window runs its own timer; a check made recently by any window stands
// in for the rest.
const MIN_CHECK_GAP_MS = 60 * 60_000;

// Reading a private repository's releases needs the `repo` scope; GitHub
// OAuth apps have no read-only equivalent.
const GITHUB_SCOPES = ['repo'];

// globalState is shared by every window, which is how they coordinate.
const LAST_CHECK_KEY = 'updater.lastCheck';
const INSTALLED_VERSION_KEY = 'updater.installedVersion';

interface Release {
  tag_name: string;
  assets: { name: string; url: string }[];
}

type CheckResult =
  | { kind: 'up-to-date'; version: string }
  /** Installed by this window just now. */
  | { kind: 'installed'; version: string }
  /** Installed earlier, possibly by another window, but not yet running here. */
  | { kind: 'pending-reload'; version: string };

// The timer and the command can overlap, so checks run one at a time; a check
// queued behind an install sees it and doesn't install again.
let queue: Promise<unknown> = Promise.resolve();

export function registerUpdater(
  context: vscode.ExtensionContext,
  log: (message: string) => void
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('grove.checkForUpdates', () => checkNow(context, log))
  );

  // A recorded install has taken effect once a window runs it. Left in place,
  // it would make a later release of the same version, after a manual
  // downgrade, look installed already.
  const installed = context.globalState.get<string>(INSTALLED_VERSION_KEY);
  if (installed && compareVersions(context.extension.packageJSON.version, installed) >= 0) {
    void context.globalState.update(INSTALLED_VERSION_KEY, undefined);
  }

  // A development host runs the extension from source; installing a release
  // over it would only confuse things.
  if (context.extensionMode !== vscode.ExtensionMode.Production) {
    return;
  }
  const startup = setTimeout(() => checkInBackground(context, log), STARTUP_DELAY_MS);
  const interval = setInterval(() => checkInBackground(context, log), CHECK_INTERVAL_MS);
  context.subscriptions.push(
    new vscode.Disposable(() => {
      clearTimeout(startup);
      clearInterval(interval);
    }),
    // Signing in from the Accounts menu shouldn't have to wait for the next
    // timer. Every window hears the event; only the one in use acts on it.
    vscode.authentication.onDidChangeSessions((e) => {
      if (e.provider.id === 'github' && vscode.window.state.focused) {
        void checkInBackground(context, log);
      }
    })
  );
}

/** The timer's check: silent unless an update gets installed. */
async function checkInBackground(
  context: vscode.ExtensionContext,
  log: (message: string) => void
): Promise<void> {
  if (!vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>('autoUpdate', true)) {
    return;
  }
  try {
    // Without createIfNone, a missing sign-in becomes a request in the
    // Accounts menu rather than a dialog.
    const session = await vscode.authentication.getSession('github', GITHUB_SCOPES);
    if (!session) {
      log('Skipping update check: not signed in to GitHub (see the Accounts menu)');
      return;
    }
    if (Date.now() - context.globalState.get<number>(LAST_CHECK_KEY, 0) < MIN_CHECK_GAP_MS) {
      return;
    }
    const result = await enqueue(() => checkForUpdate(context, session.accessToken, log));
    if (result.kind === 'installed') {
      promptReload(result.version);
    }
  } catch (err) {
    log(`Update check failed: ${err}`);
  }
}

/** The command's check: signs in if needed and always reports the outcome. */
async function checkNow(
  context: vscode.ExtensionContext,
  log: (message: string) => void
): Promise<void> {
  let session: vscode.AuthenticationSession;
  try {
    session = await vscode.authentication.getSession('github', GITHUB_SCOPES, {
      createIfNone: true,
    });
  } catch (err) {
    // Declining the sign-in rejects.
    log(`GitHub sign-in for the update check failed: ${err}`);
    vscode.window.showWarningMessage('Grove: checking for updates needs a GitHub sign-in.');
    return;
  }
  let result: CheckResult;
  try {
    result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Grove: checking for updates…' },
      () => enqueue(() => checkForUpdate(context, session.accessToken, log))
    );
  } catch (err) {
    log(`Update check failed: ${err}`);
    const choice = await vscode.window.showErrorMessage(
      `Grove: update check failed: ${err}`,
      SHOW_LOG
    );
    if (choice === SHOW_LOG) {
      void vscode.commands.executeCommand('grove.showLog');
    }
    return;
  }
  if (result.kind === 'up-to-date') {
    vscode.window.showInformationMessage(`Grove is up to date (${result.version}).`);
  } else {
    promptReload(result.version);
  }
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task);
  queue = result.catch(() => undefined);
  return result;
}

/** Installs the latest release's .vsix when it is newer than what's installed. */
async function checkForUpdate(
  context: vscode.ExtensionContext,
  token: string,
  log: (message: string) => void
): Promise<CheckResult> {
  await context.globalState.update(LAST_CHECK_KEY, Date.now());
  const repo = githubRepo(context);
  const running: string = context.extension.packageJSON.version;
  const release = await fetchLatestRelease(repo, token);
  const latest = release.tag_name.replace(/^v/, '');
  log(`Update check: running ${running}, latest release ${latest}`);
  if (compareVersions(latest, running) <= 0) {
    return { kind: 'up-to-date', version: running };
  }
  const installed = context.globalState.get<string>(INSTALLED_VERSION_KEY);
  if (installed && compareVersions(latest, installed) <= 0) {
    return { kind: 'pending-reload', version: installed };
  }

  const asset = release.assets.find((a) => a.name.endsWith('.vsix'));
  if (!asset) {
    throw new Error(`release ${release.tag_name} has no .vsix attached`);
  }
  log(`Downloading ${asset.name}`);
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'grove-update-'));
  try {
    const file = path.join(dir, asset.name);
    await fs.promises.writeFile(file, await downloadAsset(asset.url, token));
    await vscode.commands.executeCommand(
      'workbench.extensions.installExtension',
      vscode.Uri.file(file)
    );
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
  await context.globalState.update(INSTALLED_VERSION_KEY, latest);
  log(`Installed Grove ${latest}; it runs after a window reload`);
  return { kind: 'installed', version: latest };
}

function promptReload(version: string): void {
  void vscode.window
    .showInformationMessage(
      `Grove ${version} is installed. Reload the window to start using it.`,
      RELOAD
    )
    .then((choice) => {
      if (choice === RELOAD) {
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    });
}

/** `owner/name` of the GitHub repository in package.json's `repository.url`. */
function githubRepo(context: vscode.ExtensionContext): string {
  const url: string | undefined = context.extension.packageJSON.repository?.url;
  const match = url ? /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url) : null;
  if (!match) {
    throw new Error(`package.json's repository (${url}) isn't a GitHub repository`);
  }
  return match[1];
}

async function fetchLatestRelease(repo: string, token: string): Promise<Release> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: githubHeaders(token, 'application/vnd.github+json'),
  });
  if (res.status === 404) {
    // GitHub answers 404, not 403, for a private repository the account can't see.
    throw new Error(`no release found in ${repo}, or the signed-in GitHub account can't access it`);
  }
  if (!res.ok) {
    throw new Error(`GitHub returned HTTP ${res.status} for ${repo}'s latest release`);
  }
  return (await res.json()) as Release;
}

/**
 * Downloads a release asset through the API, which redirects to a signed URL
 * on another host. That URL needs no credentials and mustn't be sent the
 * token, so the redirect is followed by hand without it.
 */
async function downloadAsset(url: string, token: string): Promise<Buffer> {
  let res = await fetch(url, {
    headers: githubHeaders(token, 'application/octet-stream'),
    redirect: 'manual',
  });
  const location = res.headers.get('location');
  if (res.status >= 300 && res.status < 400 && location) {
    res = await fetch(location);
  }
  if (!res.ok) {
    throw new Error(`downloading the release asset failed with HTTP ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

function githubHeaders(token: string, accept: string): Record<string, string> {
  return {
    Accept: accept,
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'grove-vscode',
  };
}

/** Compares dotted versions such as 0.0.6 numerically; negative when a < b. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (parseInt(pa[i] ?? '0', 10) || 0) - (parseInt(pb[i] ?? '0', 10) || 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}
