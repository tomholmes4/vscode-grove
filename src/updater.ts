import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

// Grove is released as a .vsix attached to GitHub releases rather than through
// the Marketplace, so VS Code's own extension auto-update never sees new
// versions. This checks the repository's latest release instead and installs
// its .vsix. The repository is public, so no GitHub sign-in is needed; GitHub
// allows 60 unauthenticated API requests an hour per IP address, far more than
// these checks make.

const CONFIG_SECTION = 'grove';
const SHOW_LOG = 'Show Log';
const RELOAD = 'Reload Window';

const STARTUP_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60_000;
// Every window runs its own timer; a check made recently by any window stands
// in for the rest.
const MIN_CHECK_GAP_MS = 60 * 60_000;

const GITHUB_API_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'grove-vscode',
};

// globalState is shared by every window, which is how they coordinate.
const LAST_CHECK_KEY = 'updater.lastCheck';
const INSTALLED_VERSION_KEY = 'updater.installedVersion';

interface Release {
  tag_name: string;
  assets: { name: string; browser_download_url: string }[];
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
  if (Date.now() - context.globalState.get<number>(LAST_CHECK_KEY, 0) < MIN_CHECK_GAP_MS) {
    return;
  }
  try {
    const result = await enqueue(() => checkForUpdate(context, log));
    if (result.kind === 'installed') {
      promptReload(result.version);
    }
  } catch (err) {
    log(`Update check failed: ${err}`);
  }
}

/** The command's check: always reports the outcome. */
async function checkNow(
  context: vscode.ExtensionContext,
  log: (message: string) => void
): Promise<void> {
  let result: CheckResult;
  try {
    result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Grove: checking for updates…' },
      () => enqueue(() => checkForUpdate(context, log))
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
  log: (message: string) => void
): Promise<CheckResult> {
  await context.globalState.update(LAST_CHECK_KEY, Date.now());
  const repo = githubRepo(context);
  const running: string = context.extension.packageJSON.version;
  const release = await fetchLatestRelease(repo);
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
    await fs.promises.writeFile(file, await downloadAsset(asset.browser_download_url));
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

async function fetchLatestRelease(repo: string): Promise<Release> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: GITHUB_API_HEADERS,
  });
  if (res.status === 404) {
    throw new Error(`no release found in ${repo}`);
  }
  const rateLimited =
    (res.status === 403 || res.status === 429) &&
    res.headers.get('x-ratelimit-remaining') === '0';
  if (rateLimited) {
    throw new Error(
      "GitHub's limit on unauthenticated requests from this network was reached; try again in an hour"
    );
  }
  if (!res.ok) {
    throw new Error(`GitHub returned HTTP ${res.status} for ${repo}'s latest release`);
  }
  return (await res.json()) as Release;
}

async function downloadAsset(url: string): Promise<Buffer> {
  const res = await fetch(url, { headers: { 'User-Agent': GITHUB_API_HEADERS['User-Agent'] } });
  if (!res.ok) {
    throw new Error(`downloading ${url} failed with HTTP ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
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
