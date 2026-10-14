/**
 * auto-review and /review wiring: the extension driven through fake Pi events,
 * on a real temporary git repository, with a scripted (faux) reviewer model.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piModesExtension from "../extensions/pi-modes.ts";

type Handler = (event: any, ctx: any) => unknown;

const MAJOR = '```json\n{"findings":[{"severity":"major","file":"src/auth.ts","line":2,"title":"counter in memory","fix":"use redis"},{"severity":"minor","title":"no Retry-After"}]}\n```';
const CLEAN = '{"findings":[],"checked":["bypass"]}';

function makeRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-modes-review-wiring-"));
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
	git("init", "-q");
	writeFileSync(join(dir, "README.md"), "hello\n");
	git("add", "-A");
	git("commit", "-q", "-m", "init");
	return dir;
}

const lines = (count: number, tag = "line") => Array.from({ length: count }, (_, index) => `${tag} ${index}`).join("\n") + "\n";

function fakePi(options: { cwd?: string; branch?: unknown[]; verdicts?: (string | "error")[]; idle?: boolean } = {}) {
	const hooks: Record<string, Handler[]> = {};
	const commands: Record<string, { handler: (args: string, ctx: any) => Promise<void> }> = {};
	const branch = options.branch ?? [];
	const entries: { customType: string; data: any }[] = [];
	const notices: { text: string; level?: string }[] = [];
	const statuses = new Map<string, string | undefined>();
	const widgets: (string | undefined)[] = [];
	const sent: { message: any; options?: any }[] = [];
	const renderers: Record<string, unknown> = {};

	const faux = createFauxCore({ provider: "faux", models: [{ id: "reviewer", reasoning: true }] });
	const reviewerRequests: { text: string; reasoning: unknown }[] = [];
	faux.setResponses(
		(options.verdicts ?? []).map((verdict) =>
			verdict === "error" ? fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit" }) : fauxAssistantMessage(fauxText(verdict)),
		),
	);

	const pi = {
		on: (name: string, handler: Handler) => {
			hooks[name] = [...(hooks[name] ?? []), handler];
		},
		registerCommand: (name: string, definition: { handler: (args: string, ctx: any) => Promise<void> }) => {
			commands[name] = definition;
		},
		registerMessageRenderer: (type: string, renderer: unknown) => {
			renderers[type] = renderer;
		},
		appendEntry: (customType: string, data: unknown) => {
			entries.push({ customType, data });
			branch.push({ type: "custom", customType, data });
		},
		sendMessage: (message: unknown, sendOptions?: unknown) => sent.push({ message, options: sendOptions }),
		setThinkingLevel: () => {},
		getThinkingLevel: () => "medium",
	} as unknown as ExtensionAPI;

	let idle = options.idle ?? true;
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: options.cwd ?? process.cwd(),
		isIdle: () => idle,
		model: { provider: "9router", id: "cc/claude-sonnet-5-5" },
		modelRegistry: {
			find: (provider: string, id: string) => (provider === "faux" && id === "reviewer" ? faux.getModel() : undefined),
			streamSimple: (model: any, context: any, streamOptions: any) => {
				const text = JSON.stringify(context.messages);
				reviewerRequests.push({ text, reasoning: streamOptions?.reasoning });
				return faux.streamSimple(model, context, streamOptions);
			},
		},
		ui: {
			notify: (text: string, level?: string) => notices.push({ text, level }),
			setStatus: (key: string, text: string | undefined) => statuses.set(key, text),
			setWorkingMessage: () => {},
			setWidget: (_key: string, content: unknown) => widgets.push(content === undefined ? undefined : "widget"),
			onTerminalInput: () => () => {},
			getEditorComponent: () => undefined,
			setEditorComponent: () => {},
			confirm: async () => true,
		},
		sessionManager: { getBranch: () => branch },
	};

	const emit = async (name: string, event: Record<string, unknown> = {}) => {
		let result: unknown;
		for (const handler of hooks[name] ?? []) {
			const value = await handler({ type: name, ...event }, ctx);
			if (value !== undefined) result = value;
		}
		return result;
	};

	const userPrompt = async (prompt: string, source = "interactive") => {
		await emit("input", { text: prompt, source });
		await emit("before_agent_start", { prompt, systemPromptOptions: { sections: {}, cwd: ctx.cwd } });
	};

	/** The agent writes a file: Pi reports the tool call first, then the file exists. */
	const agentWrites = async (path: string, content: string) => {
		await emit("tool_call", { toolName: "write", toolCallId: `w${Math.random()}`, input: { path, content } });
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
		await emit("tool_result", { toolName: "write", toolCallId: "x", input: { path }, isError: false });
	};

	/** The run ends: the final answer, then the settle boundary. */
	const settle = async (answer = "Done.", outcome = "completed") => {
		await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: answer }] } });
		return (await emit("agent_before_settle", { outcome, entries: [], continue: false })) as
			| { entries?: { type: string; customType: string; content?: string; display?: boolean; details?: any; data?: any }[]; continue?: boolean }
			| undefined;
	};

	return {
		pi, ctx, commands, entries, notices, statuses, widgets, sent, renderers, branch, faux, reviewerRequests, emit, userPrompt, settle, agentWrites,
		setIdle: (value: boolean) => {
			idle = value;
		},
	};
}

