import * as path from 'path';
import * as vscode from 'vscode';
import { itemUri, statusText } from './content';
import { Change, diffWithWorkingTree, mergeBase, resolveCommit, Revision, untrackedFiles } from './git';

/** What the working tree is compared with. Kept in the workspace state, so it survives a reload. */
export interface CompareBase {
	root: string;
	rev: string;
	label: string;
	/** Compare with merge-base(rev, HEAD) instead of rev itself. */
	mergeBase: boolean;
	/** Limit to these paths (relative to root); empty = the whole repository. */
	pathspec: string[];
}

export interface Session extends CompareBase {
	resolved: Revision;
}

export type GroupId = 'changes' | 'untracked';

export interface FileNode {
	kind: 'file';
	group: GroupId;
	change: Change;
}

export interface FolderNode {
	kind: 'folder';
	group: GroupId;
	/** Path relative to the root; for compacted folders, the deepest one. */
	relPath: string;
	label: string;
	children: Node[];
}

export interface GroupNode {
	kind: 'group';
	group: GroupId;
	label: string;
	files: FileNode[];
	children: Node[];
}

export type Node = FileNode | FolderNode | GroupNode;

export function sessionTitle(s: Session): string {
	const what = s.mergeBase ? `merge base of ${s.label}` : s.label;
	return `${what} (${s.resolved.short})`;
}

function buildTree(group: GroupId, files: FileNode[]): Node[] {
	interface Dir {
		dirs: Map<string, Dir>;
		files: FileNode[];
	}
	const top: Dir = { dirs: new Map(), files: [] };
	for (const file of files) {
		const parts = file.change.path.split('/');
		parts.pop();
		let dir = top;
		for (const part of parts) {
			let next = dir.dirs.get(part);
			if (!next) {
				next = { dirs: new Map(), files: [] };
				dir.dirs.set(part, next);
			}
			dir = next;
		}
		dir.files.push(file);
	}
	const convert = (dir: Dir, prefix: string): Node[] => {
		const folders: FolderNode[] = [];
		for (const [name, sub] of [...dir.dirs].sort(([a], [b]) => a.localeCompare(b))) {
			// Compact chains of folders that only hold one folder: a/b/c.
			let label = name;
			let relPath = prefix + name;
			let current = sub;
			while (current.files.length === 0 && current.dirs.size === 1) {
				const [childName, child] = [...current.dirs][0];
				label += '/' + childName;
				relPath += '/' + childName;
				current = child;
			}
			folders.push({ kind: 'folder', group, relPath, label, children: convert(current, relPath + '/') });
		}
		const sortedFiles = [...dir.files].sort((a, b) => a.change.path.localeCompare(b.change.path));
		return [...folders, ...sortedFiles];
	};
	return convert(top, '');
}

