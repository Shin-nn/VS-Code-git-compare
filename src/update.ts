import * as vscode from 'vscode';

/**
 * Update check against the GitHub releases of this extension: the latest release's tag (vX.Y.Z) is compared with the
 * installed version and, if newer, its .vsix asset can be downloaded and installed from the notification.
 */

const REPO = 'Shin-nn/vs-code-git-compare';
const LATEST_RELEASE = `https://api.github.com/repos/${REPO}/releases/latest`;
const LAST_CHECK_KEY = 'gitCompare.update.lastCheck';
const SKIPPED_KEY = 'gitCompare.update.skippedVersion';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface Release {
	tag_name: string;
	html_url: string;
	draft: boolean;
	prerelease: boolean;
	assets: { name: string; browser_download_url: string }[];
}

function parseVersion(text: string): number[] | undefined {
	const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
	return m ? m.slice(1, 4).map(Number) : undefined;
}

/** a > b for X.Y.Z versions. */
function isNewer(a: number[], b: number[]): boolean {
	for (let i = 0; i < 3; i++) {
		if (a[i] !== b[i]) {
			return a[i] > b[i];
		}
	}
	return false;
}

async function fetchLatestRelease(): Promise<Release> {
	const res = await fetch(LATEST_RELEASE, {
		headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'vs-code-git-compare' },
		signal: AbortSignal.timeout(15000),
	});
	if (!res.ok) {
		throw new Error(res.status === 404 ? 'no release published yet' : `GitHub answered ${res.status} ${res.statusText}`);
	}
	return (await res.json()) as Release;
}

async function install(context: vscode.ExtensionContext, release: Release, version: string): Promise<void> {
	const asset = release.assets.find((a) => a.name.endsWith('.vsix'));
	if (!asset) {
		throw new Error(`release ${release.tag_name} has no .vsix`);
	}
	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `Git Compare: installing ${version}…` },
		async () => {
			const res = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(120000) });
			if (!res.ok) {
				throw new Error(`download failed: ${res.status} ${res.statusText}`);
			}
			await vscode.workspace.fs.createDirectory(context.globalStorageUri);
			const file = vscode.Uri.joinPath(context.globalStorageUri, asset.name);
			await vscode.workspace.fs.writeFile(file, new Uint8Array(await res.arrayBuffer()));
			try {
				await vscode.commands.executeCommand('workbench.extensions.installExtension', file);
			} finally {
				await vscode.workspace.fs.delete(file).then(undefined, () => undefined);
			}
		},
	);
	const reload = await vscode.window.showInformationMessage(`Git Compare ${version} is installed. Reload to use it.`, 'Reload Window');
	if (reload) {
		await vscode.commands.executeCommand('workbench.action.reloadWindow');
	}
}

/**
 * Check for a newer release. `manual`: asked for by the command, so also report "up to date" and errors, and don't
 * honour a skipped version.
 */
export async function checkForUpdates(context: vscode.ExtensionContext, manual: boolean): Promise<void> {
	const current = parseVersion(String(context.extension.packageJSON.version));
	let release: Release;
	try {
		release = await fetchLatestRelease();
	} catch (err) {
		if (manual) {
			vscode.window.showWarningMessage(`Git Compare: update check failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		return;
	}
	await context.globalState.update(LAST_CHECK_KEY, Date.now());

	const latest = parseVersion(release.tag_name);
	if (!current || !latest || release.draft || release.prerelease || !isNewer(latest, current)) {
		if (manual) {
			vscode.window.showInformationMessage(`Git Compare: ${context.extension.packageJSON.version} is the latest version.`);
		}
		return;
	}
	const version = latest.join('.');
	if (!manual && context.globalState.get<string>(SKIPPED_KEY) === version) {
		return;
	}

	const choice = await vscode.window.showInformationMessage(
		`Git Compare ${version} is available (installed: ${current.join('.')}).`,
		'Install',
		'Release Notes',
		'Skip This Version',
	);
	if (choice === 'Install') {
		try {
			await install(context, release, version);
		} catch (err) {
			const open = await vscode.window.showErrorMessage(
				`Git Compare: update failed: ${err instanceof Error ? err.message : String(err)}`,
				'Open Release Page',
			);
			if (open) {
				vscode.env.openExternal(vscode.Uri.parse(release.html_url));
			}
		}
	} else if (choice === 'Release Notes') {
		vscode.env.openExternal(vscode.Uri.parse(release.html_url));
	} else if (choice === 'Skip This Version') {
		await context.globalState.update(SKIPPED_KEY, version);
	}
}

/** The automatic check at startup: at most once a day, unless gitCompare.checkForUpdates is off. */
export function scheduleUpdateCheck(context: vscode.ExtensionContext): void {
	if (!vscode.workspace.getConfiguration('gitCompare').get<boolean>('checkForUpdates', true)) {
		return;
	}
	const last = context.globalState.get<number>(LAST_CHECK_KEY, 0);
	if (Date.now() - last < CHECK_INTERVAL_MS) {
		return;
	}
	// Not during startup: give the window time to settle.
	const timer = setTimeout(() => checkForUpdates(context, false), 10000);
	context.subscriptions.push({ dispose: () => clearTimeout(timer) });
}