let configDir: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
	configDir = mkdtempSync(join(tmpdir(), "pi-modes-agent-"));
	writeFileSync(join(configDir, "pi-modes.json"), JSON.stringify({ autoReview: { model: "faux/reviewer" } }));
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

test("default: a task with changes is recorded for /review, never reviewed", async () => {
	const repo = makeRepo();
	const fake = fakePi({ cwd: repo });
	piModesExtension(fake.pi);
	await fake.emit("session_start", { reason: "startup" });

	await fake.userPrompt("add feature");
	await fake.agentWrites(join(repo, "feature.ts"), lines(40));
	const result = await fake.settle();
	assert.deepEqual(
		result?.entries?.map((entry) => [entry.type, entry.customType]),
		[["custom", "pi-modes-review-task"]],
	);
	assert.equal(result?.entries?.[0]?.data.request, "add feature");
	assert.equal(result?.continue, undefined);
	assert.equal(fake.faux.state.callCount, 0, "no reviewer call");
	assert.equal(fake.statuses.get("pi-modes"), undefined, "status untouched");
});

test("default: a question without changes adds nothing", async () => {
	const repo = makeRepo();
	const fake = fakePi({ cwd: repo });
	piModesExtension(fake.pi);
	await fake.emit("session_start", { reason: "startup" });
	await fake.userPrompt("what does this repo do?");
	assert.equal(await fake.settle("It says hello."), undefined);
});

