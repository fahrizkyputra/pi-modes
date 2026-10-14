import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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

// ---- several repositories under a folder without git ------------------------------------

import { commandDirs, commonAncestor, labelNumstat, repoLabel } from "../src/review.ts";
import { dirtyRepos, findReposUnder, repoForPath, scanRoot } from "../src/git-snapshot.ts";

function makeMonorepo() {
	const mono = mkdtempSync(join(tmpdir(), "pi-modes-mono-"));
	const mk = (name: string) => {
		const dir = join(mono, name);
		mkdirSync(dir, { recursive: true });
		git(dir, "init", "-q");
		writeFileSync(join(dir, "README.md"), `${name}\n`);
		git(dir, "add", "-A");
		git(dir, "commit", "-q", "-m", "init");
		return dir;
	};
	const api = mk("api");
	const web = mk("web");
	const nested = mk("services/billing");
	mkdirSync(join(mono, "node_modules", "dep"), { recursive: true });
	git(join(mono, "node_modules", "dep"), "init", "-q");
	return { mono, api, web, nested };
}

test("a folder without git: the scan root is the folder, its repositories are found, node_modules is skipped", () => {
	const { mono, api, web, nested } = makeMonorepo();
	const real = (path: string) => repoRoot(path)!;
	assert.equal(repoRoot(mono), undefined);
	assert.equal(scanRoot(mono), mono);
	const { repos, skipped } = findReposUnder(mono);
	assert.deepEqual(repos.sort(), [real(api), real(nested), real(web)].sort());
	assert.equal(skipped, 0);
});

test("inside one repository of a monorepo, the scan root is the folder above it", () => {
	const { mono, api } = makeMonorepo();
	const above = realpathSync(mono);
	assert.equal(scanRoot(api), above);
	mkdirSync(join(api, "src", "deep"), { recursive: true });
	assert.equal(scanRoot(join(api, "src", "deep")), above, "a subfolder inside the repository too");
	assert.equal(scanRoot(join(mono, "nowhere-yet")), join(mono, "nowhere-yet"), "a folder with no repository: scan that folder");
});

test("a repository whose parent is a repository too scans only itself", () => {
	const outer = mkdtempSync(join(tmpdir(), "pi-modes-outer-"));
	git(outer, "init", "-q");
	const inner = join(outer, "vendor", "lib");
	mkdirSync(inner, { recursive: true });
	git(inner, "init", "-q");
	assert.equal(scanRoot(inner), realpathSync(inner), "the nearest parent is a repository, not a monorepo folder");
});

function dirnameOf(path: string) {
	return path.slice(0, path.lastIndexOf("/"));
}

test("the repository for a path, also for files and folders that do not exist yet", () => {
	const { api, web } = makeMonorepo();
	const cache = new Map<string, string | null>();
	assert.equal(repoForPath(join(api, "src", "new", "file.ts"), cache), repoRoot(api));
	assert.equal(repoForPath(join(web, "README.md"), cache), repoRoot(web));
	assert.equal(repoForPath(join(tmpdir(), "pi-modes-not-a-repo-xyz", "a.ts"), cache), undefined);
	assert.equal(cache.get(join(tmpdir()))?? null, null, "negative answers are cached too");
});

test("only repositories with uncommitted changes are reported dirty", async () => {
	const { api, web, nested } = makeMonorepo();
	writeFileSync(join(api, "new.ts"), "x\n");
	writeFileSync(join(nested, "README.md"), "changed\n");
	const dirty = await dirtyRepos([api, web, nested].map((dir) => repoRoot(dir)!));
	assert.deepEqual(dirty.sort(), [repoRoot(api)!, repoRoot(nested)!].sort());
});

test("scanning stops at the limit and reports how many were skipped", () => {
	const { mono } = makeMonorepo();
	const { repos, skipped } = findReposUnder(mono, 2);
	assert.equal(repos.length, 2);
	assert.equal(skipped, 1);
});

test("a patch labelled by repository starts every path with the repository folder", () => {
	const { mono, api, web } = makeMonorepo();
	writeFileSync(join(api, "orders.ts"), "export const total = 1;\n");
	writeFileSync(join(web, "cart.ts"), "import { total } from 'api';\n");
	const rootApi = repoRoot(api)!;
	const rootWeb = repoRoot(web)!;
	const baseApi = headTree(rootApi);
	const endApi = snapshotTree(rootApi)!;
	assert.equal(commonAncestor([rootApi, rootWeb]), realpathSync(mono));
	const workdir = commonAncestor([rootApi, rootWeb]);
	assert.equal(repoLabel(workdir, rootApi), "api");
	const numstat = labelNumstat(diffNumstat(rootApi, baseApi, endApi), repoLabel(workdir, rootApi));
	assert.match(numstat, /1\t0\tapi\/orders.ts/);
	const patch = diffPatch(rootApi, baseApi, endApi, "api");
	assert.match(patch, /diff --git a\/api\/orders.ts b\/api\/orders.ts/);
	assert.match(patch, /\+\+\+ b\/api\/orders.ts/);
});

test("directories a bash command moves into", () => {
	assert.deepEqual(commandDirs("cd web && npm run build", "/w"), ["/w/web"]);
	assert.deepEqual(commandDirs("cd /abs/api; git status", "/w"), ["/abs/api"]);
	assert.deepEqual(commandDirs("git -C ../other log", "/w/sub"), ["/w/sub/../other"]);
	assert.deepEqual(commandDirs('cd "my dir" && ls', "/w"), ["/w/my dir"]);
	assert.deepEqual(commandDirs("(cd a && make) && cd b", "/w"), ["/w/a", "/w/b"]);
	assert.deepEqual(commandDirs("cd $HOME/x && ls", "/w"), [], "variables are never guessed");
	assert.deepEqual(commandDirs("echo cd nope", "/w"), [], "only a real cd command");
});
