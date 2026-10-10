#!/usr/bin/env node
/**
 * End-to-end check against a real Pi process.
 *
 * A local OpenAI-compatible stub plays the model and scripts its moves, so the
 * test drives Pi's real tool loop:
 *   1. /gercep on, then a prompt
 *   2. model calls `bash npm test`          → pi-modes must block it
 *   3. model writes src/feature.txt         → allowed, counts as a change
 *   4. model answers without a checklist    → pi-modes must ask for one
 *   5. model answers with "### QA checklist"
 * It also checks that the gercep rules reach the system prompt, that default
 * mode adds nothing, and that the mode survives a session reopen.
 *
 * Usage:  npm run test:e2e
 *         PI_MODES_EXTENSION=npm:@fahrizkyputra/pi-modes npm run test:e2e
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TIMEOUT_MS = 120_000;
const extensionSpec =
	process.env.PI_MODES_EXTENSION ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "pi-modes.ts");

const root = mkdtempSync(join(tmpdir(), "pi-modes-e2e-"));
const agentDir = join(root, "agent");
const workDir = join(root, "work");
const sessionDir = join(root, "sessions");
for (const dir of [agentDir, workDir, sessionDir]) mkdirSync(dir, { recursive: true });
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));

// ---- scripted model -------------------------------------------------------
const requests = [];
const FINAL_WITH_CHECKLIST = [
	"Feature file added.",
	"",
	"### QA checklist",
	"- [ ] Open src/feature.txt",
	"      → it contains `hello`",
	"",
	"Not verified: tests and build were skipped (gercep).",
].join("\n");

function lastToolResult(body) {
	const last = body.messages.at(-1);
	return last?.role === "tool" ? (typeof last.content === "string" ? last.content : JSON.stringify(last.content)) : undefined;
}

function systemText(body) {
	return body.messages
		.filter((message) => message.role === "system" || message.role === "developer")
		.map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
		.join("\n");
}

function allText(body) {
	// Whole messages, so tool_calls and tool_call_id are visible too.
	return body.messages.map((message) => JSON.stringify(message)).join("\n");
}

/** Decide the stub model's next move from the conversation so far. */
function nextMove(body) {
	const text = allText(body);
	if (lastUserLike(body).includes("DEFAULT-PROBE")) return { text: "ok" };
	if (!text.includes("call_test")) return { tool: { id: "call_test", name: "bash", args: { command: "npm test" } } };
	if (!text.includes("call_write")) return { tool: { id: "call_write", name: "write", args: { path: "src/feature.txt", content: "hello\n" } } };
	if (text.includes("did not end with") && text.includes("QA checklist")) return { text: FINAL_WITH_CHECKLIST };
	return { text: "Feature file added." };
}

