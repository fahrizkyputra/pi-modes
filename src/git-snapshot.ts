/**
 * Snapshots of the working tree as git tree objects, without touching the
 * user's working tree, index, stash, branches, or commits.
 *
 * A snapshot copies the real index to a temporary file (so unchanged files are
 * not re-hashed), runs `git add -A` against that copy, and writes it as a tree.
 * Ignored files stay out. The tree is unreachable, so `git gc` prunes it later.
 */

import { execFile, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";

/** The tree of an empty repository (SHA-1 object format). */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const TIMEOUT_MS = 15_000;
const MAX_BUFFER = 64 * 1024 * 1024;

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: TIMEOUT_MS,
		maxBuffer: MAX_BUFFER,
		env: env ? { ...process.env, ...env } : process.env,
	});
}

/** The repository root, or undefined outside a git work tree. */
export function repoRoot(cwd: string): string | undefined {
	try {
		const root = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
		return root || undefined;
	} catch {
		return undefined;
	}
}

/** Tree of the current working tree (tracked + untracked, minus ignored), or undefined on failure. */
export function snapshotTree(root: string): string | undefined {
	const dir = mkdtempSync(join(tmpdir(), "pi-modes-snap-"));
	const tempIndex = join(dir, "index");
	try {
		const indexPath = git(root, ["rev-parse", "--git-path", "index"]).trim();
		const absoluteIndex = isAbsolute(indexPath) ? indexPath : join(root, indexPath);
		if (existsSync(absoluteIndex)) copyFileSync(absoluteIndex, tempIndex);
		const env = { GIT_INDEX_FILE: tempIndex, GIT_OPTIONAL_LOCKS: "0" };
		git(root, ["add", "-A", "--", "."], env);
		const tree = git(root, ["write-tree"], env).trim();
		return /^[0-9a-f]{40,64}$/.test(tree) ? tree : undefined;
	} catch {
		return undefined;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Tree of HEAD, or the empty tree in a repository without commits. */
export function headTree(root: string): string {
	try {
		return git(root, ["rev-parse", "HEAD^{tree}"]).trim();
	} catch {
		return EMPTY_TREE;
	}
}

const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-renames"];

export function diffNumstat(root: string, from: string, to: string): string {
	return git(root, ["diff", ...DIFF_FLAGS, "--numstat", from, to]);
}

/** `label` puts every path under a folder name, for a review that spans several repositories. */
export function diffPatch(root: string, from: string, to: string, label = ""): string {
	const prefixes = label ? [`--src-prefix=a/${label}/`, `--dst-prefix=b/${label}/`] : [];
	return git(root, ["diff", ...DIFF_FLAGS, ...prefixes, "-U5", from, to]);
}

// ---- finding repositories ----------------------------------------------------------

/**
 * The repository that holds a file, even if the file or its folders do not exist yet.
 * `cache` remembers answers (including "not in a repository") for one task; pass a
 * fresh map per task so a later `git init` is noticed.
 */
export function repoForPath(path: string, cache: Map<string, string | null> = new Map()): string | undefined {
	let dir = dirname(path);
	while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
	const known = cache.get(dir);
	if (known !== undefined) return known ?? undefined;
	const root = repoRoot(dir);
	cache.set(dir, root ?? null);
	return root;
}

/**
 * Where /review uncommitted looks: the monorepo folder (the nearest parent without git),
 * or the repository itself when its parent is a repository too. Never the home folder or
 * the filesystem root, which are not projects.
 */
export function scanRoot(cwd: string): string | undefined {
	const top = repoRoot(cwd);
	const start = top ?? cwd;
	const unsafe = (dir: string) => dir === homedir() || dir === sep || dirname(dir) === dir;
	if (!top) return unsafe(start) ? undefined : start;
	const parent = dirname(top);
	if (unsafe(parent)) return top;
	return repoRoot(parent) === undefined ? parent : top;
}

export const MAX_SCAN_REPOS = 40;
const SCAN_DEPTH = 5;

/** Every repository and linked worktree under `dir` (node_modules skipped), at most `limit`. */
export function findReposUnder(dir: string, limit = MAX_SCAN_REPOS): { repos: string[]; skipped: number } {
	let output = "";
	try {
		output = execFileSync("find", [dir, "-maxdepth", String(SCAN_DEPTH), "-name", "node_modules", "-prune", "-o", "-name", ".git", "-print"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 10_000,
			maxBuffer: MAX_BUFFER,
		});
	} catch (error) {
		// find exits non-zero on unreadable folders but still lists what it found.
		output = (error as { stdout?: string }).stdout ?? "";
	}
	const repos = new Set<string>();
	for (const line of output.split("\n")) {
		if (!line.trim()) continue;
		try {
			repos.add(realpathSync(dirname(line)));
		} catch {
			// vanished while scanning
		}
	}
	const all = [...repos].sort();
	return { repos: all.slice(0, limit), skipped: Math.max(0, all.length - limit) };
}

/** Which of the repositories have uncommitted changes (tracked or untracked), checked in parallel. */
export async function dirtyRepos(repos: readonly string[], concurrency = 8): Promise<string[]> {
	const dirty: string[] = [];
	let next = 0;
	const check = (root: string) =>
		new Promise<boolean>((resolve) => {
			execFile("git", ["-C", root, "status", "--porcelain"], { timeout: 15_000, maxBuffer: MAX_BUFFER }, (error, stdout) => {
				resolve(!error && stdout.trim().length > 0);
			});
		});
	const worker = async () => {
		while (next < repos.length) {
			const root = repos[next++]!;
			if (await check(root)) dirty.push(root);
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, repos.length) }, worker));
	return dirty.sort();
}
