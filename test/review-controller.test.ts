import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_RISKY_PATTERNS, type ReviewEffort, parseNumstat } from "../src/review.ts";
import { type ReviewHost, ReviewController } from "../src/review-controller.ts";

/**
 * A fake set of repositories. A snapshot is a name per repository ("t0", "t1", ...);
 * diffs are scripted per (repository, from, to).
 */
function fakeHost(options: { verdicts?: string[]; fail?: string; dirty?: string[]; confirm?: boolean } = {}) {
	const questions: string[] = [];
	const trees = new Map<string, string>();
	const diffs = new Map<string, string>();
	const reviews: { userText: string; effort: ReviewEffort; workdir: string }[] = [];
	const verdicts = [...(options.verdicts ?? [])];
	const treeOf = (root: string) => trees.get(root) ?? "t0";
	const host: ReviewHost = {
		snapshot: (roots) => Object.fromEntries(roots.map((root) => [root, treeOf(root)])),
		headTrees: (roots) => Object.fromEntries(roots.map((root) => [root, "head"])),
		scanDirty: async () => ({ dirty: options.dirty ?? [], found: (options.dirty ?? []).length || 1 }),
		diff: (from, to) => {
			const repos = Object.keys(from).filter((root) => to[root] !== undefined);
			const lines: string[] = [];
			const patches: string[] = [];
			const changed: string[] = [];
			for (const root of repos) {
				if (from[root] === to[root]) continue;
				const numstat = diffs.get(`${root}:${from[root]}>${to[root]}`);
				if (numstat === undefined) return undefined;
				lines.push(numstat);
				patches.push(`patch ${root} ${from[root]}>${to[root]}`);
				changed.push(root);
			}
			return { stats: parseNumstat(lines.join("\n"), DEFAULT_RISKY_PATTERNS), patch: patches.join("\n"), repos: changed, workdir: "/work" };
		},
		modelRef: () => "9router/cc/claude-opus-5-5",
		confirm: async (question) => {
			questions.push(question);
			return options.confirm ?? true;
		},
		runReviewer: async (userText, effort, workdir) => {
			reviews.push({ userText, effort, workdir });
			if (options.fail) return { text: "", ok: false, error: options.fail, costUsd: 0, durationMs: 1 };
			return { text: verdicts.shift() ?? '{"findings":[]}', ok: true, costUsd: 0.1, durationMs: 1000 };
		},
	};
	return {
		host,
		reviews,
		questions,
		/** Move a repository to a new tree and script its diff from the previous one. */
		change: (root: string, next: string, numstat: string) => {
			diffs.set(`${root}:${treeOf(root)}>${next}`, numstat);
			trees.set(root, next);
		},
		script: (root: string, from: string, to: string, numstat: string) => diffs.set(`${root}:${from}>${to}`, numstat),
	};
}

const A = "/work/a";
const B = "/work/b";

const MAJOR = '{"findings":[{"severity":"major","file":"m.ts","line":3,"title":"counter in memory"}]}';
const MINOR = '{"findings":[{"severity":"minor","title":"no header"}]}';

test("auto-review off: the task is recorded for /review but not reviewed", async () => {
	const fake = fakeHost();
	const review = new ReviewController(fake.host);
	review.onUserPrompt("add a feature", false, [A]);
	fake.change(A, "t1", "30\t0\tsrc/a.ts");
	const outcome = await review.atSettle(false, "done");
	assert.deepEqual(outcome.record, { request: "add a feature", base: { [A]: "t0" }, sessionBase: { [A]: "t0" } });
	assert.equal(outcome.details, undefined);
	assert.equal(fake.reviews.length, 0);
});

test("no file change: nothing recorded, nothing reviewed", async () => {
	const fake = fakeHost();
	const review = new ReviewController(fake.host);
	review.onUserPrompt("what does this do?", false, [A]);
	assert.deepEqual(await review.atSettle(true, "it does x"), {});
	assert.equal(fake.reviews.length, 0);
});

