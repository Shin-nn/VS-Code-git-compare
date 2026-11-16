import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CommitContentProvider, CONTENT_SCHEME, commitFileUri, emptyFileUri, StatusDecorationProvider } from './content';
import { CompareBase, CompareProvider, FileNode, GroupId, Node, Session, sessionTitle } from './compareView';
import { Change, prefixOf, repoRootOf, resolveCommit } from './git';
import { pickRef } from './refPicker';
import { checkForUpdates, scheduleUpdateCheck } from './update';

const STATE_KEY = 'gitCompare.base';

type Layout = 'keep' | 'inline' | 'sideBySide';

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------- diff layout

function isSideBySide(): boolean {
	return vscode.workspace.getConfiguration('diffEditor').get<boolean>('renderSideBySide', true);
}

/** Set a diffEditor.* setting where it is set (workspace, else user), if it differs. */
async function setDiffEditorOption(key: string, value: boolean, defaultValue: boolean): Promise<void> {
	const config = vscode.workspace.getConfiguration('diffEditor');
	if (config.get<boolean>(key, defaultValue) === value) {
		return;
	}
	const inspected = config.inspect<boolean>(key);
	const target = inspected?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
	await config.update(key, value, target);
}

/**
 * Switch diffEditor.renderSideBySide (what VS Code's own "Toggle Inline View" does). For side by side also turn off
 * diffEditor.useInlineViewWhenSpaceIsLimited: otherwise an editor narrower than ~900 px stays inline anyway.
 */
async function applyLayout(layout: Layout): Promise<void> {
	if (layout === 'keep') {
		return;
	}
	const sideBySide = layout === 'sideBySide';
	if (sideBySide && vscode.workspace.getConfiguration('gitCompare').get<boolean>('forceSideBySide', true)) {
		await setDiffEditorOption('useInlineViewWhenSpaceIsLimited', false, true);
	}
	await setDiffEditorOption('renderSideBySide', sideBySide, true);
}

function configuredLayout(): Layout {
	return vscode.workspace.getConfiguration('gitCompare').get<Layout>('diffLayout', 'keep');
}

// ---------------------------------------------------------------- opening diffs

interface DiffSides {
	left: vscode.Uri;
	right: vscode.Uri;
	title: string;
	/** The file in the working tree (for "Open File" and for the multi-diff's row). */
	file: vscode.Uri;
}

function sidesOf(session: Session, change: Change): DiffSides {
	const file = vscode.Uri.joinPath(vscode.Uri.file(session.root), change.path);
	const added = change.status === 'A' || change.status === '?';
	const left = added ? emptyFileUri(change.path) : commitFileUri(session.root, session.resolved.commit, change.oldPath ?? change.path);
	const right = change.status === 'D' ? emptyFileUri(change.path) : file;
	const name = path.posix.basename(change.path);
	const shown = change.oldPath ? `${path.posix.basename(change.oldPath)} → ${name}` : name;
	return { left, right, file, title: `${shown} (${session.label} ${session.resolved.short} ↔ Working Tree)` };
}

async function openDiff(sides: DiffSides, layout: Layout, preview: boolean): Promise<void> {
	await applyLayout(layout);
	await vscode.commands.executeCommand('vscode.diff', sides.left, sides.right, sides.title, { preview });
}

// ---------------------------------------------------------------- repositories

interface GitExtensionApi {
	repositories: { rootUri: vscode.Uri }[];
}

async function knownRepositories(): Promise<string[]> {
	const roots = new Set<string>();
	try {
		const ext = vscode.extensions.getExtension<{ getAPI(version: 1): GitExtensionApi }>('vscode.git');
		if (ext) {
			const exports = ext.isActive ? ext.exports : await ext.activate();
			for (const repo of exports.getAPI(1).repositories) {
				roots.add(repo.rootUri.fsPath);
			}
		}
	} catch {
		// the git extension is disabled: fall back to the workspace folders
	}
	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		const root = await repoRootOf(folder.uri.fsPath);
		if (root) {
			roots.add(root);
		}
	}
	return [...roots];
}