test("/auto-review: risky change reviewed at xhigh, major sent to fix, fix re-reviewed once", async () => {
	const repo = makeRepo();
	const fake = fakePi({ cwd: repo, verdicts: [MAJOR, CLEAN] });
	piModesExtension(fake.pi);
	await fake.emit("session_start", { reason: "startup" });

	await fake.commands["auto-review"]!.handler("on", fake.ctx);
	assert.equal(fake.statuses.get("pi-modes"), "🔍 auto-review");
	assert.equal(fake.entries.at(-1)?.data.autoReview, true);
	assert.match(fake.notices.at(-1)?.text ?? "", /Auto-review on: faux\/reviewer/);

	await fake.userPrompt("add rate limit to login");
	await fake.agentWrites(join(repo, "src", "auth.ts"), "export const counter = new Map();\nexport function limit() {}\n");
	const first = await fake.settle("Added a limiter.");

	assert.deepEqual(
		first?.entries?.map((entry) => [entry.customType, entry.display ?? null]),
		[
			["pi-modes-review-task", null],
			["pi-modes-review", true],
			["pi-modes-review-fix", false],
		],
	);
	assert.equal(first?.continue, true, "the agent gets a turn to fix");
	const report = first?.entries?.[1];
	assert.equal(report?.details.effort, "xhigh");
	assert.equal(report?.details.action, "sent-to-fix");
	assert.match(report?.content ?? "", /^🔍 Review \(reviewer · xhigh\) — 1 major, 1 minor/);
	assert.match(first?.entries?.[2]?.content ?? "", /counter in memory/);
	assert.doesNotMatch(first?.entries?.[2]?.content ?? "", /Retry-After/, "minor findings are not sent to fix");
	assert.equal(fake.reviewerRequests[0]?.reasoning, "xhigh");
	assert.match(fake.reviewerRequests[0]?.text ?? "", /add rate limit to login/);
	assert.match(fake.reviewerRequests[0]?.text ?? "", /Added a limiter/);
	assert.match(fake.reviewerRequests[0]?.text ?? "", /counter = new Map/, "the diff reached the reviewer");
	assert.deepEqual(fake.widgets, ["widget", undefined], "progress widget shown, then removed");
	assert.ok(fake.renderers["pi-modes-review"], "report renderer registered");

	// The fix run (a continuation, no new prompt) changes the file; only the fix diff is re-reviewed.
	await fake.agentWrites(join(repo, "src", "auth.ts"), "export const counter = redis();\nexport function limit() {}\n");
	const second = await fake.settle("Moved the counter to redis.");
	assert.deepEqual(second?.entries?.map((entry) => entry.customType), ["pi-modes-review"]);
	assert.equal(second?.entries?.[0]?.details.round, 2);
	assert.match(second?.entries?.[0]?.content ?? "", /^🔍 Re-review .* — no issues found/);
	assert.equal(second?.continue, undefined);
	assert.match(fake.reviewerRequests[1]?.text ?? "", /RE-REVIEW/);
	assert.match(fake.reviewerRequests[1]?.text ?? "", /redis\(\)/);
	assert.doesNotMatch(fake.reviewerRequests[1]?.text ?? "", /\+export function limit/, "only the fix diff, not the whole task");

	assert.equal(await fake.settle("ok"), undefined, "the task is done");
	assert.equal(fake.faux.state.callCount, 2);
});

test("/auto-review: a small, safe change is not reviewed", async () => {
	const repo = makeRepo();
	const fake = fakePi({ cwd: repo, verdicts: [CLEAN] });
	piModesExtension(fake.pi);
	await fake.emit("session_start", { reason: "startup" });
	await fake.commands["auto-review"]!.handler("on", fake.ctx);
	await fake.userPrompt("fix typo");
	await fake.agentWrites(join(repo, "README.md"), "hello world\n");
	const result = await fake.settle();
	assert.deepEqual(result?.entries?.map((entry) => entry.customType), ["pi-modes-review-task"]);
	assert.equal(fake.faux.state.callCount, 0);
});

test("with gercep: the fix comes first, the QA checklist follow-up after the re-review", async () => {
	const repo = makeRepo();
	const fake = fakePi({ cwd: repo, verdicts: [MAJOR, CLEAN] });
	piModesExtension(fake.pi);
	await fake.emit("session_start", { reason: "startup" });
	await fake.commands.gercep!.handler("on", fake.ctx);
	await fake.commands["auto-review"]!.handler("on", fake.ctx);

	await fake.userPrompt("big change");
	await fake.agentWrites(join(repo, "big.ts"), lines(30));
	const first = await fake.settle("Done.");
	assert.deepEqual(first?.entries?.map((entry) => entry.customType), ["pi-modes-review-task", "pi-modes-review", "pi-modes-review-fix"]);
	assert.equal(fake.reviewerRequests[0]?.reasoning, "high", "gercep does not lower the review effort");

	await fake.agentWrites(join(repo, "big.ts"), lines(30, "fixed"));
	const second = await fake.settle("Fixed.");
	assert.deepEqual(second?.entries?.map((entry) => entry.customType), ["pi-modes-review", "pi-modes-follow-up"]);
	assert.match(second?.entries?.[1]?.content ?? "", /QA checklist/);
	assert.equal(second?.continue, true);
});

