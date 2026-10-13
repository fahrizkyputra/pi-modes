import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { TOOL_HARD_CAP } from "../src/review.ts";
import { runReviewer } from "../src/reviewer.ts";

function setup(responses: Parameters<ReturnType<typeof createFauxCore>["setResponses"]>[0]) {
	const faux = createFauxCore({ provider: "faux", models: [{ id: "reviewer", reasoning: true }] });
	faux.setResponses(responses);
	const requests: { messages: unknown[]; reasoning?: unknown }[] = [];
	const access = {
		streamSimple: (model: never, context: never, options?: Record<string, unknown>) => {
			requests.push({ messages: (context as { messages: unknown[] }).messages, reasoning: options?.reasoning });
			return faux.streamSimple(model, context, options as never);
		},
	};
	const dir = mkdtempSync(join(tmpdir(), "pi-modes-reviewer-"));
	writeFileSync(join(dir, "limit.ts"), "export const counter = new Map(); // in memory\n");
	return { faux, access, requests, dir, model: faux.getModel() };
}

test("the reviewer reads files with read-only tools and returns its final answer", async () => {
	const verdict = '```json\n{"findings":[{"severity":"major","file":"limit.ts","line":1,"title":"counter in memory"}]}\n```';
	const { access, requests, dir, model } = setup([
		fauxAssistantMessage(fauxToolCall("read", { path: "limit.ts" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxText(verdict)),
	]);
	const progress: number[] = [];
	const result = await runReviewer({
		model: model as never,
		effort: "xhigh",
		cwd: dir,
		userText: "Review this diff",
		access: access as never,
		signal: new AbortController().signal,
		timeoutMs: 10_000,
		onProgress: (count) => progress.push(count),
	});
	assert.equal(result.ok, true, result.error);
	assert.equal(result.text, verdict);
	assert.equal(result.toolCalls, 1);
	assert.deepEqual(progress, [1]);
	assert.equal(requests[0]?.reasoning, "xhigh", "the review runs at the chosen effort");
	const second = JSON.stringify(requests[1]?.messages);
	assert.match(second, /counter = new Map/, "the read result reached the reviewer");
	const first = JSON.stringify(requests[0]?.messages);
	assert.match(first, /independent senior code reviewer/, "fresh context with the reviewer system prompt");
	assert.match(first, /Review this diff/);
});

test("the reviewer has no write, edit, or bash tool", async () => {
	const { access, dir, model } = setup([
		fauxAssistantMessage(fauxToolCall("write", { path: "limit.ts", content: "hacked" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("bash", { command: "rm limit.ts" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxText('{"findings":[]}')),
	]);
	const result = await runReviewer({
		model: model as never,
		effort: "high",
		cwd: dir,
		userText: "Review",
		access: access as never,
		signal: new AbortController().signal,
		timeoutMs: 10_000,
	});
	assert.equal(result.ok, true);
	assert.match(readFileSync(join(dir, "limit.ts"), "utf8"), /in memory/, "the file is untouched");
});

test("a provider error comes back as ok: false, never a throw", async () => {
	const { access, dir, model } = setup([fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit" })]);
	const result = await runReviewer({
		model: model as never,
		effort: "high",
		cwd: dir,
		userText: "Review",
		access: access as never,
		signal: new AbortController().signal,
		timeoutMs: 10_000,
	});
	assert.equal(result.ok, false);
	assert.match(result.error ?? "", /429/);
});

test("cancel and timeout stop the reviewer", async () => {
	const slow = async () => {
		await new Promise((resolve) => setTimeout(resolve, 2000));
		return fauxAssistantMessage("late");
	};
	{
		const { access, dir, model } = setup([slow]);
		const abort = new AbortController();
		setTimeout(() => abort.abort(), 50);
		const result = await runReviewer({ model: model as never, effort: "high", cwd: dir, userText: "x", access: access as never, signal: abort.signal, timeoutMs: 10_000 });
		assert.equal(result.ok, false);
		assert.equal(result.error, "cancelled");
	}
	{
		const { access, dir, model } = setup([slow]);
		const result = await runReviewer({ model: model as never, effort: "high", cwd: dir, userText: "x", access: access as never, signal: new AbortController().signal, timeoutMs: 50 });
		assert.equal(result.ok, false);
		assert.equal(result.error, "timed out");
	}
});

test("tool calls past the hard cap are blocked so the reviewer must answer", async () => {
	const calls = Array.from({ length: TOOL_HARD_CAP + 2 }, () =>
		fauxAssistantMessage(fauxToolCall("ls", { path: "." }), { stopReason: "toolUse" }),
	);
	const { access, requests, dir, model } = setup([...calls, fauxAssistantMessage(fauxText('{"findings":[]}'))]);
	const result = await runReviewer({ model: model as never, effort: "high", cwd: dir, userText: "x", access: access as never, signal: new AbortController().signal, timeoutMs: 20_000 });
	assert.equal(result.ok, true);
	const last = JSON.stringify(requests.at(-1)?.messages);
	assert.match(last, /Tool budget used up/);
	assert.match(JSON.stringify(requests.map((request) => request.messages)), /Finish the review now/, "soft cap nudge sent");
});
