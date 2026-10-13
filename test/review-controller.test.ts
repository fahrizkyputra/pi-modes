import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_RISKY_PATTERNS, type ReviewEffort, parseNumstat } from "../src/review.ts";
import { type ReviewHost, ReviewController } from "../src/review-controller.ts";

/** A fake repository: trees are names, diffs are scripted per (from, to). */
function fakeHost(options: { verdicts?: string[]; fail?: string } = {}) {
	let tree = "t0";
	const diffs = new Map<string, string>();
	const reviews: { userText: string; effort: ReviewEffort }[] = [];
	const verdicts = [...(options.verdicts ?? [])];
	const host: ReviewHost = {
		snapshot: () => tree,
		headTree: () => "head",
		diff: (from, to) => {
			const numstat = diffs.get(`${from}>${to}`);
			if (numstat === undefined) return from === to ? { stats: parseNumstat("", DEFAULT_RISKY_PATTERNS), patch: "" } : undefined;
			return { stats: parseNumstat(numstat, DEFAULT_RISKY_PATTERNS), patch: `patch ${from}>${to}` };
		},
		modelRef: () => "9router/cc/claude-opus-5-5",
		runReviewer: async (userText, effort) => {
			reviews.push({ userText, effort });
			if (options.fail) return { text: "", ok: false, error: options.fail, costUsd: 0, durationMs: 1 };
			return { text: verdicts.shift() ?? '{"findings":[]}', ok: true, costUsd: 0.1, durationMs: 1000 };
		},
	};
	return {
		host,
		reviews,
		setTree: (next: string) => {
			tree = next;
		},
		setDiff: (from: string, to: string, numstat: string) => diffs.set(`${from}>${to}`, numstat),
	};
}

const MAJOR = '{"findings":[{"severity":"major","file":"m.ts","line":3,"title":"counter in memory"}]}';
const MINOR = '{"findings":[{"severity":"minor","title":"no header"}]}';

test("auto-review off: the task is recorded for /review but not reviewed", async () => {
	const fake = fakeHost();
	const review = new ReviewController(fake.host);
	review.onUserPrompt("add a feature");
	fake.setTree("t1");
	fake.setDiff("t0", "t1", "30\t0\tsrc/a.ts");
	const outcome = await review.atSettle(false, "done");
	assert.deepEqual(outcome.record, { request: "add a feature", base: "t0", sessionBase: "t0" });
	assert.equal(outcome.details, undefined);
	assert.equal(fake.reviews.length, 0);
});

test("no file change: nothing recorded, nothing reviewed", async () => {
	const fake = fakeHost();
	const review = new ReviewController(fake.host);
	review.onUserPrompt("what does this do?");
	assert.deepEqual(await review.atSettle(true, "it does x"), {});
	assert.equal(fake.reviews.length, 0);
});

test("a small, safe change is not reviewed automatically", async () => {
	const fake = fakeHost();
	const review = new ReviewController(fake.host);
	review.onUserPrompt("fix typo");
	fake.setTree("t1");
	fake.setDiff("t0", "t1", "1\t1\tREADME.md");
	const outcome = await review.atSettle(true, "fixed");
	assert.ok(outcome.record);
	assert.equal(fake.reviews.length, 0);
});

test("major finding: sent to fix, the fix diff gets one re-review, then the task is done", async () => {
	const fake = fakeHost({ verdicts: [MAJOR, MAJOR] });
	const review = new ReviewController(fake.host);
	review.onUserPrompt("add rate limit to login");
	fake.setTree("t1");
	fake.setDiff("t0", "t1", "40\t2\tsrc/auth/login.ts");

	const first = await review.atSettle(true, "added limiter");
	assert.equal(first.details?.action, "sent-to-fix");
	assert.equal(first.effort, "xhigh", "auth path → xhigh");
	assert.match(first.fix ?? "", /counter in memory/);
	assert.match(fake.reviews[0]?.userText ?? "", /add rate limit to login/);
	assert.match(fake.reviews[0]?.userText ?? "", /patch t0>t1/);
	assert.equal(review.isAwaitingFix(), true);

	// The fix run settles: only the fix diff is reviewed.
	fake.setTree("t2");
	fake.setDiff("t1", "t2", "5\t1\tsrc/middleware/limit.ts");
	const second = await review.atSettle(true, "moved the counter");
	assert.equal(second.details?.round, 2);
	assert.equal(second.details?.action, "unresolved", "still major after the re-review: reported, not sent again");
	assert.equal(second.fix, undefined);
	assert.match(fake.reviews[1]?.userText ?? "", /RE-REVIEW/);
	assert.match(fake.reviews[1]?.userText ?? "", /patch t1>t2/);
	assert.equal(second.effort, "high", "fix diff is small and not risky");

	// The task is done: another settle does nothing.
	assert.deepEqual(await review.atSettle(true, "x"), {});
	assert.equal(fake.reviews.length, 2);
});

test("minor-only findings are reported but not sent to fix", async () => {
	const fake = fakeHost({ verdicts: [MINOR] });
	const review = new ReviewController(fake.host);
	review.onUserPrompt("refactor");
	fake.setTree("t1");
	fake.setDiff("t0", "t1", "25\t5\tsrc/a.ts");
	const outcome = await review.atSettle(true, "done");
	assert.equal(outcome.details?.action, "none-blocking");
	assert.equal(outcome.fix, undefined);
	assert.equal(review.isAwaitingFix(), false);
});

