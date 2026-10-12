import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	AutoEffortController,
	DEFAULT_JUDGE_MODEL,
	type ThinkingLevel,
	decideEffort,
	judgeModelRef,
	judgeUserText,
	parseJudgeReply,
	readConfig,
	splitModelRef,
	writeJudgeModel,
} from "../src/effort.ts";

test("parseJudgeReply reads JSON, fenced JSON, and a bare level", () => {
	assert.deepEqual(parseJudgeReply('{"level":"xhigh","reason":"multi-file refactor"}'), { level: "xhigh", reason: "multi-file refactor" });
	assert.deepEqual(parseJudgeReply('```json\n{"level": "MEDIUM", "reason": "rename"}\n```'), { level: "medium", reason: "rename" });
	assert.deepEqual(parseJudgeReply("high"), { level: "high", reason: "" });
	assert.equal(parseJudgeReply('{"level":"max"}'), undefined, "levels outside medium..xhigh are rejected");
	assert.equal(parseJudgeReply("I think this is hard"), undefined);
	assert.equal(parseJudgeReply(""), undefined);
});

test("judgeUserText includes the tail of the previous answer only when there is one", () => {
	const withContext = judgeUserText("lanjut", `${"x".repeat(900)}END`);
	assert.match(withContext, /<previous_answer>/);
	assert.match(withContext, /END/);
	assert.ok(withContext.length < 700, "previous answer is cut to its tail");
	assert.doesNotMatch(judgeUserText("rename foo", undefined), /previous_answer/);
	assert.match(judgeUserText("   ", undefined), /only attachments/);
});

test("decideEffort returns the judge's level", async () => {
	const decision = await decideEffort("refactor all", undefined, async () => '{"level":"xhigh","reason":"big refactor"}');
	assert.deepEqual(decision, { level: "xhigh", reason: "big refactor", fallback: false });
});

test("decideEffort falls back to high on error, timeout, and unreadable replies", async () => {
	const failed = await decideEffort("x", undefined, async () => {
		throw new Error("401 unauthorized");
	});
	assert.deepEqual(failed, { level: "high", reason: "401 unauthorized", fallback: true });

	let aborted = false;
	const slow = await decideEffort(
		"x",
		undefined,
		(_system, _user, signal) =>
			new Promise((resolve) => {
				signal.addEventListener("abort", () => {
					aborted = true;
				});
				setTimeout(() => resolve('{"level":"medium"}'), 200);
			}),
		20,
	);
	assert.equal(slow.level, "high");
	assert.equal(slow.fallback, true);
	assert.equal(slow.reason, "timeout");
	assert.equal(aborted, true, "the judge request is aborted on timeout");

	const garbage = await decideEffort("x", undefined, async () => "no idea");
	assert.equal(garbage.fallback, true);
	assert.equal(garbage.level, "high");
});

test("splitModelRef and judgeModelRef", () => {
	assert.deepEqual(splitModelRef("9router/cc/claude-haiku-5-5"), { provider: "9router", id: "cc/claude-haiku-5-5" });
	assert.equal(splitModelRef("haiku"), undefined);
	assert.equal(splitModelRef("/x"), undefined);
	assert.equal(judgeModelRef({}), DEFAULT_JUDGE_MODEL);
	assert.equal(judgeModelRef({ autoEffort: { judgeModel: "anthropic/claude-haiku-5-5" } }), "anthropic/claude-haiku-5-5");
	assert.equal(judgeModelRef({ autoEffort: { judgeModel: "bad" } }), DEFAULT_JUDGE_MODEL);
});

test("writeJudgeModel keeps other config keys", () => {
	const path = join(mkdtempSync(join(tmpdir(), "pi-modes-config-")), "pi-modes.json");
	writeFileSync(path, JSON.stringify({ other: 1 }));
	writeJudgeModel("anthropic/claude-haiku-5-5", path);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { other: 1, autoEffort: { judgeModel: "anthropic/claude-haiku-5-5" } });
	assert.equal(judgeModelRef(readConfig(path)), "anthropic/claude-haiku-5-5");
	assert.deepEqual(readConfig(join(tmpdir(), "does-not-exist-pi-modes.json")), {});
});

function fakeLevel(initial: ThinkingLevel, clampTo?: ThinkingLevel) {
	let level = initial;
	const changes: ThinkingLevel[] = [];
	return {
		set: (next: ThinkingLevel) => {
			level = clampTo ?? next;
			changes.push(level);
		},
		get: () => level,
		changes,
	};
}

test("controller: on remembers the level, off returns it", () => {
	const effort = new AutoEffortController();
	effort.turnOn("xhigh");
	assert.equal(effort.isActive(), true);
	assert.equal(effort.getRestoreLevel(), "xhigh");
	assert.equal(effort.statusText(), "🧠 auto");
	assert.equal(effort.workingText(), undefined);

	const level = fakeLevel("xhigh");
	assert.equal(effort.apply({ level: "medium", reason: "", fallback: false }, level.set, level.get), "medium");
	assert.equal(effort.statusText(), "🧠 auto→medium");
	assert.equal(effort.workingText(), "🧠 medium");

	assert.equal(effort.turnOff(), "xhigh");
	assert.equal(effort.isActive(), false);
	assert.equal(effort.statusText(), undefined);
});

test("controller: its own changes never pause it, a manual change does", () => {
	const effort = new AutoEffortController();
	effort.turnOn("high");
	const level = fakeLevel("high");
	let paused: boolean | undefined;
	effort.apply({ level: "xhigh", reason: "", fallback: false }, (next) => {
		level.set(next);
		// Pi emits thinking_level_select while setThinkingLevel runs.
		paused = effort.onLevelSelected(next, false);
	}, level.get);
	assert.equal(paused, false);
	assert.equal(effort.onLevelSelected("xhigh", false), false, "the level it applied is not manual");

	assert.equal(effort.onLevelSelected("low", false), true, "user picked a level");
	assert.equal(effort.isActive(), false);
	assert.equal(effort.getRestoreLevel(), undefined, "the user's level is kept, nothing to restore");
});

test("controller: a model switch re-clamping the level does not pause it", () => {
	const effort = new AutoEffortController();
	effort.turnOn("high");
	const level = fakeLevel("high");
	effort.apply({ level: "xhigh", reason: "", fallback: false }, level.set, level.get);
	assert.equal(effort.onLevelSelected("high", true), false);
	assert.equal(effort.isActive(), true);
	assert.equal(effort.workingText(), "🧠 high");
	assert.equal(effort.onLevelSelected("high", false), false, "the clamped level now counts as applied");
});

test("controller: the effective (clamped) level is what it reports", () => {
	const effort = new AutoEffortController();
	effort.turnOn("high");
	const level = fakeLevel("high", "high");
	assert.equal(effort.apply({ level: "xhigh", reason: "", fallback: false }, level.set, level.get), "high");
	assert.equal(effort.statusText(), "🧠 auto→high");
});

test("controller: restore() brings back a session without touching the level", () => {
	const effort = new AutoEffortController();
	effort.restore(true, "medium");
	assert.equal(effort.isActive(), true);
	assert.equal(effort.turnOff(), "medium");
	effort.restore(false, undefined);
	assert.equal(effort.isActive(), false);
	assert.equal(effort.onLevelSelected("low", false), false, "inactive never pauses");
});