function sse(response, delta, finish) {
	response.write(
		`data: ${JSON.stringify({
			id: "stub",
			object: "chat.completion.chunk",
			created: 0,
			model: "stub-model",
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
		// Some requests (cache warming, probes) carry no chat messages.
		const body = { ...parsed, messages: Array.isArray(parsed.messages) ? parsed.messages : [] };
		if (body.messages.length > 0) requests.push(body);
		const move = nextMove(body);
		response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		if (move.tool) {
			sse(response, {
				role: "assistant",
				tool_calls: [{ index: 0, id: move.tool.id, type: "function", function: { name: move.tool.name, arguments: JSON.stringify(move.tool.args) } }],
			}, null);
			sse(response, {}, "tool_calls");
		} else {
			sse(response, { role: "assistant", content: move.text }, null);
			sse(response, {}, "stop");
		}
		response.end("data: [DONE]\n\n");
	});
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const port = server.address().port;

const stubExtension = join(root, "stub-provider.ts");
writeFileSync(
	stubExtension,
	`export default function (pi) {
	pi.registerProvider("stub", {
		baseUrl: "http://127.0.0.1:${port}/v1",
		apiKey: "stub-key",
		api: "openai-completions",
		models: [{ id: "stub-model", name: "Stub", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 }],
	});
}
`,
);

// ---- pi process -----------------------------------------------------------
const extensionErrors = [];
const notices = [];
const stderr = [];
let child;
let finished = false;

function startPi(extraArgs) {
	const proc = spawn("pi", ["--mode", "rpc", ...extraArgs, "-e", stubExtension, "-e", extensionSpec], {
		cwd: workDir,
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: sessionDir, PI_MODES_ACTIVE: "" },
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

const waiters = [];
const settled = [];
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
	for (const waiter of [...waiters]) waiter(event);
}

function waitFor(predicate, label, ms = 30_000) {
	return new Promise((resolveWait, rejectWait) => {
		const timer = setTimeout(() => rejectWait(new Error(`timed out waiting for ${label}`)), ms);
		const waiter = (event) => {
			if (!predicate(event)) return;
			clearTimeout(timer);
			waiters.splice(waiters.indexOf(waiter), 1);
			resolveWait(event);
		};
		waiters.push(waiter);
	});
}

const send = (payload) => child.stdin.write(`${JSON.stringify(payload)}\n`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function fail(message) {
	console.error(`FAIL: ${message}`);
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
	if (code === 0) console.log("e2e ok: default untouched → /gercep on → npm test blocked → write allowed → QA follow-up → mode survives reopen");
	process.exit(code);
}

const timer = setTimeout(() => fail("timed out"), TIMEOUT_MS);

async function prompt(id, message) {
	const before = settled.length;
	send({ id, type: "prompt", message });
	await waitFor(() => settled.length > before, `agent_settled after ${id}`, 40_000);
}

try {
	child = startPi([]);
	await sleep(3000);
	send({ id: "m1", type: "set_model", provider: "stub", modelId: "stub-model" });
	await sleep(500);

	// Default mode adds nothing.
	await prompt("p0", "DEFAULT-PROBE say ok");
	const defaultRequest = requests.at(-1);
	if (systemText(defaultRequest).includes("GERCEP MODE")) throw new Error("default mode leaked gercep rules into the prompt");

	// Gercep on.
	send({ id: "c1", type: "prompt", message: "/gercep on" });
	await waitFor((event) => event.type === "response" && event.id === "c1", "/gercep on response");
	await sleep(300);
	if (!notices.some((notice) => /Gercep on/.test(notice))) throw new Error(`no gercep-on notice: ${notices.join(" | ")}`);

	const start = requests.length;
	await prompt("p1", "add a feature file");
	const run = requests.slice(start);

	if (!systemText(run[0]).includes("GERCEP MODE IS ACTIVE")) throw new Error("gercep rules missing from the system prompt");
	const testResult = run.map(lastToolResult).find((result) => result && /npm test|gercep/i.test(result));
	if (!testResult || !/Blocked by gercep mode/.test(testResult)) throw new Error(`npm test was not blocked: ${testResult}`);
	if (!existsSync(join(workDir, "src", "feature.txt"))) throw new Error("the allowed write did not happen");
	const followUp = run.some((body) => allText(body).includes("did not end with"));
	if (!followUp) throw new Error("no QA follow-up was requested after the checklist-less answer");
	const followUps = run.filter((body) => lastUserLike(body).includes("did not end with")).length;
	if (followUps > 1) throw new Error(`follow-up sent ${followUps} times`);
	if (extensionErrors.length) throw new Error(`extension error: ${extensionErrors[0]}`);

	// Reopen the same session: gercep must still be on.
	child.kill("SIGKILL");
	await sleep(500);
	const sessionFile = readdirSync(sessionDir).filter((file) => file.endsWith(".jsonl")).map((file) => join(sessionDir, file))[0];
	if (!sessionFile) throw new Error("no session file was written");
	child = startPi(["--session", sessionFile]);
	await sleep(3000);
	send({ id: "m2", type: "set_model", provider: "stub", modelId: "stub-model" });
	await sleep(500);
	const reopenStart = requests.length;
	await prompt("p2", "DEFAULT-PROBE after reopen");
	const reopened = requests.slice(reopenStart);
	if (!reopened.length || !systemText(reopened[0]).includes("GERCEP MODE IS ACTIVE")) {
		throw new Error("gercep did not survive reopening the session");
	}

	finish(0);
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
}

function lastUserLike(body) {
	const last = [...body.messages].reverse().find((message) => message.role === "user");
	return last ? (typeof last.content === "string" ? last.content : JSON.stringify(last.content)) : "";
}
