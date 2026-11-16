import * as vscode from 'vscode';
import { currentBranch, git, listCommits, listRefs } from './git';

export interface PickedRef {
	/** What to give git: a ref name, a hash or whatever the user typed. */
	rev: string;
	/** How to show it. */
	label: string;
	/** A branch / tag / typed revision is resolved again on every refresh; a picked commit stays put. */
	fixed: boolean;
}

interface RefItem extends vscode.QuickPickItem {
	ref?: PickedRef;
}

function separator(label: string): RefItem {
	return { label, kind: vscode.QuickPickItemKind.Separator };
}

async function loadItems(root: string): Promise<RefItem[]> {
	const count = vscode.workspace.getConfiguration('gitCompare').get<number>('recentCommits', 200);
	const [refs, commits, branch, head] = await Promise.all([
		listRefs(root),
		listCommits(root, count),
		currentBranch(root),
		git(root, ['log', '-1', '--format=%h%x00%s', 'HEAD', '--']).catch(() => ''),
	]);
	const items: RefItem[] = [];
	if (head) {
		const [short, subject] = head.trim().split('\0');
		items.push(separator('Current'));
		items.push({
			label: '$(git-commit) HEAD',
			description: `${branch ?? 'detached'} · ${short} ${subject}`,
			ref: { rev: 'HEAD', label: 'HEAD', fixed: false },
		});
	}
	const groups: [string, string, typeof refs][] = [
		['Local branches', '$(git-branch)', refs.filter((r) => r.kind === 'branch')],
		['Remote branches', '$(cloud)', refs.filter((r) => r.kind === 'remote')],
		['Tags', '$(tag)', refs.filter((r) => r.kind === 'tag')],
	];
	for (const [title, icon, list] of groups) {
		if (list.length === 0) {
			continue;
		}
		items.push(separator(title));
		for (const r of list) {
			items.push({
				label: `${icon} ${r.name}`,
				description: `${r.short} · ${r.date}${r.name === branch ? ' · current' : ''}`,
				detail: r.subject || undefined,
				ref: { rev: r.name, label: r.name, fixed: false },
			});
		}
	}
	if (commits.length > 0) {
		items.push(separator('Recent commits (HEAD)'));
		for (const c of commits) {
			items.push({
				label: `$(git-commit) ${c.subject}`,
				description: `${c.short} · ${c.author} · ${c.date}`,
				ref: { rev: c.commit, label: c.short, fixed: true },
			});
		}
	}
	return items;
}

/** Quick pick of HEAD, branches, tags and recent commits; anything else (HEAD~3, a hash, main@{1.week.ago}) can be typed. */
export function pickRef(root: string, title: string): Promise<PickedRef | undefined> {
	return new Promise((resolve) => {
		const qp = vscode.window.createQuickPick<RefItem>();
		qp.title = title;
		qp.placeholder = 'Branch, tag or commit; or type any revision (HEAD~3, a hash, main@{yesterday}…)';
		qp.matchOnDescription = true;
		qp.matchOnDetail = true;
		qp.busy = true;

		let base: RefItem[] = [];
		const update = () => {
			const value = qp.value.trim();
			const exact = base.some((item) => item.ref?.rev === value);
			qp.items =
				value && !exact
					? [...base, separator('Revision'), { label: `$(edit) ${value}`, description: 'use this revision', alwaysShow: true, ref: { rev: value, label: value, fixed: false } }]
					: base;
		};

		let done = false;
		const finish = (result: PickedRef | undefined) => {
			if (!done) {
				done = true;
				resolve(result);
				qp.dispose();
			}
		};

		qp.onDidChangeValue(update);
		qp.onDidAccept(() => {
			const picked = qp.selectedItems[0]?.ref;
			if (picked) {
				finish(picked);
			} else if (qp.value.trim()) {
				finish({ rev: qp.value.trim(), label: qp.value.trim(), fixed: false });
			}
		});
		qp.onDidHide(() => finish(undefined));
		qp.show();

		loadItems(root).then(
			(items) => {
				base = items;
				qp.busy = false;
				update();
			},
			(err: unknown) => {
				qp.busy = false;
				vscode.window.showErrorMessage(`Git Compare: can't list refs: ${err instanceof Error ? err.message : String(err)}`);
			},
		);
	});
}