export class CompareProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<Node | undefined>();
	readonly onDidChangeTreeData = this.changed.event;

	private readonly sessionChanged = new vscode.EventEmitter<Session | undefined>();
	readonly onDidChangeSession = this.sessionChanged.event;

	session: Session | undefined;
	changes: Change[] = [];
	untracked: Change[] = [];
	private error: string | undefined;
	private generation = 0;
	private groups: GroupNode[] = [];

	view: vscode.TreeView<Node> | undefined;

	dispose(): void {
		this.changed.dispose();
		this.sessionChanged.dispose();
	}

	/** Start comparing with `base`; throws when its revision doesn't resolve. */
	async start(base: CompareBase): Promise<void> {
		const resolved = await this.resolve(base);
		this.session = { ...base, resolved };
		this.sessionChanged.fire(this.session);
		await this.refresh();
	}

	clear(): void {
		this.generation++;
		this.session = undefined;
		this.changes = [];
		this.untracked = [];
		this.error = undefined;
		this.groups = [];
		this.sessionChanged.fire(undefined);
		this.updateView();
		this.changed.fire(undefined);
	}

	private resolve(base: CompareBase): Promise<Revision> {
		return base.mergeBase ? mergeBase(base.root, base.rev) : resolveCommit(base.root, base.rev);
	}

	async refresh(): Promise<void> {
		const session = this.session;
		if (!session) {
			return;
		}
		const generation = ++this.generation;
		if (this.view) {
			this.view.message = undefined;
		}
		try {
			// A branch may have moved (commit, fetch, rebase): resolve it again.
			const resolved = await this.resolve(session);
			const showUntracked = vscode.workspace.getConfiguration('gitCompare').get<boolean>('showUntracked', true);
			const [changes, untracked] = await Promise.all([
				diffWithWorkingTree(session.root, resolved.commit, session.pathspec),
				showUntracked ? untrackedFiles(session.root, session.pathspec) : Promise.resolve([]),
			]);
			if (generation !== this.generation) {
				return;
			}
			const moved = resolved.commit !== session.resolved.commit;
			session.resolved = resolved;
			this.changes = changes;
			this.untracked = untracked;
			this.error = undefined;
			if (moved) {
				this.sessionChanged.fire(session);
			}
		} catch (err) {
			if (generation !== this.generation) {
				return;
			}
			this.changes = [];
			this.untracked = [];
			this.error = err instanceof Error ? err.message : String(err);
		}
		this.rebuild();
	}

	rebuild(): void {
		const asTree = vscode.workspace.getConfiguration('gitCompare').get<boolean>('viewAsTree', true);
		const make = (group: GroupId, label: string, list: Change[]): GroupNode => {
			const files: FileNode[] = list.map((change) => ({ kind: 'file', group, change }));
			const children: Node[] = asTree ? buildTree(group, files) : [...files].sort((a, b) => a.change.path.localeCompare(b.change.path));
			return { kind: 'group', group, label, files, children };
		};
		this.groups = [make('changes', 'Changes', this.changes)];
		if (this.untracked.length > 0) {
			this.groups.push(make('untracked', 'Untracked', this.untracked));
		}
		this.updateView();
		this.changed.fire(undefined);
	}

	private updateView(): void {
		const view = this.view;
		if (!view) {
			return;
		}
		const s = this.session;
		if (!s) {
			view.description = undefined;
			view.message = undefined;
			view.badge = undefined;
			return;
		}
		const scope = s.pathspec.length > 0 ? ` · ${s.pathspec.join(', ')}` : '';
		view.description = `${sessionTitle(s)}${scope}`;
		if (this.error) {
			view.message = `Can't compare with ${s.label}: ${this.error}`;
		} else if (this.changes.length === 0 && this.untracked.length === 0) {
			view.message = `The working tree is the same as ${sessionTitle(s)}.`;
		} else {
			view.message = undefined;
		}
		const count = this.changes.length;
		view.badge = count > 0 ? { value: count, tooltip: `${count} file(s) differ from ${s.label}` } : undefined;
	}

	group(id: GroupId): GroupNode | undefined {
		return this.groups.find((g) => g.group === id);
	}

	getChildren(node?: Node): Node[] {
		if (!this.session || this.error) {
			return [];
		}
		if (!node) {
			return this.groups.length === 1 && this.groups[0].files.length === 0 ? [] : this.groups;
		}
		return node.kind === 'file' ? [] : node.children;
	}

	getParent(): undefined {
		return undefined;
	}

	getTreeItem(node: Node): vscode.TreeItem {
		const root = this.session?.root ?? '';
		switch (node.kind) {
			case 'group': {
				const item = new vscode.TreeItem(
					node.label,
					node.group === 'untracked' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded,
				);
				item.id = `group:${node.group}`;
				item.description = String(node.files.length);
				item.contextValue = `group-${node.group}`;
				return item;
			}
			case 'folder': {
				const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
				item.id = `folder:${node.group}:${node.relPath}`;
				item.resourceUri = itemUri(node.relPath);
				item.iconPath = vscode.ThemeIcon.Folder;
				item.tooltip = node.relPath;
				item.contextValue = 'folder';
				return item;
			}
			case 'file': {
				const c = node.change;
				const item = new vscode.TreeItem(path.posix.basename(c.path), vscode.TreeItemCollapsibleState.None);
				item.id = `file:${node.group}:${c.path}`;
				item.resourceUri = itemUri(c.path, c.status);
				item.iconPath = vscode.ThemeIcon.File;
				const asTree = vscode.workspace.getConfiguration('gitCompare').get<boolean>('viewAsTree', true);
				const dir = path.posix.dirname(c.path);
				const parts: string[] = [];
				if (!asTree && dir !== '.') {
					parts.push(dir);
				}
				if (c.oldPath) {
					parts.push(`← ${c.oldPath}`);
				}
				item.description = parts.join(' ') || undefined;
				item.tooltip = `${path.join(root, c.path)} · ${statusText(c.status)}${c.oldPath ? ` from ${c.oldPath}` : ''}`;
				item.contextValue = c.status === 'D' ? 'fileDeleted' : c.status === 'A' || c.status === '?' ? 'fileAdded' : 'file';
				item.command = { command: 'gitCompare.openDiff', title: 'Open Changes', arguments: [node] };
				return item;
			}
		}
	}
}
