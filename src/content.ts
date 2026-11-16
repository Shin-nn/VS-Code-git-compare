import * as vscode from 'vscode';
import { ChangeStatus, showFile } from './git';

/** Read-only documents with a file's content at a commit (or empty, for the missing side of an add / delete). */
export const CONTENT_SCHEME = 'gitcompare';
/** Tree item resources: only there so the file icon theme and our status decorations apply. */
export const ITEM_SCHEME = 'gitcompare-item';

interface ContentQuery {
	root?: string;
	commit?: string;
	empty?: boolean;
}

export function commitFileUri(root: string, commit: string, relPath: string): vscode.Uri {
	const query: ContentQuery = { root, commit };
	return vscode.Uri.from({ scheme: CONTENT_SCHEME, path: '/' + relPath, query: JSON.stringify(query) });
}

export function emptyFileUri(relPath: string): vscode.Uri {
	const query: ContentQuery = { empty: true };
	return vscode.Uri.from({ scheme: CONTENT_SCHEME, path: '/' + relPath, query: JSON.stringify(query) });
}

export class CommitContentProvider implements vscode.TextDocumentContentProvider {
	async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
		let query: ContentQuery;
		try {
			query = JSON.parse(uri.query) as ContentQuery;
		} catch {
			return '';
		}
		if (query.empty || !query.root || !query.commit) {
			return '';
		}
		try {
			return (await showFile(query.root, query.commit, uri.path.slice(1))).toString('utf8');
		} catch {
			return ''; // not in that commit
		}
	}
}

export function itemUri(relPath: string, status?: ChangeStatus): vscode.Uri {
	return vscode.Uri.from({ scheme: ITEM_SCHEME, path: '/' + relPath, query: status ?? '' });
}

const STATUS: Record<ChangeStatus, { letter: string; tooltip: string; color: string }> = {
	A: { letter: 'A', tooltip: 'Added', color: 'gitDecoration.addedResourceForeground' },
	M: { letter: 'M', tooltip: 'Modified', color: 'gitDecoration.modifiedResourceForeground' },
	D: { letter: 'D', tooltip: 'Deleted', color: 'gitDecoration.deletedResourceForeground' },
	R: { letter: 'R', tooltip: 'Renamed', color: 'gitDecoration.renamedResourceForeground' },
	C: { letter: 'C', tooltip: 'Copied', color: 'gitDecoration.addedResourceForeground' },
	T: { letter: 'T', tooltip: 'Type changed', color: 'gitDecoration.modifiedResourceForeground' },
	U: { letter: '!', tooltip: 'Conflict', color: 'gitDecoration.conflictingResourceForeground' },
	'?': { letter: 'U', tooltip: 'Untracked', color: 'gitDecoration.untrackedResourceForeground' },
};

export function statusText(status: ChangeStatus): string {
	return STATUS[status].tooltip;
}

export class StatusDecorationProvider implements vscode.FileDecorationProvider {
	provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
		if (uri.scheme !== ITEM_SCHEME || !uri.query) {
			return undefined;
		}
		const info = STATUS[uri.query as ChangeStatus];
		if (!info) {
			return undefined;
		}
		const decoration = new vscode.FileDecoration(info.letter, info.tooltip, new vscode.ThemeColor(info.color));
		decoration.propagate = false;
		return decoration;
	}
}
