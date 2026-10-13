import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	DEFAULT_REVIEW_MODEL,
	DEFAULT_RISKY_PATTERNS,
	type DiffStats,
	type ReportDetails,
	blockingFindings,
	decideAction,
	fixPrompt,
	parseNumstat,
	parseReviewerReply,
	pickEffort,
	reportExpanded,
	reportText,
	reviewConfig,
	reviewModelRef,
	reviewerUserText,
	riskyPatterns,
	shouldAutoReview,
	truncatePatch,
	writeReviewModel,
} from "../src/review.ts";

const stats = (files: [string, number, number][]): DiffStats =>
	parseNumstat(files.map(([path, added, deleted]) => `${added}\t${deleted}\t${path}`).join("\n"), DEFAULT_RISKY_PATTERNS);

test("numstat parsing counts lines, binary files, and risky paths", () => {
	const parsed = parseNumstat("10\t2\tsrc/a.ts\n-\t-\tlogo.png\n3\t0\tsrc/auth/login.ts\n", DEFAULT_RISKY_PATTERNS);
	assert.equal(parsed.files.length, 3);
	assert.equal(parsed.lines, 15);
	assert.deepEqual(parsed.files[1], { path: "logo.png", added: 0, deleted: 0, binary: true });
	assert.deepEqual(parsed.riskyFiles, ["src/auth/login.ts"]);
});

test("automatic review: more than 20 lines, or any risky path", () => {
	assert.equal(shouldAutoReview(stats([])), false);
	assert.equal(shouldAutoReview(stats([["README.md", 15, 5]])), false, "exactly 20 lines is skipped");
	assert.equal(shouldAutoReview(stats([["README.md", 16, 5]])), true);
	assert.equal(shouldAutoReview(stats([["config/.env.example", 1, 0]])), true, "risky path at any size");
	assert.equal(shouldAutoReview(stats([["db/001_init.sql", 1, 0]])), true);
});

test("effort: high by default, xhigh for risky paths, many files, or many lines", () => {
	assert.equal(pickEffort(stats([["src/a.ts", 30, 0]])).effort, "high");
	assert.equal(pickEffort(stats([["src/payment/charge.ts", 2, 0]])).effort, "xhigh");
	assert.match(pickEffort(stats([["src/payment/charge.ts", 2, 0]])).reason, /risky path/);
	const eleven = Array.from({ length: 11 }, (_, index): [string, number, number] => [`src/f${index}.ts`, 1, 0]);
	assert.equal(pickEffort(stats(eleven)).effort, "xhigh");
	assert.equal(pickEffort(stats([["src/big.ts", 401, 0]])).effort, "xhigh");
	assert.equal(pickEffort(stats([["src/big.ts", 400, 0]])).effort, "high");
});

test("config: default model, custom model and extra risky paths", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-modes-review-config-"));
	const path = join(dir, "pi-modes.json");
	assert.equal(reviewModelRef(reviewConfig(path)), DEFAULT_REVIEW_MODEL);
	writeFileSync(path, JSON.stringify({ autoEffort: { judgeModel: "a/b" }, autoReview: { riskyPaths: ["kyc"] } }));
	assert.ok(riskyPatterns(reviewConfig(path)).includes("kyc"));
	writeReviewModel("9router/cc/claude-sonnet-5-5", path);
	const saved = JSON.parse(readFileSync(path, "utf8"));
	assert.equal(saved.autoReview.model, "9router/cc/claude-sonnet-5-5");
	assert.deepEqual(saved.autoReview.riskyPaths, ["kyc"], "other review settings kept");
	assert.equal(saved.autoEffort.judgeModel, "a/b", "auto-effort settings kept");
	assert.equal(reviewModelRef({ model: "not a ref" }), DEFAULT_REVIEW_MODEL);
});

test("the reviewer prompt carries the request, files, diff, and previous findings on a re-review", () => {
	const text = reviewerUserText({
		round: 1,
		scope: "task",
		request: "add rate limit to /login",
		agentSummary: "Added a limiter.",
		stats: stats([["src/auth/login.ts", 5, 1]]),
		patch: "diff --git a/src/auth/login.ts b/src/auth/login.ts\n+limit()",
	});
	assert.match(text, /add rate limit to \/login/);
	assert.match(text, /src\/auth\/login.ts \(\+5 −1\)/);
	assert.match(text, /\+limit\(\)/);
	assert.match(text, /may be wrong/);

	const again = reviewerUserText({
		round: 2,
		scope: "task",
		request: "add rate limit",
		stats: stats([["src/a.ts", 1, 0]]),
		patch: "+fix",
		previous: [{ severity: "major", file: "src/a.ts", line: 3, title: "counter in memory" }],
	});
	assert.match(again, /RE-REVIEW/);
	assert.match(again, /\[major\] src\/a.ts:3 — counter in memory/);
});