async function activeRepository(): Promise<string | undefined> {
	const uri = vscode.window.activeTextEditor?.document.uri;
	return uri?.scheme === 'file' ? repoRootOf(path.dirname(uri.fsPath)) : undefined;
}

async function pickRepository(): Promise<string | undefined> {
	const [roots, active] = await Promise.all([knownRepositories(), activeRepository()]);
	if (active && !roots.includes(active)) {
		roots.unshift(active);
	}
	if (roots.length === 0) {
		vscode.window.showErrorMessage('Git Compare: no git repository in this workspace.');
		return undefined;
	}
	if (roots.length === 1) {
		return roots[0];
	}
	roots.sort((a, b) => (a === active ? -1 : b === active ? 1 : a.localeCompare(b)));
	const picked = await vscode.window.showQuickPick(
		roots.map((root) => ({ label: `$(repo) ${path.basename(root)}`, description: root, root })),
		{ title: 'Git Compare: Repository', placeHolder: 'Which repository?' },
	);
	return picked?.root;
}

/** Repository root and the path relative to it of a file or folder. */
async function locate(uri: vscode.Uri): Promise<{ root: string; relPath: string; isDir: boolean } | undefined> {
	let isDir = false;
	try {
		isDir = fs.statSync(uri.fsPath).isDirectory();
	} catch {
		// deleted file: treat as a file
	}
	const dir = isDir ? uri.fsPath : path.dirname(uri.fsPath);
	const root = await repoRootOf(dir);
	if (!root) {
		return undefined;
	}
	const prefix = await prefixOf(dir);
	const relPath = isDir ? prefix.replace(/\/$/, '') : prefix + path.basename(uri.fsPath);
	return { root, relPath, isDir };
}

// ---------------------------------------------------------------- activation