test("a failing reviewer warns and never blocks the agent", async () => {
	const repo = makeRepo();
	const fake = fakePi({ cwd: repo, verdicts: ["error"] });
	piModesExtension(fake.pi);
	await fake.emit("session_start", { reason: "startup" });
	await fake.commands["auto-review"]!.handler("on", fake.ctx);
	await fake.userPrompt("change");
	await fake.agentWrites(join(repo, "a.ts"), lines(30));
	const result = await fake.settle();
	assert.deepEqual(result?.entries?.map((entry) => entry.customType), ["pi-modes-review-task"]);
	assert.equal(result?.continue, undefined);
	const warning = fake.notices.at(-1);
	assert.equal(warning?.level, "warning");
	assert.match(warning?.text ?? "", /Review failed \(reviewer\): 429 rate limit/);
	assert.deepEqual(fake.widgets.at(-1), undefined, "widget removed after a failure");
});

test("an aborted run is not reviewed", async () => {
	const repo = makeRepo();
	const fake = fakePi({ cwd: repo, verdicts: [CLEAN] });
	piModesExtension(fake.pi);
	await fake.emit("session_start", { reason: "startup" });
	await fake.commands["auto-review"]!.handler("on", fake.ctx);
	await fake.userPrompt("change");
	await fake.agentWrites(join(repo, "a.ts"), lines(30));
	const result = await fake.settle("", "aborted");
	assert.deepEqual(result?.entries?.map((entry) => entry.customType), ["pi-modes-review-task"], "recorded for /review only");
	assert.equal(fake.faux.state.callCount, 0);
});

test("/review: the last task on demand, with findings sent to fix as a new turn", async () => {
	const repo = makeRepo();
	const fake = fakePi({ cwd: repo, verdicts: [MAJOR, CLEAN] });
	piModesExtension(fake.pi);
	await fake.emit("session_start", { reason: "startup" });

	await fake.userPrompt("add login limiter");
	await fake.agentWrites(join(repo, "limit.ts"), "x\n");
	await fake.settle("Added.");
	assert.equal(fake.faux.state.callCount, 0);

	await fake.commands.review!.handler("", fake.ctx);
	assert.equal(fake.reviewerRequests[0]?.reasoning, "high", "small manual review still runs");
	assert.match(fake.reviewerRequests[0]?.text ?? "", /add login limiter/);
	assert.deepEqual(
		fake.sent.map((item) => [item.message.customType, item.message.display, item.options?.triggerTurn ?? null]),
		[
			["pi-modes-review", true, null],
			["pi-modes-review-fix", false, true],
		],
	);

	// The fix run: no input event for a triggered custom message, settle re-reviews the fix.
	await fake.agentWrites(join(repo, "limit.ts"), "y\n");
	const after = await fake.settle("Fixed.");
	assert.equal(after?.entries?.[0]?.details.round, 2);
});