test("a monorepo folder: no starting repository, repositories join as the agent touches them", async () => {
	const fake = fakeHost();
	const review = new ReviewController(fake.host);
	review.onUserPrompt("rename a field across api and web", false, []);
	assert.deepEqual(await review.atSettle(true, "x"), {}, "nothing touched yet → nothing to review");

	review.touch(A);
	fake.change(A, "t1", "30\t0\tapi/orders.ts");
	review.touch(B);
	fake.change(B, "t1", "5\t5\tweb/cart.ts");
	const outcome = await review.atSettle(false, "done");
	assert.deepEqual(outcome.record?.base, { [A]: "t0", [B]: "t0" });
});

test("a repository touched but left unchanged is not part of the diff", async () => {
	const fake = fakeHost({ verdicts: ['{"findings":[]}'] });
	const review = new ReviewController(fake.host);
	review.onUserPrompt("look around and fix one thing", false, []);
	review.touch(A);
	review.touch(B);
	fake.change(A, "t1", "30\t0\tsrc/a.ts");
	const outcome = await review.atSettle(true, "done");
	assert.deepEqual(outcome.details?.repos, undefined, "one changed repository → no repository list");
	assert.doesNotMatch(fake.reviews[0]?.userText ?? "", /b\b.*separate git repositories/);
});

test("one review across several repositories, with the list in the prompt and the report", async () => {
	const fake = fakeHost({ verdicts: [MINOR] });
	const review = new ReviewController(fake.host);
	review.onUserPrompt("rename total across api and web", false, []);
	review.touch(A);
	review.touch(B);
	fake.change(A, "t1", "12\t3\tapi/orders.ts");
	fake.change(B, "t1", "9\t2\tweb/cart.ts");
	const outcome = await review.atSettle(true, "done");
	assert.equal(fake.reviews.length, 1, "one reviewer run for both repositories");
	assert.equal(fake.reviews[0]?.workdir, "/work");
	assert.match(fake.reviews[0]?.userText ?? "", /spans 2 separate git repositories: \/work\/a, \/work\/b/);
	assert.match(fake.reviews[0]?.userText ?? "", /patch \/work\/a t0>t1/);
	assert.match(fake.reviews[0]?.userText ?? "", /patch \/work\/b t0>t1/);
	assert.deepEqual(outcome.details?.repos, [A, B]);
	assert.equal(outcome.details?.files, 2);
	assert.equal(outcome.details?.lines, 26);
});

test("a repository first touched by the fix joins the re-review", async () => {
	const fake = fakeHost({ verdicts: [MAJOR, '{"findings":[]}'] });
	const review = new ReviewController(fake.host);
	review.onUserPrompt("change api", false, []);
	review.touch(A);
	fake.change(A, "t1", "40\t2\tsrc/auth/login.ts");
	const first = await review.atSettle(true, "done");
	assert.equal(first.details?.action, "sent-to-fix");

	// The fix has to change the client in another repository too.
	review.touch(B);
	fake.change(A, "t2", "3\t1\tsrc/auth/login.ts");
	fake.change(B, "t1", "4\t0\tweb/client.ts");
	const second = await review.atSettle(true, "fixed in both");
	assert.equal(second.details?.round, 2);
	assert.deepEqual(second.details?.repos, [A, B]);
	assert.match(fake.reviews[1]?.userText ?? "", /patch \/work\/b t0>t1/);
	assert.match(fake.reviews[1]?.userText ?? "", /patch \/work\/a t1>t2/, "repository A only from the end of the first review");
});

test("a small, safe change is not reviewed automatically", async () => {
	const fake = fakeHost();
	const review = new ReviewController(fake.host);
	review.onUserPrompt("fix typo", false, [A]);
	fake.change(A, "t1", "1\t1\tREADME.md");
	const outcome = await review.atSettle(true, "fixed");
	assert.ok(outcome.record);
	assert.equal(fake.reviews.length, 0);
});

