/**
 * Snapshots of the working tree as git tree objects, without touching the
 * user's working tree, index, stash, branches, or commits.
 *
 * A snapshot copies the real index to a temporary file (so unchanged files are
 * not re-hashed), runs `git add -A` against that copy, and writes it as a tree.
 * Ignored files stay out. The tree is unreachable, so `git gc` prunes it later.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

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

export function diffPatch(root: string, from: string, to: string): string {
	return git(root, ["diff", ...DIFF_FLAGS, "-U5", from, to]);
}