test("/review session and uncommitted, and the guards", async () => {
	const repo = makeRepo();
	const fake = fakePi({ cwd: repo, verdicts: [CLEAN, CLEAN] });
	piModesExtension(fake.pi);
	await fake.emit("session_start", { reason: "startup" });

	await fake.commands.review!.handler("", fake.ctx);
	assert.match(fake.notices.at(-1)?.text ?? "", /No task with file changes/);

	writeFileSync(join(repo, "manual-edit.ts"), "by hand\n");
	await fake.commands.review!.handler("uncommitted", fake.ctx);
	assert.match(fake.reviewerRequests[0]?.text ?? "", /manual-edit.ts/);
	assert.equal(fake.sent.at(-1)?.message.details.scope, "uncommitted");

	await fake.userPrompt("one");
	await fake.agentWrites(join(repo, "one.ts"), "1\n");
	await fake.settle();
	await fake.userPrompt("two");
	await fake.agentWrites(join(repo, "two.ts"), "2\n");
	await fake.settle();
	await fake.commands.review!.handler("session", fake.ctx);
	assert.match(fake.reviewerRequests[1]?.text ?? "", /one.ts/);
	assert.match(fake.reviewerRequests[1]?.text ?? "", /two.ts/);

	fake.setIdle(false);
	await fake.commands.review!.handler("", fake.ctx);
	assert.match(fake.notices.at(-1)?.text ?? "", /still working/);
	fake.setIdle(true);

	await fake.commands.review!.handler("everything", fake.ctx);
	assert.match(fake.notices.at(-1)?.text ?? "", /Unknown argument/);
	assert.equal(fake.faux.state.callCount, 2);
});

test("/review after a reload finds the persisted task", async () => {
	const repo = makeRepo();
	const first = fakePi({ cwd: repo });
	piModesExtension(first.pi);
	await first.emit("session_start", { reason: "startup" });
	await first.userPrompt("persisted task");
	await first.agentWrites(join(repo, "p.ts"), "p\n");
	const result = await first.settle();
	const branch = result?.entries?.map((entry) => ({ type: entry.type, customType: entry.customType, data: entry.data })) ?? [];

	const second = fakePi({ cwd: repo, branch, verdicts: [CLEAN] });
	piModesExtension(second.pi);
	await second.emit("session_start", { reason: "reload" });
	await second.commands.review!.handler("", second.ctx);
	assert.match(second.reviewerRequests[0]?.text ?? "", /persisted task/);
	assert.match(second.reviewerRequests[0]?.text ?? "", /p.ts/);
});

test("auto-review persists across a reload", async () => {
	const repo = makeRepo();
	const branch: unknown[] = [{ type: "custom", customType: "pi-modes-state", data: { mode: "default", careful: false, autoReview: true } }];
	const fake = fakePi({ cwd: repo, branch });
	piModesExtension(fake.pi);
	await fake.emit("session_start", { reason: "reload" });
	assert.equal(fake.statuses.get("pi-modes"), "🔍 auto-review");
});

test("a folder with no repository anywhere: nothing recorded, /review says so", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-modes-nogit-"));
	const fake = fakePi({ cwd: dir });
	piModesExtension(fake.pi);
	await fake.emit("session_start", { reason: "startup" });
	await fake.commands["auto-review"]!.handler("on", fake.ctx);
	assert.match(fake.notices.at(-1)?.text ?? "", /not a git repository itself|has none inside/);
	await fake.userPrompt("change");
	await fake.agentWrites(join(dir, "a.ts"), lines(30));
	assert.equal(await fake.settle(), undefined, "no repository was touched");
	await fake.commands.review!.handler("uncommitted", fake.ctx);
	assert.match(fake.notices.at(-1)?.text ?? "", /needs a git repository/);
	await fake.commands.review!.handler("", fake.ctx);
	assert.match(fake.notices.at(-1)?.text ?? "", /No task with file changes/);
});

test("subagents never review", async () => {
	process.env.PI_SUBAGENT_CHILD = "1";
	const repo = makeRepo();
	const branch: unknown[] = [{ type: "custom", customType: "pi-modes-state", data: { autoReview: true } }];
	const fake = fakePi({ cwd: repo, branch, verdicts: [CLEAN] });
	piModesExtension(fake.pi);
	await fake.emit("session_start", { reason: "startup" });
	assert.equal(fake.statuses.get("pi-modes"), undefined, "a forked auto-review does not carry into the subagent");
	await fake.commands["auto-review"]!.handler("on", fake.ctx);
	assert.match(fake.notices.at(-1)?.text ?? "", /does not run in subagents/);
	await fake.userPrompt("change");
	await fake.agentWrites(join(repo, "a.ts"), lines(30));
	assert.equal(await fake.settle(), undefined);
	assert.equal(fake.faux.state.callCount, 0);
});