test("small changes in several repositories add up to a review", async () => {
	const fake = fakeHost({ verdicts: [MINOR] });
	const review = new ReviewController(fake.host);
	review.onUserPrompt("bump version everywhere", false, []);
	review.touch(A);
	review.touch(B);
	fake.change(A, "t1", "12\t0\tsrc/a.ts");
	fake.change(B, "t1", "12\t0\tsrc/b.ts");
	await review.atSettle(true, "done");
	assert.equal(fake.reviews.length, 1, "24 lines in total is over the 20-line threshold");
});

test("major finding: sent to fix, the fix diff gets one re-review, then the task is done", async () => {
	const fake = fakeHost({ verdicts: [MAJOR, MAJOR] });
	const review = new ReviewController(fake.host);
	review.onUserPrompt("add rate limit to login", false, [A]);
	fake.change(A, "t1", "40\t2\tsrc/auth/login.ts");

	const first = await review.atSettle(true, "added limiter");
	assert.equal(first.details?.action, "sent-to-fix");
	assert.equal(first.effort, "xhigh", "auth path → xhigh");
	assert.match(first.fix ?? "", /counter in memory/);
	assert.match(fake.reviews[0]?.userText ?? "", /add rate limit to login/);
	assert.match(fake.reviews[0]?.userText ?? "", /patch \/work\/a t0>t1/);
	assert.equal(review.isAwaitingFix(), true);

	fake.change(A, "t2", "5\t1\tsrc/middleware/limit.ts");
	const second = await review.atSettle(true, "moved the counter");
	assert.equal(second.details?.round, 2);
	assert.equal(second.details?.action, "unresolved", "still major after the re-review: reported, not sent again");
	assert.equal(second.fix, undefined);
	assert.match(fake.reviews[1]?.userText ?? "", /RE-REVIEW/);
	assert.match(fake.reviews[1]?.userText ?? "", /patch \/work\/a t1>t2/);
	assert.equal(second.effort, "high", "fix diff is small and not risky");

	assert.deepEqual(await review.atSettle(true, "x"), {}, "the task is done");
	assert.equal(fake.reviews.length, 2);
});

test("minor-only findings are reported but not sent to fix", async () => {
	const fake = fakeHost({ verdicts: [MINOR] });
	const review = new ReviewController(fake.host);
	review.onUserPrompt("refactor", false, [A]);
	fake.change(A, "t1", "25\t5\tsrc/a.ts");
	const outcome = await review.atSettle(true, "done");
	assert.equal(outcome.details?.action, "none-blocking");
	assert.equal(outcome.fix, undefined);
	assert.equal(review.isAwaitingFix(), false);
});

test("the agent changed nothing for the findings: no re-review", async () => {
	const fake = fakeHost({ verdicts: [MAJOR] });
	const review = new ReviewController(fake.host);
	review.onUserPrompt("change", false, [A]);
	fake.change(A, "t1", "30\t0\tsrc/a.ts");
	await review.atSettle(true, "done");
	const outcome = await review.atSettle(true, "I think the finding is wrong because ...");
	assert.match(outcome.notice?.text ?? "", /changed no files/);
	assert.equal(fake.reviews.length, 1);
});

test("a failing reviewer gives a warning and never blocks", async () => {
	const fake = fakeHost({ fail: "429 rate limit" });
	const review = new ReviewController(fake.host);
	review.onUserPrompt("change", false, [A]);
	fake.change(A, "t1", "30\t0\tsrc/a.ts");
	const outcome = await review.atSettle(true, "done");
	assert.equal(outcome.details, undefined);
	assert.equal(outcome.fix, undefined);
	assert.equal(outcome.notice?.level, "warning");
	assert.match(outcome.notice?.text ?? "", /429 rate limit/);
});

test("an aborted run drops a pending re-review", async () => {
	const fake = fakeHost({ verdicts: [MAJOR] });
	const review = new ReviewController(fake.host);
	review.onUserPrompt("change", false, [A]);
	fake.change(A, "t1", "30\t0\tsrc/a.ts");
	await review.atSettle(true, "done");
	review.onRunInterrupted();
	assert.equal(review.isAwaitingFix(), false);
	assert.deepEqual(await review.atSettle(true, "x"), {});
});