export function activate(context: vscode.ExtensionContext): void {
	const provider = new CompareProvider();
	const view = vscode.window.createTreeView('gitCompare.view', { treeDataProvider: provider, showCollapseAll: true });
	provider.view = view;

	const setContext = (key: string, value: unknown) => vscode.commands.executeCommand('setContext', key, value);
	const syncLayoutContext = () => setContext('gitCompare.sideBySide', isSideBySide());
	const syncTreeContext = () => setContext('gitCompare.viewAsTree', vscode.workspace.getConfiguration('gitCompare').get<boolean>('viewAsTree', true));
	syncLayoutContext();
	syncTreeContext();
	setContext('gitCompare.active', false);

	// Refresh on changes in the repository (debounced: a build touches many files).
	let watcher: vscode.FileSystemWatcher | undefined;
	let timer: NodeJS.Timeout | undefined;
	const scheduleRefresh = () => {
		if (!vscode.workspace.getConfiguration('gitCompare').get<boolean>('autoRefresh', true)) {
			return;
		}
		if (timer) {
			clearTimeout(timer);
		}
		timer = setTimeout(() => {
			timer = undefined;
			provider.refresh();
		}, 1000);
	};
	const watch = (session: Session | undefined) => {
		watcher?.dispose();
		watcher = undefined;
		if (session) {
			watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(session.root), '**/*'));
			watcher.onDidChange(scheduleRefresh);
			watcher.onDidCreate(scheduleRefresh);
			watcher.onDidDelete(scheduleRefresh);
		}
	};

	let watchedRoot: string | undefined;
	provider.onDidChangeSession((session) => {
		setContext('gitCompare.active', !!session);
		if (session?.root !== watchedRoot) {
			watchedRoot = session?.root;
			watch(session);
		}
		const base: CompareBase | undefined = session && {
			root: session.root,
			rev: session.rev,
			label: session.label,
			mergeBase: session.mergeBase,
			pathspec: session.pathspec,
		};
		context.workspaceState.update(STATE_KEY, base);
	});

	const start = async (base: CompareBase) => {
		try {
			await provider.start(base);
			await vscode.commands.executeCommand('gitCompare.view.focus');
		} catch (err) {
			vscode.window.showErrorMessage(`Git Compare: ${errorText(err)}`);
		}
	};

	const compareRepository = async (useMergeBase: boolean) => {
		const root = await pickRepository();
		if (!root) {
			return;
		}
		const title = useMergeBase ? 'Compare with the Merge Base of HEAD and…' : 'Compare Working Tree with…';
		const ref = await pickRef(root, title);
		if (ref) {
			await start({ root, rev: ref.rev, label: ref.label, mergeBase: useMergeBase, pathspec: [] });
		}
	};

	const fileNodeOf = (arg: unknown): FileNode | undefined => {
		const node = arg as Node | undefined;
		if (node?.kind === 'file') {
			return node;
		}
		const selected = view.selection.find((n) => n.kind === 'file');
		return selected as FileNode | undefined;
	};

	const openNode = async (arg: unknown, layout: Layout) => {
		const node = fileNodeOf(arg);
		const session = provider.session;
		if (!node || !session) {
			return;
		}
		const preview = layout === configuredLayout() && vscode.workspace.getConfiguration('gitCompare').get<boolean>('previewEditors', true);
		await openDiff(sidesOf(session, node.change), layout, preview);
	};

	context.subscriptions.push(
		provider,
		view,
		{ dispose: () => watcher?.dispose() },
		{ dispose: () => timer && clearTimeout(timer) },
		vscode.workspace.registerTextDocumentContentProvider(CONTENT_SCHEME, new CommitContentProvider()),
		vscode.window.registerFileDecorationProvider(new StatusDecorationProvider()),

		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('diffEditor.renderSideBySide')) {
				syncLayoutContext();
			}
			if (e.affectsConfiguration('gitCompare.viewAsTree')) {
				syncTreeContext();
				provider.rebuild();
			}
			if (e.affectsConfiguration('gitCompare.showUntracked')) {
				provider.refresh();
			}
		}),
		vscode.workspace.onDidSaveTextDocument(scheduleRefresh),

		vscode.commands.registerCommand('gitCompare.compareWithRef', () => compareRepository(false)),
		vscode.commands.registerCommand('gitCompare.compareWithMergeBase', () => compareRepository(true)),

		// Explorer / editor: a file opens its diff right away, a folder becomes the view's comparison.
		vscode.commands.registerCommand('gitCompare.compareResourceWithRef', async (arg?: vscode.Uri) => {
			const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
			if (!uri || uri.scheme !== 'file') {
				vscode.window.showWarningMessage('Git Compare: select a file or folder in the workspace.');
				return;
			}
			const where = await locate(uri);
			if (!where) {
				vscode.window.showErrorMessage(`Git Compare: ${uri.fsPath} is not in a git repository.`);
				return;
			}
			const name = path.basename(uri.fsPath);
			const ref = await pickRef(where.root, `Compare ${name} with…`);
			if (!ref) {
				return;
			}
			if (where.isDir) {
				await start({ root: where.root, rev: ref.rev, label: ref.label, mergeBase: false, pathspec: where.relPath ? [where.relPath] : [] });
				return;
			}
			try {
				const resolved = await resolveCommit(where.root, ref.rev);
				const sides: DiffSides = {
					left: commitFileUri(where.root, resolved.commit, where.relPath),
					right: uri,
					file: uri,
					title: `${name} (${ref.label} ${resolved.short} ↔ Working Tree)`,
				};
				await openDiff(sides, configuredLayout(), false);
			} catch (err) {
				vscode.window.showErrorMessage(`Git Compare: ${errorText(err)}`);
			}
		}),

		vscode.commands.registerCommand('gitCompare.openActiveFileDiff', async () => {
			const session = provider.session;
			const uri = vscode.window.activeTextEditor?.document.uri;
			if (!session || !uri || uri.scheme !== 'file') {
				return;
			}
			const where = await locate(uri);
			if (!where || where.root !== session.root) {
				vscode.window.showWarningMessage(`Git Compare: the active file is not in ${session.root}.`);
				return;
			}
			const change: Change = provider.changes.find((c) => c.path === where.relPath) ??
				provider.untracked.find((c) => c.path === where.relPath) ?? { status: 'M', path: where.relPath };
			await openDiff(sidesOf(session, change), configuredLayout(), false);
		}),

		vscode.commands.registerCommand('gitCompare.checkForUpdates', () => checkForUpdates(context, true)),
		vscode.commands.registerCommand('gitCompare.refresh', () => provider.refresh()),
		vscode.commands.registerCommand('gitCompare.clear', () => provider.clear()),

		vscode.commands.registerCommand('gitCompare.openAll', async (arg?: unknown) => {
			const session = provider.session;
			if (!session) {
				return;
			}
			const groupId: GroupId = (arg as Node | undefined)?.kind === 'group' ? (arg as Node).group : 'changes';
			const changes = groupId === 'untracked' ? provider.untracked : provider.changes;
			if (changes.length === 0) {
				vscode.window.showInformationMessage(`Git Compare: nothing differs from ${sessionTitle(session)}.`);
				return;
			}
			if (changes.length > 300) {
				const go = await vscode.window.showWarningMessage(`Open ${changes.length} files in one editor?`, { modal: true }, 'Open');
				if (go !== 'Open') {
					return;
				}
			}
			await applyLayout(configuredLayout());
			const resources = changes.map((c) => {
				const sides = sidesOf(session, c);
				return [sides.file, sides.left, sides.right];
			});
			await vscode.commands.executeCommand('vscode.changes', `${sessionTitle(session)} ↔ Working Tree`, resources);
		}),

		vscode.commands.registerCommand('gitCompare.showInline', () => applyLayout('inline')),
		vscode.commands.registerCommand('gitCompare.showSideBySide', () => applyLayout('sideBySide')),
		vscode.commands.registerCommand('gitCompare.viewAsTree', () =>
			vscode.workspace.getConfiguration('gitCompare').update('viewAsTree', true, vscode.ConfigurationTarget.Global),
		),
		vscode.commands.registerCommand('gitCompare.viewAsList', () =>
			vscode.workspace.getConfiguration('gitCompare').update('viewAsTree', false, vscode.ConfigurationTarget.Global),
		),

		vscode.commands.registerCommand('gitCompare.openDiff', (arg?: unknown) => openNode(arg, configuredLayout())),
		vscode.commands.registerCommand('gitCompare.openDiffInline', (arg?: unknown) => openNode(arg, 'inline')),
		vscode.commands.registerCommand('gitCompare.openDiffSideBySide', (arg?: unknown) => openNode(arg, 'sideBySide')),
		vscode.commands.registerCommand('gitCompare.openFile', async (arg?: unknown) => {
			const node = fileNodeOf(arg);
			const session = provider.session;
			if (node && session && node.change.status !== 'D') {
				await vscode.window.showTextDocument(sidesOf(session, node.change).file, { preview: false });
			}
		}),
		vscode.commands.registerCommand('gitCompare.openFileAtRef', async (arg?: unknown) => {
			const node = fileNodeOf(arg);
			const session = provider.session;
			if (node && session) {
				const uri = commitFileUri(session.root, session.resolved.commit, node.change.oldPath ?? node.change.path);
				await vscode.window.showTextDocument(uri, { preview: false });
			}
		}),
	);

	scheduleUpdateCheck(context);

	// Bring back the comparison from the last session.
	const saved = context.workspaceState.get<CompareBase>(STATE_KEY);
	if (saved && fs.existsSync(saved.root)) {
		provider.start(saved).catch(() => context.workspaceState.update(STATE_KEY, undefined));
	}
}

export function deactivate(): void {}