test("/auto-review model saves a known model and rejects an unknown one", async () => {
	const repo = makeRepo();
	const fake = fakePi({ cwd: repo });
	piModesExtension(fake.pi);
	await fake.emit("session_start", { reason: "startup" });
	await fake.commands["auto-review"]!.handler("model nope/missing", fake.ctx);
	assert.match(fake.notices.at(-1)?.text ?? "", /not found/);
	await fake.commands["auto-review"]!.handler("model faux/reviewer", fake.ctx);
	assert.match(fake.notices.at(-1)?.text ?? "", /Reviewer model set to faux\/reviewer/);
	await fake.commands["auto-review"]!.handler("status", fake.ctx);
	assert.match(fake.notices.at(-1)?.text ?? "", /Mode: default/);
	await fake.commands["auto-review"]!.handler("on", fake.ctx);
	await fake.commands["auto-review"]!.handler("status", fake.ctx);
	assert.match(fake.notices.at(-1)?.text ?? "", /auto-review \(reviewer faux\/reviewer\)/);
	await fake.commands["auto-review"]!.handler("off", fake.ctx);
	assert.equal(fake.statuses.get("pi-modes"), undefined);
	assert.equal(fake.entries.at(-1)?.data.autoReview, false);
});

// ---- a monorepo folder: no git itself, git repositories inside ------------------------------

function makeMonorepo() {
	const mono = realpathSync(mkdtempSync(join(tmpdir(), "pi-modes-mono-wiring-")));
	const mk = (name: string) => {
		const dir = join(mono, name);
		mkdirSync(dir, { recursive: true });
		const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
		git("init", "-q");
		writeFileSync(join(dir, "README.md"), `${name}\n`);
		git("add", "-A");
		git("commit", "-q", "-m", "init");
		return dir;
	};
	return { mono, api: mk("api"), web: mk("web"), idle: mk("idle") };
}

test("monorepo folder: one review across the repositories the agent changed, untouched ones left out", async () => {
	const { mono, api, web } = makeMonorepo();
	const fake = fakePi({ cwd: mono, verdicts: [MAJOR, CLEAN] });
	piModesExtension(fake.pi);
	await fake.emit("session_start", { reason: "startup" });
	await fake.commands["auto-review"]!.handler("on", fake.ctx);
	assert.match(fake.notices.at(-1)?.text ?? "", /repositories inside it are reviewed/);
	assert.equal(fake.notices.at(-1)?.level, "info");

	await fake.userPrompt("rename total to amount in api and web");
	await fake.agentWrites(join(api, "src", "auth", "orders.ts"), "export const amount = 1;\n" + lines(10));
	await fake.agentWrites(join(web, "src", "cart.ts"), "import { amount } from 'api';\n" + lines(10));
	const first = await fake.settle("Renamed in both.");

	assert.deepEqual(first?.entries?.map((entry) => entry.customType), ["pi-modes-review-task", "pi-modes-review", "pi-modes-review-fix"]);
	assert.deepEqual(Object.keys(first?.entries?.[0]?.data.base).sort(), [api, web].sort(), "the untouched repository is not part of the task");
	const prompt = fake.reviewerRequests[0]?.text ?? "";
	assert.match(prompt, /spans 2 separate git repositories: api, web/);
	assert.match(prompt, /api\/src\/auth\/orders.ts/);
	assert.match(prompt, /web\/src\/cart.ts/);
	assert.match(prompt, /diff --git a\/api\/src\/auth\/orders.ts b\/api\/src\/auth\/orders.ts/);
	assert.doesNotMatch(prompt, /idle/);
	assert.equal(first?.entries?.[1]?.details.effort, "xhigh", "auth path in api");
	assert.deepEqual(first?.entries?.[1]?.details.repos, ["api", "web"]);
	assert.equal(fake.reviewerRequests[0]?.reasoning, "xhigh");

	// The fix touches only api; only that diff is re-reviewed.
	await fake.agentWrites(join(api, "src", "auth", "orders.ts"), "export const amount = 2;\n");
	const second = await fake.settle("Fixed.");
	assert.equal(second?.entries?.[0]?.details.round, 2);
	assert.doesNotMatch(fake.reviewerRequests[1]?.text ?? "", /web\/src\/cart.ts/);
	assert.match(fake.reviewerRequests[1]?.text ?? "", /api\/src\/auth\/orders.ts/);
});

