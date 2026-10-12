/**
 * Auto-effort wiring: the extension driven through fake Pi events, with a fake
 * thinking level and a fake judge model.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piModesExtension from "../extensions/pi-modes.ts";

type Handler = (event: any, ctx: any) => unknown;
type Level = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

interface FakeOptions {
	/** What the judge model answers; a function can throw or hang. */
	judge?: string | ((signal: AbortSignal) => Promise<string>);
	initialLevel?: Level;
	/** Levels the active model supports; others clamp to the highest below. */
	supported?: Level[];
	branch?: unknown[];
	judgeModelExists?: boolean;
}

const ORDER: Level[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function fakePi(options: FakeOptions = {}) {
	const hooks: Record<string, Handler[]> = {};
	const commands: Record<string, { handler: (args: string, ctx: any) => Promise<void> }> = {};
	const branch = options.branch ?? [];
	const entries: { customType: string; data: any }[] = [];
	const notices: string[] = [];
	const statuses: (string | undefined)[] = [];
	const workingMessages: (string | undefined)[] = [];
	const judgeCalls: { systemPrompt: string; userText: string; model: string }[] = [];
	let level: Level = options.initialLevel ?? "xhigh";
	let supported = options.supported ?? ORDER;
	let model = { provider: "9router", id: "cc/claude-opus-5-5" };
	const pending: Promise<unknown>[] = [];

	const clamp = (wanted: Level): Level => {
		if (supported.includes(wanted)) return wanted;
		const below = ORDER.slice(0, ORDER.indexOf(wanted)).reverse().find((candidate) => supported.includes(candidate));
		return below ?? supported[0] ?? "off";
	};

	const emitNow = async (name: string, event: Record<string, unknown> = {}) => {
		let result: unknown;
		for (const handler of hooks[name] ?? []) {
			const value = await handler({ type: name, ...event }, ctx);
			if (value !== undefined) result = value;
		}
		return result;
	};

	// Like Pi: setThinkingLevel emits thinking_level_select without awaiting it.
	const setLevel = (wanted: Level) => {
		const previousLevel = level;
		level = clamp(wanted);
		if (level !== previousLevel) pending.push(emitNow("thinking_level_select", { level, previousLevel }));
	};

	const pi = {
		on: (name: string, handler: Handler) => {
			hooks[name] = [...(hooks[name] ?? []), handler];
		},
		registerCommand: (name: string, definition: { handler: (args: string, ctx: any) => Promise<void> }) => {
			commands[name] = definition;
		},
		appendEntry: (customType: string, data: unknown) => {
			entries.push({ customType, data });
			branch.push({ type: "custom", customType, data });
		},
		setThinkingLevel: (wanted: Level) => setLevel(wanted),
		getThinkingLevel: () => level,
	} as unknown as ExtensionAPI;

	const judgeModel = { provider: "9router", id: "cc/claude-haiku-5-5" };
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: process.cwd(),
		get model() {
			return model;
		},
		modelRegistry: {
			find: (provider: string, id: string) =>
				options.judgeModelExists === false
					? undefined
					: provider === judgeModel.provider && id === judgeModel.id
						? judgeModel
						: provider === "anthropic" && id === "claude-haiku-5-5"
							? { provider, id }
							: undefined,
			streamSimple: (m: { provider: string; id: string }, context: any, streamOptions: { signal: AbortSignal }) => ({
				result: async () => {
					judgeCalls.push({ systemPrompt: context.systemPrompt, userText: context.messages[0].content[0].text, model: `${m.provider}/${m.id}` });
					const judge = options.judge ?? '{"level":"high","reason":"medium feature"}';
					const text = typeof judge === "string" ? judge : await judge(streamOptions.signal);
					return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
				},
			}),
		},
		ui: {
			notify: (message: string) => notices.push(message),
			setStatus: (_key: string, text: string | undefined) => statuses.push(text),
			setWorkingMessage: (text?: string) => workingMessages.push(text),
			confirm: async () => true,
		},
		sessionManager: { getBranch: () => branch },
	};

	const emit = async (name: string, event: Record<string, unknown> = {}) => {
		const result = await emitNow(name, event);
		await Promise.all(pending.splice(0));
		return result;
	};

	/** A prompt the user typed while idle: input, then before_agent_start. */
	const userPrompt = async (prompt: string, source = "interactive", streamingBehavior?: "steer" | "followUp") => {
		await emit("input", { text: prompt, source, streamingBehavior });
		await emit("before_agent_start", { prompt, systemPromptOptions: { sections: {}, cwd: "/tmp" } });
	};

	/** The user picking a level, like Shift+Tab or /thinking. */
	const userSetsLevel = async (wanted: Level) => {
		setLevel(wanted);
		await Promise.all(pending.splice(0));
	};

	/** The user switching models; Pi re-clamps the level, then emits model_select. */
	const switchModel = async (next: { provider: string; id: string }, nextSupported: Level[]) => {
		const previousModel = model;
		model = next;
		supported = nextSupported;
		setLevel(level);
		pending.push(emitNow("model_select", { model: next, previousModel, source: "set" }));
		await Promise.all(pending.splice(0));
		await new Promise((resolve) => setTimeout(resolve, 5));
	};

	return {
		pi, ctx, commands, entries, notices, statuses, workingMessages, judgeCalls, branch, emit, userPrompt, userSetsLevel, switchModel,
		level: () => level,
	};
}

