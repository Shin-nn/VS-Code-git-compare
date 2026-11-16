import { execFile } from 'child_process';
import * as vscode from 'vscode';

const MAX_BUFFER = 512 * 1024 * 1024;

export class GitError extends Error {}

function gitExecutable(): string {
	const configured = vscode.workspace.getConfiguration('git').get<string | string[] | null>('path');
	if (typeof configured === 'string' && configured) {
		return configured;
	}
	if (Array.isArray(configured) && configured.length > 0) {
		return configured[0];
	}
	return 'git';
}

export function gitBuffer(cwd: string, args: string[]): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		execFile(
			gitExecutable(),
			['-c', 'core.quotepath=off', ...args],
			{
				cwd,
				encoding: 'buffer',
				maxBuffer: MAX_BUFFER,
				// Never take index.lock for a refresh: it would collide with the user's own git commands.
				env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
			},
			(err, stdout, stderr) => {
				if (err) {
					const message = stderr.toString('utf8').trim() || err.message;
					reject(new GitError(message));
					return;
				}
				resolve(stdout);
			},
		);
	});
}

export async function git(cwd: string, args: string[]): Promise<string> {
	return (await gitBuffer(cwd, args)).toString('utf8');
}

/** Top level of the repository containing directory `dir`, or undefined. */
export async function repoRootOf(dir: string): Promise<string | undefined> {
	try {
		return (await git(dir, ['rev-parse', '--show-toplevel'])).trim() || undefined;
	} catch {
		return undefined;
	}
}

/** Path of `dir` relative to its repository's top level, with a trailing slash ('' at the top). */
export async function prefixOf(dir: string): Promise<string> {
	return (await git(dir, ['rev-parse', '--show-prefix'])).trim();
}

export interface Revision {
	/** Full commit hash. */
	commit: string;
	short: string;
}

function checkRev(rev: string): void {
	if (!rev || rev.startsWith('-')) {
		throw new GitError(`Not a revision: '${rev}'`);
	}
}

export async function resolveCommit(root: string, rev: string): Promise<Revision> {
	checkRev(rev);
	let commit: string;
	try {
		commit = (await git(root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])).trim();
	} catch {
		commit = '';
	}
	if (!commit) {
		throw new GitError(`'${rev}' is not a commit in ${root}`);
	}
	const short = (await git(root, ['rev-parse', '--short', commit])).trim();
	return { commit, short };
}

export async function mergeBase(root: string, rev: string, other = 'HEAD'): Promise<Revision> {
	checkRev(rev);
	let commit: string;
	try {
		commit = (await git(root, ['merge-base', rev, other])).trim();
	} catch {
		commit = '';
	}
	if (!commit) {
		throw new GitError(`'${rev}' and ${other} have no common ancestor`);
	}
	return resolveCommit(root, commit);
}

export type RefKind = 'branch' | 'remote' | 'tag';

export interface GitRef {
	kind: RefKind;
	name: string;
	short: string;
	subject: string;
	date: string;
}

export async function listRefs(root: string): Promise<GitRef[]> {
	const format = [
		'%(refname)',
		'%(refname:short)',
		'%(if)%(*objectname)%(then)%(*objectname:short)%(else)%(objectname:short)%(end)',
		'%(contents:subject)',
		'%(creatordate:relative)',
	].join('%00');
	const out = await git(root, [
		'for-each-ref',
		'--sort=-creatordate',
		`--format=${format}`,
		'refs/heads',
		'refs/remotes',
		'refs/tags',
	]);
	const refs: GitRef[] = [];
	for (const line of out.split('\n')) {
		if (!line) {
			continue;
		}
		const [full, name, short, subject, date] = line.split('\0');
		if (full.startsWith('refs/remotes/') && full.endsWith('/HEAD')) {
			continue;
		}
		const kind: RefKind = full.startsWith('refs/heads/') ? 'branch' : full.startsWith('refs/tags/') ? 'tag' : 'remote';
		refs.push({ kind, name, short, subject: subject ?? '', date: date ?? '' });
	}
	return refs;
}

export interface GitCommit {
	commit: string;
	short: string;
	subject: string;
	author: string;
	date: string;
}

export async function listCommits(root: string, count: number): Promise<GitCommit[]> {
	if (count <= 0) {
		return [];
	}
	try {
		const out = await git(root, ['log', `-n${count}`, '--format=%H%x00%h%x00%s%x00%an%x00%cr', 'HEAD', '--']);
		return out
			.split('\n')
			.filter((line) => line)
			.map((line) => {
				const [commit, short, subject, author, date] = line.split('\0');
				return { commit, short, subject, author, date };
			});
	} catch {
		return []; // no commits yet
	}
}

export async function currentBranch(root: string): Promise<string | undefined> {
	try {
		return (await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim() || undefined;
	} catch {
		return undefined; // detached
	}
}

/** A = added, M = modified, D = deleted, R = renamed, C = copied, T = type changed, U = unmerged, ? = untracked. */
export type ChangeStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | '?';

export interface Change {
	status: ChangeStatus;
	/** Path relative to the repository root, '/'-separated: the working tree side. */
	path: string;
	/** For renames and copies: the path on the commit side. */
	oldPath?: string;
}

/** Differences between `commit` and the working tree (staged or not), limited to `pathspec`. */
export async function diffWithWorkingTree(root: string, commit: string, pathspec: string[]): Promise<Change[]> {
	const out = await git(root, ['diff', '--name-status', '-z', '-M', '--no-ext-diff', '--no-color', commit, '--', ...pathspec]);
	const parts = out.split('\0');
	const changes: Change[] = [];
	for (let i = 0; i < parts.length; ) {
		const status = parts[i++];
		if (!status) {
			continue;
		}
		const code = status[0] as ChangeStatus;
		if (code === 'R' || code === 'C') {
			const oldPath = parts[i++];
			const path = parts[i++];
			changes.push({ status: code, path, oldPath });
		} else {
			changes.push({ status: code, path: parts[i++] });
		}
	}
	return changes;
}

export async function untrackedFiles(root: string, pathspec: string[]): Promise<Change[]> {
	const out = await git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...pathspec]);
	return out
		.split('\0')
		.filter((path) => path)
		.map((path) => ({ status: '?' as const, path }));
}

/** The file `path` as stored in `commit`, with the checkout filters (eol, smudge) applied, so it matches the working tree. */
export async function showFile(root: string, commit: string, path: string): Promise<Buffer> {
	const object = `${commit}:${path}`;
	try {
		return await gitBuffer(root, ['cat-file', '--filters', object]);
	} catch {
		return gitBuffer(root, ['cat-file', 'blob', object]);
	}
}