test("monorepo folder: a repository found through a bash `cd` is snapshotted before the command runs", async () => {
	const { mono, web } = makeMonorepo();
	const fake = fakePi({ cwd: mono });
	piModesExtension(fake.pi);
	await fake.emit("session_start", { reason: "startup" });
	await fake.userPrompt("generate the lockfile");
	await fake.emit("tool_call", { toolName: "bash", toolCallId: "b1", input: { command: "cd web && npm install" } });
	writeFileSync(join(web, "package-lock.json"), "{}\n");
	const result = await fake.settle("Installed.");
	assert.deepEqual(Object.keys(result?.entries?.[0]?.data.base), [web]);
});

test("monorepo folder: /review uncommitted covers every repository with changes, including the user's own", async () => {
	const { mono, api, web } = makeMonorepo();
	const fake = fakePi({ cwd: mono, verdicts: [CLEAN] });
	piModesExtension(fake.pi);
	await fake.emit("session_start", { reason: "startup" });
	writeFileSync(join(api, "by-hand.ts"), "api edit\n");
	writeFileSync(join(web, "by-hand.ts"), "web edit\n");

	await fake.commands.review!.handler("uncommitted", fake.ctx);
	const prompt = fake.reviewerRequests[0]?.text ?? "";
	assert.match(prompt, /api\/by-hand.ts/);
	assert.match(prompt, /web\/by-hand.ts/);
	assert.doesNotMatch(prompt, /idle\/by-hand/);
	assert.equal(fake.sent.at(-1)?.message.details.repos.length, 2);
});

test("monorepo folder: /review uncommitted with a clean tree says so", async () => {
	const { mono } = makeMonorepo();
	const fake = fakePi({ cwd: mono });
	piModesExtension(fake.pi);
	await fake.emit("session_start", { reason: "startup" });
	await fake.commands.review!.handler("uncommitted", fake.ctx);
	assert.match(fake.notices.at(-1)?.text ?? "", /No uncommitted changes in 3 repositories/);
	assert.equal(fake.faux.state.callCount, 0);
});

test("running inside one repository of the monorepo: /review uncommitted still covers the sibling repositories", async () => {
	const { api, web } = makeMonorepo();
	const fake = fakePi({ cwd: api, verdicts: [CLEAN] });
	piModesExtension(fake.pi);
	await fake.emit("session_start", { reason: "startup" });
	writeFileSync(join(api, "mine.ts"), "a\n");
	writeFileSync(join(web, "sibling.ts"), "b\n");
	await fake.commands.review!.handler("uncommitted", fake.ctx);
	const prompt = fake.reviewerRequests[0]?.text ?? "";
	assert.match(prompt, /api\/mine.ts/);
	assert.match(prompt, /web\/sibling.ts/);
});