test("the agent changed nothing for the findings: no re-review", async () => {
	const fake = fakeHost({ verdicts: [MAJOR] });
	const review = new ReviewController(fake.host);
	review.onUserPrompt("change");
	fake.setTree("t1");
	fake.setDiff("t0", "t1", "30\t0\tsrc/a.ts");
	await review.atSettle(true, "done");
	const outcome = await review.atSettle(true, "I think the finding is wrong because ...");
	assert.match(outcome.notice?.text ?? "", /changed no files/);
	assert.equal(fake.reviews.length, 1);
});

test("a failing reviewer gives a warning and never blocks", async () => {
	const fake = fakeHost({ fail: "429 rate limit" });
	const review = new ReviewController(fake.host);
	review.onUserPrompt("change");
	fake.setTree("t1");
	fake.setDiff("t0", "t1", "30\t0\tsrc/a.ts");
	const outcome = await review.atSettle(true, "done");
	assert.equal(outcome.details, undefined);
	assert.equal(outcome.fix, undefined);
	assert.equal(outcome.notice?.level, "warning");
	assert.match(outcome.notice?.text ?? "", /429 rate limit/);
});

test("an aborted run drops a pending re-review", async () => {
	const fake = fakeHost({ verdicts: [MAJOR] });
	const review = new ReviewController(fake.host);
	review.onUserPrompt("change");
	fake.setTree("t1");
	fake.setDiff("t0", "t1", "30\t0\tsrc/a.ts");
	await review.atSettle(true, "done");
	review.onRunInterrupted();
	assert.equal(review.isAwaitingFix(), false);
	assert.deepEqual(await review.atSettle(true, "x"), {});
});

test("an extension prompt (auto-resume) continues the open task instead of starting a new one", async () => {
	const fake = fakeHost({ verdicts: [MINOR] });
	const review = new ReviewController(fake.host);
	review.onUserPrompt("big feature");
	fake.setTree("t1");
	// Rate limited mid-task: the run errors, files already changed.
	review.onRunInterrupted();
	assert.deepEqual(review.takeInterruptedRecord(), { request: "big feature", base: "t0", sessionBase: "t0" });
	// auto-resume sends "continue": the base stays t0.
	review.onUserPrompt("continue", true);
	fake.setTree("t2");
	fake.setDiff("t0", "t2", "60\t0\tsrc/feature.ts");
	const outcome = await review.atSettle(true, "finished");
	assert.equal(outcome.details?.lines, 60, "the review covers the whole task");
	assert.match(fake.reviews[0]?.userText ?? "", /big feature/);
});

test("/review: last task, whole session, or uncommitted", async () => {
	const fake = fakeHost({ verdicts: [MINOR, MINOR, MINOR] });
	const review = new ReviewController(fake.host);

	assert.match((await review.manual("task", undefined)).notice?.text ?? "", /No task with file changes/);

	review.onUserPrompt("first task");
	fake.setTree("t1");
	await review.atSettle(false, "one");
	review.onUserPrompt("second task");
	fake.setTree("t2");
	await review.atSettle(false, "two");

	fake.setDiff("t1", "t2", "3\t0\tsrc/b.ts");
	const task = await review.manual("task", "two");
	assert.equal(task.details?.scope, "task");
	assert.match(fake.reviews[0]?.userText ?? "", /second task/);
	assert.match(fake.reviews[0]?.userText ?? "", /patch t1>t2/);
	assert.equal(task.effort, "high", "manual review runs regardless of size");

	fake.setDiff("t0", "t2", "8\t0\tsrc/a.ts\n3\t0\tsrc/b.ts");
	const session = await review.manual("session", "two");
	assert.equal(session.details?.files, 2);
	assert.match(fake.reviews[1]?.userText ?? "", /patch t0>t2/);

	fake.setDiff("head", "t2", "9\t0\tsrc/a.ts");
	const uncommitted = await review.manual("uncommitted", undefined);
	assert.equal(uncommitted.details?.scope, "uncommitted");
	assert.match(fake.reviews[2]?.userText ?? "", /patch head>t2/);
});

test("/review with findings: the fix gets one re-review", async () => {
	const fake = fakeHost({ verdicts: [MAJOR, '{"findings":[]}'] });
	const review = new ReviewController(fake.host);
	review.onUserPrompt("task");
	fake.setTree("t1");
	await review.atSettle(false, "done");
	fake.setDiff("t0", "t1", "3\t0\tsrc/a.ts");
	const manual = await review.manual("task", "done");
	assert.ok(manual.fix);
	// The fix run arrives as an extension message: it must not reset the pending re-review.
	review.onUserPrompt(manual.fix, true);
	fake.setTree("t2");
	fake.setDiff("t1", "t2", "2\t1\tsrc/a.ts");
	const again = await review.atSettle(false, "fixed");
	assert.equal(again.details?.round, 2);
	assert.equal(again.details?.action, "clean");
});

test("/review after reload uses the restored task", async () => {
	const fake = fakeHost({ verdicts: [MINOR] });
	const review = new ReviewController(fake.host);
	review.restore({ request: "old task", base: "t0", sessionBase: "t0" });
	fake.setTree("t5");
	fake.setDiff("t0", "t5", "4\t0\tsrc/a.ts");
	const outcome = await review.manual("task", undefined);
	assert.match(fake.reviews[0]?.userText ?? "", /old task/);
	assert.equal(outcome.details?.files, 1);
});

test("/review when the snapshot was pruned suggests uncommitted", async () => {
	const fake = fakeHost();
	const review = new ReviewController(fake.host);
	review.restore({ request: "old", base: "gone" });
	fake.setTree("t9");
	const outcome = await review.manual("task", undefined);
	assert.match(outcome.notice?.text ?? "", /no longer available/);
});
