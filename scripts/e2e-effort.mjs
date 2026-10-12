#!/usr/bin/env node
/**
 * End-to-end check of /auto-effort against a real Pi process.
 *
 * A local OpenAI-compatible stub serves two models: "stub-main" (the session
 * model, reasoning with medium/high/xhigh) and "stub-judge" (the judge). The
 * judge answers from the request text, so the test can check that:
 *   1. default mode never calls the judge
 *   2. /auto-effort on + a heavy prompt → the main request carries xhigh
 *   3. a light prompt → medium
 *   4. a judge error → high, with a warning
 *   5. a manual set_thinking_level pauses auto-effort
 *   6. /auto-effort on, then off → the level from before is back
 *
 * Usage:  npm run test:e2e
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TIMEOUT_MS = 120_000;
const extensionSpec =
	process.env.PI_MODES_EXTENSION ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "pi-modes.ts");

const root = mkdtempSync(join(tmpdir(), "pi-modes-e2e-effort-"));
const agentDir = join(root, "agent");
const workDir = join(root, "work");
const sessionDir = join(root, "sessions");
for (const dir of [agentDir, workDir, sessionDir]) mkdirSync(dir, { recursive: true });
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
writeFileSync(join(agentDir, "pi-modes.json"), JSON.stringify({ autoEffort: { judgeModel: "stub/stub-judge" } }));

// ---- scripted models --------------------------------------------------------
const mainRequests = [];
const judgeRequests = [];

function allText(body) {
	return body.messages.map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content))).join("\n");
}

function sse(response, delta, finish) {
	response.write(
		`data: ${JSON.stringify({
			id: "stub",
			object: "chat.completion.chunk",
			created: 0,
			model: "stub",
			choices: [{ index: 0, delta, finish_reason: finish }],
			...(finish ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}),
		})}\n\n`,
	);
}

const server = createServer((request, response) => {
	let raw = "";
	request.on("data", (chunk) => (raw += chunk));
	request.on("end", () => {
		const parsed = JSON.parse(raw || "{}");
		const body = { ...parsed, messages: Array.isArray(parsed.messages) ? parsed.messages : [] };
		if (body.messages.length === 0) {
			response.writeHead(200, { "content-type": "text/event-stream" });
			sse(response, { role: "assistant", content: "" }, "stop");
			response.end("data: [DONE]\n\n");
			return;
		}
		let text = "ok";
		if (body.model === "stub-judge") {
			judgeRequests.push(body);
			const request = allText(body);
			if (request.includes("JUDGE-ERROR")) {
				response.writeHead(500, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: { message: "judge exploded" } }));
				return;
			}
			text = request.includes("HEAVY")
				? '{"level":"xhigh","reason":"multi-file refactor"}'
				: '{"level":"medium","reason":"small edit"}';
		} else {
			mainRequests.push(body);
		}
		response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		sse(response, { role: "assistant", content: text }, null);
		sse(response, {}, "stop");
		response.end("data: [DONE]\n\n");
	});
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const port = server.address().port;

const stubExtension = join(root, "stub-provider.ts");
writeFileSync(
	stubExtension,
	`export default function (pi) {
	const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	pi.registerProvider("stub", {
		baseUrl: "http://127.0.0.1:${port}/v1",
		apiKey: "stub-key",
		api: "openai-completions",
		models: [
			{ id: "stub-main", name: "Stub main", reasoning: true, input: ["text"], cost, contextWindow: 32000, maxTokens: 1024,
				thinkingLevelMap: { xhigh: "xhigh", max: "max" } },
			{ id: "stub-judge", name: "Stub judge", reasoning: false, input: ["text"], cost, contextWindow: 32000, maxTokens: 1024 },
		],
	});
}
`,
);

// ---- pi process ---------------------------------------------------------------
const extensionErrors = [];
const notices = [];
const stderr = [];
const responses = new Map();
const settled = [];
let child;
let finished = false;

function handle(line) {
	let event;
	try {
		event = JSON.parse(line);
	} catch {
		return;
	}
	if (event.type === "extension_error") extensionErrors.push(JSON.stringify(event).slice(0, 300));
	if (event.type === "extension_ui_request" && event.method === "notify") notices.push(String(event.message));
	if (event.type === "agent_settled") settled.push(event);
	if (event.type === "response" && event.id) responses.set(event.id, event);
}

function startPi() {
	const proc = spawn("pi", ["--mode", "rpc", "-e", stubExtension, "-e", extensionSpec], {
		cwd: workDir,
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: sessionDir, PI_MODES_ACTIVE: "", PI_SUBAGENT_CHILD: "" },
		stdio: ["pipe", "pipe", "pipe"],
	});
	proc.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
	let buffer = "";
	proc.stdout.on("data", (chunk) => {
		buffer += chunk.toString();
		let index = buffer.indexOf("\n");
		while (index >= 0) {
			const line = buffer.slice(0, index).trim();
			buffer = buffer.slice(index + 1);
			index = buffer.indexOf("\n");
			if (line) handle(line);
		}
	});
	return proc;
}

const send = (payload) => child.stdin.write(`${JSON.stringify(payload)}\n`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function until(check, label, ms = 30_000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (check()) return;
		await sleep(50);
	}
	throw new Error(`timed out waiting for ${label}`);
}

async function request(id, payload) {
	send({ id, ...payload });
	await until(() => responses.has(id), `response ${id}`);
	return responses.get(id);
}

async function prompt(id, message) {
	const before = settled.length;
	send({ id, type: "prompt", message });
	await until(() => settled.length > before, `agent_settled after ${id}`, 40_000);
}

async function level() {
	const state = await request(`s${Date.now()}`, { type: "get_state" });
	return state.data?.thinkingLevel;
}

function fail(message) {
	console.error(`FAIL: ${message}`);
	if (notices.length) console.error(`notices: ${notices.join(" | ")}`);
	if (stderr.length) console.error(`stderr: ${stderr.join("").slice(-500)}`);
	finish(1);
}

function finish(code) {
	if (finished) return;
	finished = true;
	clearTimeout(timer);
	child?.kill("SIGKILL");
	server.close();
	rmSync(root, { recursive: true, force: true });
	if (code === 0) {
		console.log("e2e ok: default no judge → heavy→xhigh → light→medium → judge error→high → manual level pauses → off restores");
	}
	process.exit(code);
}

const timer = setTimeout(() => fail("timed out"), TIMEOUT_MS);

try {
	child = startPi();
	await sleep(3000);
	await request("m1", { type: "set_model", provider: "stub", modelId: "stub-main" });
	await request("t1", { type: "set_thinking_level", level: "low" });

	// 1. Default: no judge.
	await prompt("p0", "HEAVY but auto-effort is off");
	if (judgeRequests.length !== 0) throw new Error("the judge ran while auto-effort was off");
	if (mainRequests.at(-1)?.reasoning_effort !== "low") throw new Error(`default changed the level: ${mainRequests.at(-1)?.reasoning_effort}`);

	// 2. Heavy prompt → xhigh.
	await request("c1", { type: "prompt", message: "/auto-effort on" });
	await until(() => notices.some((notice) => /Auto-effort on/.test(notice)), "auto-effort on notice");
	await prompt("p1", "HEAVY refactor the whole auth module across files");
	if (judgeRequests.length !== 1) throw new Error(`expected 1 judge call, got ${judgeRequests.length}`);
	if (!allText(judgeRequests[0]).includes("HEAVY refactor")) throw new Error("the judge did not see the prompt");
	if (mainRequests.at(-1)?.reasoning_effort !== "xhigh") throw new Error(`heavy prompt ran at ${mainRequests.at(-1)?.reasoning_effort}`);

	// 3. Light prompt → medium.
	await prompt("p2", "rename one variable");
	if (mainRequests.at(-1)?.reasoning_effort !== "medium") throw new Error(`light prompt ran at ${mainRequests.at(-1)?.reasoning_effort}`);
	if (notices.some((notice) => /paused/.test(notice))) throw new Error("auto-effort paused itself");

	// 4. Judge error → high.
	await prompt("p3", "JUDGE-ERROR fix it");
	if (mainRequests.at(-1)?.reasoning_effort !== "high") throw new Error(`judge error ran at ${mainRequests.at(-1)?.reasoning_effort}`);
	if (!notices.some((notice) => /judge failed/.test(notice))) throw new Error("no judge-failed warning");

	// 5. Manual level pauses it.
	await request("t2", { type: "set_thinking_level", level: "minimal" });
	await until(() => notices.some((notice) => /auto-effort paused/.test(notice)), "pause notice", 5000);
	const judgedBefore = judgeRequests.length;
	await prompt("p4", "HEAVY again");
	if (judgeRequests.length !== judgedBefore) throw new Error("paused auto-effort still called the judge");
	if (mainRequests.at(-1)?.reasoning_effort !== "minimal") throw new Error(`paused run used ${mainRequests.at(-1)?.reasoning_effort}`);

	// 6. On, then off → back to the level from before.
	await request("c2", { type: "prompt", message: "/auto-effort on" });
	await prompt("p5", "HEAVY once more");
	if ((await level()) !== "xhigh") throw new Error("auto-effort did not resume");
	await request("c3", { type: "prompt", message: "/auto-effort off" });
	await until(() => notices.some((notice) => /back to minimal/.test(notice)), "off notice", 5000);
	if ((await level()) !== "minimal") throw new Error(`off did not restore: ${await level()}`);

	if (extensionErrors.length) throw new Error(`extension error: ${extensionErrors[0]}`);
	finish(0);
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
}