let configDir: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
	configDir = mkdtempSync(join(tmpdir(), "pi-modes-agent-"));
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = configDir;
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	delete process.env.PI_SUBAGENT_CHILD;
	delete process.env.PI_MODES_ACTIVE;
	delete process.env.PI_MODES_CAREFUL;
});

test("default: no judge call, level untouched", async () => {
	const fake = fakePi({ initialLevel: "xhigh" });
	piModesExtension(fake.pi);
	await fake.emit("session_start", { reason: "startup" });
	await fake.userPrompt("refactor everything");
	assert.equal(fake.judgeCalls.length, 0);
	assert.equal(fake.level(), "xhigh");
});

test("/auto-effort on: each typed prompt is judged and sets the level", async () => {
	const fake = fakePi({ initialLevel: "xhigh", judge: '{"level":"medium","reason":"small edit"}' });
	piModesExtension(fake.pi);
	await fake.emit("session_start", { reason: "startup" });
	await fake.commands["auto-effort"]!.handler("", fake.ctx);
	assert.equal(fake.statuses.at(-1), "🧠 auto");
	assert.deepEqual(fake.entries.at(-1)?.data, { mode: "default", careful: false, autoEffort: true, effortRestore: "xhigh" });

	await fake.userPrompt("rename foo to bar");
	assert.equal(fake.judgeCalls.length, 1);
	assert.equal(fake.judgeCalls[0]?.model, "9router/cc/claude-haiku-5-5");
	assert.match(fake.judgeCalls[0]?.systemPrompt ?? "", /xhigh/);
	assert.match(fake.judgeCalls[0]?.userText ?? "", /rename foo to bar/);
	assert.equal(fake.level(), "medium");
	assert.equal(fake.statuses.at(-1), "🧠 auto→medium");
	assert.equal(fake.workingMessages.at(-1), "Working 🧠 medium");
	assert.equal(fake.commands["auto-effort"] !== undefined, true);
	assert.ok(!fake.notices.some((notice) => notice.includes("paused")), "its own change does not pause it");
});

test("the previous answer goes to the judge so 'lanjut' can be rated", async () => {
	const fake = fakePi({ judge: '{"level":"xhigh","reason":"continues migration"}' });
	piModesExtension(fake.pi);
	await fake.emit("session_start", { reason: "startup" });
	await fake.commands["auto-effort"]!.handler("on", fake.ctx);
	await fake.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Step 1 of 6 of the database migration done." }] } });
	await fake.userPrompt("lanjut");
	assert.match(fake.judgeCalls[0]?.userText ?? "", /database migration/);
	assert.equal(fake.level(), "xhigh");
});