test("an extension prompt (auto-resume) continues the open task instead of starting a new one", async () => {
	const fake = fakeHost({ verdicts: [MINOR] });
	const review = new ReviewController(fake.host);
	review.onUserPrompt("big feature", false, []);
	review.touch(A);
	fake.change(A, "t1", "10\t0\tsrc/a.ts");
	review.onRunInterrupted();
	assert.deepEqual(review.takeInterruptedRecord()?.base, { [A]: "t0" });
	review.onUserPrompt("continue", true, [A]);
	review.touch(B);
	fake.change(A, "t2", "20\t0\tsrc/a.ts");
	fake.script(A, "t0", "t2", "30\t0\tsrc/a.ts");
	fake.change(B, "t1", "30\t0\tsrc/b.ts");
	const outcome = await review.atSettle(true, "finished");
	assert.equal(outcome.details?.lines, 60, "the review covers the whole task, both repositories");
	assert.match(fake.reviews[0]?.userText ?? "", /big feature/);
});

test("/review: last task, whole session, or uncommitted", async () => {
	const fake = fakeHost({ verdicts: [MINOR, MINOR, MINOR], dirty: [A, B] });
	const review = new ReviewController(fake.host);

	assert.match((await review.manual("task", undefined)).notice?.text ?? "", /No task with file changes/);

	review.onUserPrompt("first task", false, [A]);
	fake.change(A, "t1", "3\t0\tsrc/a.ts");
	await review.atSettle(false, "one");
	review.onUserPrompt("second task", false, [A]);
	fake.change(A, "t2", "3\t0\tsrc/b.ts");
	await review.atSettle(false, "two");

	fake.script(A, "t1", "t2", "3\t0\tsrc/b.ts");
	const task = await review.manual("task", "two");
	assert.equal(task.details?.scope, "task");
	assert.match(fake.reviews[0]?.userText ?? "", /second task/);
	assert.match(fake.reviews[0]?.userText ?? "", /patch \/work\/a t1>t2/);
	assert.equal(task.effort, "high", "manual review runs regardless of size");

	fake.script(A, "t0", "t2", "8\t0\tsrc/a.ts\n3\t0\tsrc/b.ts");
	const session = await review.manual("session", "two");
	assert.equal(session.details?.files, 2);
	assert.match(fake.reviews[1]?.userText ?? "", /patch \/work\/a t0>t2/);

	fake.script(A, "head", "t2", "9\t0\tsrc/a.ts");
	fake.script(B, "head", "t0", "2\t0\tsrc/b.ts");
	const uncommitted = await review.manual("uncommitted", undefined);
	assert.equal(uncommitted.details?.scope, "uncommitted");
	assert.deepEqual(uncommitted.details?.repos, [A, B]);
	assert.match(fake.reviews[2]?.userText ?? "", /2 repositories/);
});

test("/review uncommitted with nothing dirty or nothing found says so", async () => {
	const none = fakeHost({ dirty: [] });
	const review = new ReviewController(none.host);
	assert.match((await review.manual("uncommitted", undefined)).notice?.text ?? "", /No uncommitted changes in 1 repository/);

	const noRepos = fakeHost();
	noRepos.host.scanDirty = async () => ({ dirty: [], found: 0 });
	assert.match((await new ReviewController(noRepos.host).manual("uncommitted", undefined)).notice?.text ?? "", /needs a git repository/);
});

test("/review with findings: the fix gets one re-review", async () => {
	const fake = fakeHost({ verdicts: [MAJOR, '{"findings":[]}'] });
	const review = new ReviewController(fake.host);
	review.onUserPrompt("task", false, [A]);
	fake.change(A, "t1", "3\t0\tsrc/a.ts");
	await review.atSettle(false, "done");
	const manual = await review.manual("task", "done");
	assert.ok(manual.fix);
	review.onUserPrompt(manual.fix, true);
	fake.change(A, "t2", "2\t1\tsrc/a.ts");
	const again = await review.atSettle(false, "fixed");
	assert.equal(again.details?.round, 2);
	assert.equal(again.details?.action, "clean");
});