test("inside a repository, a task that also changes a sibling repository reviews both", async () => {
	const { api, web } = makeMonorepo();
	const fake = fakePi({ cwd: api, verdicts: [CLEAN] });
	piModesExtension(fake.pi);
	await fake.emit("session_start", { reason: "startup" });
	await fake.commands["auto-review"]!.handler("on", fake.ctx);
	await fake.userPrompt("change the shared contract");
	await fake.agentWrites(join(api, "contract.ts"), lines(15));
	await fake.agentWrites(join(web, "client.ts"), lines(15));
	const result = await fake.settle("Done.");
	assert.deepEqual(Object.keys(result?.entries?.[0]?.data.base).sort(), [api, web].sort());
	assert.match(fake.reviewerRequests[0]?.text ?? "", /separate git repositories: api, web/);
});

test("a session saved by 0.5.0 (one tree string) still works with /review", async () => {
	const repo = makeRepo();
	const root = realpathSync(repo);
	const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: repo, encoding: "utf8" }).trim();
	writeFileSync(join(repo, "new.ts"), "after the saved task\n");
	const branch = [{ type: "custom", customType: "pi-modes-review-task", data: { request: "old task", base: tree, sessionBase: tree } }];
	const fake = fakePi({ cwd: repo, branch, verdicts: [CLEAN] });
	piModesExtension(fake.pi);
	await fake.emit("session_start", { reason: "reload" });
	await fake.commands.review!.handler("", fake.ctx);
	assert.match(fake.reviewerRequests[0]?.text ?? "", /old task/);
	assert.match(fake.reviewerRequests[0]?.text ?? "", /new.ts/);
	assert.ok(root);
});

test("/review uncommitted over a folder of many unrelated repositories asks first, and no means no", async () => {
	const mono = realpathSync(mkdtempSync(join(tmpdir(), "pi-modes-many-")));
	for (const name of ["a", "b", "c", "d"]) {
		const dir = join(mono, name);
		mkdirSync(dir, { recursive: true });
		const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
		git("init", "-q");
		writeFileSync(join(dir, "README.md"), `${name}\n`);
		git("add", "-A");
		git("commit", "-q", "-m", "init");
		writeFileSync(join(dir, "dirty.ts"), "changed\n");
	}
	const asked: string[] = [];
	const fake = fakePi({ cwd: mono, verdicts: [CLEAN] });
	(fake.ctx.ui as { confirm: (title: string, message: string) => Promise<boolean> }).confirm = async (_title, message) => {
		asked.push(message);
		return false;
	};
	piModesExtension(fake.pi);
	await fake.emit("session_start", { reason: "startup" });
	await fake.commands.review!.handler("uncommitted", fake.ctx);
	assert.equal(asked.length, 1);
	assert.match(asked[0] ?? "", /4 repositories/);
	assert.match(fake.notices.at(-1)?.text ?? "", /Review skipped/);
	assert.equal(fake.faux.state.callCount, 0, "declined: no reviewer call, no cost");

	(fake.ctx.ui as { confirm: (title: string, message: string) => Promise<boolean> }).confirm = async () => true;
	await fake.commands.review!.handler("uncommitted", fake.ctx);
	assert.equal(fake.faux.state.callCount, 1);
	assert.equal(fake.sent.at(-1)?.message.details.repos.length, 4);
});

test("without a UI there is nobody to ask, so a large /review uncommitted does not run", async () => {
	const mono = realpathSync(mkdtempSync(join(tmpdir(), "pi-modes-many-")));
	for (const name of ["a", "b", "c", "d"]) {
		const dir = join(mono, name);
		mkdirSync(dir, { recursive: true });
		const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
		git("init", "-q");
		writeFileSync(join(dir, "README.md"), `${name}\n`);
		git("add", "-A");
		git("commit", "-q", "-m", "init");
		writeFileSync(join(dir, "dirty.ts"), "changed\n");
	}
	const fake = fakePi({ cwd: mono, verdicts: [CLEAN] });
	(fake.ctx as { hasUI: boolean }).hasUI = false;
	piModesExtension(fake.pi);
	await fake.emit("session_start", { reason: "startup" });
	await fake.commands.review!.handler("uncommitted", fake.ctx);
	assert.equal(fake.faux.state.callCount, 0);
});