test("after /resume the previous answer comes from the session branch", async () => {
	const branch: unknown[] = [
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Refactor plan ready." }] } },
		{ type: "custom", customType: "pi-modes-state", data: { mode: "default", careful: false, autoEffort: true, effortRestore: "high" } },
	];
	const fake = fakePi({ branch });
	piModesExtension(fake.pi);
	await fake.emit("session_start", { reason: "resume" });
	assert.equal(fake.statuses.at(-1), "🧠 auto", "auto-effort restored from the session");
	await fake.userPrompt("go");
	assert.match(fake.judgeCalls[0]?.userText ?? "", /Refactor plan ready/);
});

test("extension messages, steering, and follow-ups are not judged", async () => {
	const fake = fakePi();
	piModesExtension(fake.pi);
	await fake.emit("session_start", { reason: "startup" });
	await fake.commands["auto-effort"]!.handler("on", fake.ctx);
	await fake.userPrompt("[auto-skill] brief", "extension");
	await fake.emit("input", { text: "also fix the header", source: "interactive", streamingBehavior: "steer" });
	await fake.emit("input", { text: "then the footer", source: "interactive", streamingBehavior: "followUp" });
	// The queued follow-up later starts its own run without a new input event.
	await fake.emit("before_agent_start", { prompt: "then the footer", systemPromptOptions: { sections: {}, cwd: "/tmp" } });
	assert.equal(fake.judgeCalls.length, 0);
	await fake.userPrompt("rpc prompt", "rpc");
	assert.equal(fake.judgeCalls.length, 1, "RPC clients such as pi-web are users too");
});

test("a failed or slow judge falls back to high with one warning", async () => {
	const fake = fakePi({
		initialLevel: "low",
		judge: async () => {
			throw new Error("429 rate limited");
		},
	});
	piModesExtension(fake.pi);
	await fake.emit("session_start", { reason: "startup" });
	await fake.commands["auto-effort"]!.handler("on", fake.ctx);
	await fake.userPrompt("fix the login bug");
	assert.equal(fake.level(), "high");
	assert.match(fake.notices.at(-1) ?? "", /judge failed \(429 rate limited\), using high/);
});

test("a missing judge model falls back to high", async () => {
	const fake = fakePi({ initialLevel: "low", judgeModelExists: false });
	piModesExtension(fake.pi);
	await fake.emit("session_start", { reason: "startup" });
	await fake.commands["auto-effort"]!.handler("on", fake.ctx);
	await fake.userPrompt("x");
	assert.equal(fake.level(), "high");
	assert.match(fake.notices.at(-1) ?? "", /not found/);
});

test("a manual level change pauses auto-effort and keeps the user's level", async () => {
	const fake = fakePi({ initialLevel: "xhigh", judge: '{"level":"medium","reason":"x"}' });
	piModesExtension(fake.pi);
	await fake.emit("session_start", { reason: "startup" });
	await fake.commands["auto-effort"]!.handler("on", fake.ctx);
	await fake.userPrompt("small thing");
	assert.equal(fake.level(), "medium");

	await fake.userSetsLevel("low");
	assert.match(fake.notices.at(-1) ?? "", /auto-effort paused: you set thinking to low/);
	assert.equal(fake.statuses.at(-1), undefined);
	assert.deepEqual(fake.entries.at(-1)?.data, { mode: "default", careful: false, autoEffort: false });

	await fake.userPrompt("refactor all");
	assert.equal(fake.judgeCalls.length, 1, "paused: no more judging");
	assert.equal(fake.level(), "low");
});

