import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_RISKY_PATTERNS, parseNumstat } from "../src/review.ts";
import { EMPTY_TREE, diffNumstat, diffPatch, headTree, repoRoot, snapshotTree } from "../src/git-snapshot.ts";

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

function makeRepo() {
	const dir = mkdtempSync(join(tmpdir(), "pi-modes-snap-test-"));
	git(dir, "init", "-q");
	writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
	writeFileSync(join(dir, "a.ts"), "one\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "init");
	return dir;
}

test("outside a repository there is no root", () => {
	assert.equal(repoRoot(mkdtempSync(join(tmpdir(), "pi-modes-nogit-"))), undefined);
});

test("snapshots capture tracked, staged, and untracked changes without touching the user's git state", () => {
	const dir = makeRepo();
	const root = repoRoot(join(dir))!;
	assert.ok(root);

	writeFileSync(join(dir, "staged.ts"), "staged\n");
	git(dir, "add", "staged.ts");
	const statusBefore = git(dir, "status", "--porcelain");
	const indexBefore = readFileSync(join(dir, ".git", "index"));

	const base = snapshotTree(root)!;
	writeFileSync(join(dir, "a.ts"), "one\ntwo\n");
	writeFileSync(join(dir, "new.ts"), "brand new\n");
	mkdirSync(join(dir, "node_modules"));
	writeFileSync(join(dir, "node_modules", "junk.js"), "ignored\n");
	const end = snapshotTree(root)!;

	assert.notEqual(base, end);
	const stats = parseNumstat(diffNumstat(root, base, end), DEFAULT_RISKY_PATTERNS);
	assert.deepEqual(stats.files.map((file) => file.path).sort(), ["a.ts", "new.ts"], "ignored files stay out; the staged file is in both");
	assert.match(diffPatch(root, base, end), /\+two/);

	assert.equal(snapshotTree(root), end, "same tree for the same state");
	assert.deepEqual(readFileSync(join(dir, ".git", "index")), indexBefore, "the real index is byte-for-byte unchanged");
	assert.match(statusBefore, /A {2}staged.ts/);
	assert.match(git(dir, "status", "--porcelain"), /A {2}staged.ts/, "the staged file is still staged");
	assert.match(git(dir, "status", "--porcelain"), /\?\? new.ts/, "new files stay untracked");
	assert.equal(git(dir, "stash", "list"), "", "no stash created");
	assert.equal(git(dir, "rev-list", "--count", "HEAD"), "1", "no commit created");
});

test("headTree is HEAD's tree, or the empty tree before the first commit", () => {
	const dir = makeRepo();
	assert.equal(headTree(dir), git(dir, "rev-parse", "HEAD^{tree}"));
	const fresh = mkdtempSync(join(tmpdir(), "pi-modes-fresh-"));
	git(fresh, "init", "-q");
	assert.equal(headTree(fresh), EMPTY_TREE);
	writeFileSync(join(fresh, "x.ts"), "x\n");
	const stats = parseNumstat(diffNumstat(fresh, EMPTY_TREE, snapshotTree(fresh)!), DEFAULT_RISKY_PATTERNS);
	assert.deepEqual(stats.files.map((file) => file.path), ["x.ts"]);
});