test("long patches are truncated with a note", () => {
	const { patch, truncated } = truncatePatch("x".repeat(50), 10);
	assert.equal(truncated, true);
	assert.match(patch, /truncated at 10/);
	assert.equal(truncatePatch("short").truncated, false);
});

test("parsing the reviewer's JSON verdict", () => {
	const reply = [
		"I read login.ts and the middleware.",
		"```json",
		'{"findings":[{"severity":"minor","file":"a.ts","line":"9","title":"no Retry-After"},{"severity":"MAJOR","file":"m.ts","line":18,"title":"counter in memory","detail":"two instances","fix":"use redis"},{"severity":"nit","title":"ignored"}],"checked":["bypass"]}',
		"```",
	].join("\n");
	const parsed = parseReviewerReply(reply);
	assert.ok(parsed);
	assert.deepEqual(
		parsed.findings.map((finding) => [finding.severity, finding.line]),
		[
			["major", 18],
			["minor", 9],
		],
		"sorted by severity, invalid severities dropped, string line numbers read",
	);
	assert.deepEqual(parsed.checked, ["bypass"]);
	assert.deepEqual(parseReviewerReply('{"findings":[]}')?.findings, []);
	assert.equal(parseReviewerReply("looks fine to me"), undefined);
});

test("action per round: fix once, then report as unresolved", () => {
	const major = [{ severity: "major" as const, title: "x" }];
	const minor = [{ severity: "minor" as const, title: "y" }];
	assert.equal(decideAction(1, major), "sent-to-fix");
	assert.equal(decideAction(2, major), "unresolved");
	assert.equal(decideAction(1, minor), "none-blocking");
	assert.equal(decideAction(1, []), "clean");
	assert.equal(decideAction(1, undefined), "unparsed");
	assert.deepEqual(blockingFindings([...major, ...minor]), major);
});

test("the fix prompt lists only what to fix and allows pushing back", () => {
	const prompt = fixPrompt([{ severity: "critical", file: "a.ts", line: 1, title: "sql injection", fix: "use params" }], "opus-5-5");
	assert.match(prompt, /opus-5-5/);
	assert.match(prompt, /\[critical\] a.ts:1 — sql injection/);
	assert.match(prompt, /Suggested fix: use params/);
	assert.match(prompt, /If you are sure a finding is wrong/);
	assert.match(prompt, /Leave minor findings/);
});

test("report text: compact by default, details when expanded", () => {
	const details: ReportDetails = {
		round: 1,
		scope: "task",
		model: "9router/cc/claude-opus-5-5",
		effort: "xhigh",
		effortReason: "risky path: src/auth/login.ts",
		files: 2,
		lines: 40,
		findings: [
			{ severity: "major", file: "m.ts", line: 18, title: "counter in memory", detail: "two instances", fix: "use redis" },
			{ severity: "minor", file: "a.ts", line: 42, title: "no Retry-After" },
		],
		checked: ["bypass"],
		action: "sent-to-fix",
		costUsd: 0.42,
		durationMs: 61_000,
		raw: "...",
	};
	assert.equal(
		reportText(details),
		[
			"🔍 Review (opus-5-5 · xhigh) — 1 major, 1 minor",
			"[major] m.ts:18 — counter in memory",
			"[minor] a.ts:42 — no Retry-After",
			"→ critical/major sent to the agent to fix; the fix gets one re-review",
		].join("\n"),
	);
	const expanded = reportExpanded(details);
	assert.match(expanded, /effort xhigh \(risky path/);
	assert.match(expanded, /61s · \$0.42/);
	assert.match(expanded, /why: two instances/);
	assert.match(expanded, /Checked and fine: bypass/);
	assert.match(reportText({ ...details, round: 2, findings: [], action: "clean" }), /^🔍 Re-review .* — no issues found\n→ nothing to fix$/);
});