test("switching models re-clamps the level without pausing", async () => {
	const fake = fakePi({ initialLevel: "high", judge: '{"level":"xhigh","reason":"x"}' });
	piModesExtension(fake.pi);
	await fake.emit("session_start", { reason: "startup" });
	await fake.commands["auto-effort"]!.handler("on", fake.ctx);
	await fake.userPrompt("big refactor");
	assert.equal(fake.level(), "xhigh");

	await fake.switchModel({ provider: "openai", id: "gpt-x" }, ["off", "low", "medium", "high"]);
	assert.equal(fake.level(), "high");
	assert.ok(!fake.notices.some((notice) => notice.includes("paused")));
	assert.equal(fake.statuses.at(-1), "🧠 auto→high");

	await fake.userPrompt("another big refactor");
	assert.equal(fake.judgeCalls.length, 2, "still judging after the switch");
});

test("/auto-effort off puts back the level from before", async () => {
	const fake = fakePi({ initialLevel: "xhigh", judge: '{"level":"medium","reason":"x"}' });
	piModesExtension(fake.pi);
	await fake.emit("session_start", { reason: "startup" });
	await fake.commands["auto-effort"]!.handler("on", fake.ctx);
	await fake.userPrompt("tiny");
	assert.equal(fake.level(), "medium");
	await fake.commands["auto-effort"]!.handler("off", fake.ctx);
	await fake.emit("noop");
	assert.equal(fake.level(), "xhigh");
	assert.match(fake.notices.at(-1) ?? "", /back to xhigh/);
	assert.ok(!fake.notices.some((notice) => notice.includes("paused")), "restoring is not a manual change");
	assert.equal(fake.statuses.at(-1), undefined);
});

test("/auto-effort model saves the judge model globally", async () => {
	const fake = fakePi();
	piModesExtension(fake.pi);
	await fake.emit("session_start", { reason: "startup" });
	await fake.commands["auto-effort"]!.handler("model nope/nothing", fake.ctx);
	assert.match(fake.notices.at(-1) ?? "", /not found/);
	await fake.commands["auto-effort"]!.handler("model anthropic/claude-haiku-5-5", fake.ctx);
	assert.deepEqual(JSON.parse(readFileSync(join(configDir, "pi-modes.json"), "utf8")), {
		autoEffort: { judgeModel: "anthropic/claude-haiku-5-5" },
	});
	await fake.commands["auto-effort"]!.handler("on", fake.ctx);
	await fake.userPrompt("x");
	assert.equal(fake.judgeCalls[0]?.model, "anthropic/claude-haiku-5-5");
	await fake.commands["auto-effort"]!.handler("status", fake.ctx);
	assert.match(fake.notices.at(-1) ?? "", /auto-effort \(judge anthropic\/claude-haiku-5-5, last: high — medium feature\)/);
});

test("subagents never run auto-effort, even from a forked session", async () => {
	process.env.PI_SUBAGENT_CHILD = "1";
	const fake = fakePi({ branch: [{ type: "custom", customType: "pi-modes-state", data: { autoEffort: true, effortRestore: "high" } }] });
	piModesExtension(fake.pi);
	await fake.emit("session_start", { reason: "startup" });
	await fake.userPrompt("x");
	assert.equal(fake.judgeCalls.length, 0);
	await fake.commands["auto-effort"]!.handler("on", fake.ctx);
	assert.match(fake.notices.at(-1) ?? "", /does not run in subagents/);
});

test("combines with gercep in the status and Working line", async () => {
	const fake = fakePi({ judge: '{"level":"xhigh","reason":"x"}' });
	piModesExtension(fake.pi);
	await fake.emit("session_start", { reason: "startup" });
	await fake.commands.gercep!.handler("on", fake.ctx);
	await fake.commands["auto-effort"]!.handler("on", fake.ctx);
	await fake.userPrompt("refactor");
	assert.equal(fake.statuses.at(-1), "⚡ gercep · 🧠 auto→xhigh");
	assert.equal(fake.workingMessages.at(-1), "Working ⚡ gercep · 🧠 xhigh");
	assert.equal(fake.level(), "xhigh", "gercep does not cap the level");
});