test("/review after reload uses the restored task", async () => {
	const fake = fakeHost({ verdicts: [MINOR] });
	const review = new ReviewController(fake.host);
	review.restore({ request: "old task", base: { [A]: "t0", [B]: "t0" }, sessionBase: { [A]: "t0", [B]: "t0" } });
	fake.change(A, "t5", "4\t0\tsrc/a.ts");
	fake.change(B, "t5", "1\t0\tsrc/b.ts");
	fake.script(A, "t0", "t5", "4\t0\tsrc/a.ts");
	fake.script(B, "t0", "t5", "1\t0\tsrc/b.ts");
	const outcome = await review.manual("task", undefined);
	assert.match(fake.reviews[0]?.userText ?? "", /old task/);
	assert.equal(outcome.details?.files, 2);
});

test("/review when a snapshot was pruned suggests uncommitted", async () => {
	const fake = fakeHost();
	const review = new ReviewController(fake.host);
	review.restore({ request: "old", base: { [A]: "gone" } });
	fake.change(A, "t9", "1\t0\tx.ts");
	const outcome = await review.manual("task", undefined);
	assert.match(outcome.notice?.text ?? "", /no longer available/);
});

test("/review uncommitted asks before reviewing more than three repositories", async () => {
	const roots = ["/work/a", "/work/b", "/work/c", "/work/d"];
	const approve = fakeHost({ verdicts: [MINOR], dirty: roots, confirm: true });
	for (const root of roots) approve.script(root, "head", "t0", "2\t0\tx.ts");
	const outcome = await new ReviewController(approve.host).manual("uncommitted", undefined);
	assert.equal(approve.questions.length, 1);
	assert.match(approve.questions[0] ?? "", /4 repositories/);
	assert.match(approve.questions[0] ?? "", /unrelated projects/);
	assert.equal(outcome.details?.repos?.length, 4);

	const decline = fakeHost({ verdicts: [MINOR], dirty: roots, confirm: false });
	for (const root of roots) decline.script(root, "head", "t0", "2\t0\tx.ts");
	const declined = await new ReviewController(decline.host).manual("uncommitted", undefined);
	assert.equal(decline.reviews.length, 0, "declined: the reviewer never runs");
	assert.match(declined.notice?.text ?? "", /Review skipped/);
});

test("/review uncommitted asks before a very large diff, but not for three small repositories", async () => {
	const big = fakeHost({ verdicts: [MINOR], dirty: [A] });
	big.script(A, "head", "t0", "4000\t0\tdump.sql");
	await new ReviewController(big.host).manual("uncommitted", undefined);
	assert.equal(big.questions.length, 1, "over 3000 lines");

	const small = fakeHost({ verdicts: [MINOR], dirty: ["/work/a", "/work/b", "/work/c"] });
	for (const root of ["/work/a", "/work/b", "/work/c"]) small.script(root, "head", "t0", "2\t0\tx.ts");
	await new ReviewController(small.host).manual("uncommitted", undefined);
	assert.equal(small.questions.length, 0, "three repositories is the limit");
});

test("/review task and session never ask, however many repositories the agent touched", async () => {
	const fake = fakeHost({ verdicts: [MINOR] });
	const review = new ReviewController(fake.host);
	const roots = ["/work/a", "/work/b", "/work/c", "/work/d", "/work/e"];
	review.onUserPrompt("wide change", false, []);
	for (const root of roots) {
		review.touch(root);
		fake.change(root, "t1", "3\t0\tx.ts");
	}
	await review.atSettle(false, "done");
	await review.manual("task", "done");
	assert.equal(fake.questions.length, 0);
	assert.equal(fake.reviews.length, 1);
});
