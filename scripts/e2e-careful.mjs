#!/usr/bin/env node
/**
 * End-to-end check for /hati-hati against a real Pi process.
 *
 * A scripted OpenAI-compatible stub drives Pi's real tool loop:
 *   1. a read-only command                     → runs without a dialog
 *   2. `rm -rf <work>/keep` (destructive)       → dialog, the test answers NO  → file survives
 *   3. `rm -rf <work>/gone`                     → dialog, the test answers YES → file removed
 *   4. final answer without "### Rollback"      → pi-modes asks once for it
 * Combined with gercep on, `npm test` must also stay blocked.
 *
 * Usage:  node scripts/e2e-careful.mjs
 *         PI_MODES_EXTENSION=npm:@fahrizkyputra/pi-modes node scripts/e2e-careful.mjs
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TIMEOUT_MS = 120_000;
const extensionSpec =
	process.env.PI_MODES_EXTENSION ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "pi-modes.ts");

const root = mkdtempSync(join(tmpdir(), "pi-modes-careful-"));
const agentDir = join(root, "agent");
// Outside any temp dir pattern, so rm -rf is genuinely "destructive".
const workDir = join(process.env.HOME, `.pi-modes-e2e-${process.pid}`);
const sessionDir = join(root, "sessions");
for (const dir of [agentDir, workDir, sessionDir]) mkdirSync(dir, { recursive: true });
mkdirSync(join(workDir, "keep"), { recursive: true });
mkdirSync(join(workDir, "gone"), { recursive: true });
writeFileSync(join(workDir, "keep", "data.txt"), "keep\n");
writeFileSync(join(workDir, "gone", "data.txt"), "gone\n");
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));

const FINAL_WITH_ROLLBACK = [
	"Removed the old folder.",
	"",
	"### Rollback",
	"- `rm -rf gone`",
	"  → restore it from backup or git: `git checkout -- gone`",
	"",
	"Cannot be rolled back: -",
].join("\n");

function messagesText(body) {
	return body.messages.map((message) => JSON.stringify(message)).join("\n");
}
function lastUser(body) {
	const last = [...body.messages].reverse().find((message) => message.role === "user");
	return last ? JSON.stringify(last.content) : "";
}
function systemText(body) {
	return body.messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => JSON.stringify(m.content)).join("\n");
}

const requests = [];
function nextMove(body) {
	const text = messagesText(body);
	if (!text.includes("call_read")) return { tool: { id: "call_read", name: "bash", args: { command: "ls -la" } } };
	if (!text.includes("call_test")) return { tool: { id: "call_test", name: "bash", args: { command: "npm test" } } };
	if (!text.includes("call_keep")) return { tool: { id: "call_keep", name: "bash", args: { command: `rm -rf ${join(workDir, "keep")}` } } };
	if (!text.includes("call_gone")) return { tool: { id: "call_gone", name: "bash", args: { command: `rm -rf ${join(workDir, "gone")}` } } };
	if (lastUser(body).includes("did not end with") || text.includes("did not end with \\\"### Rollback")) return { text: FINAL_WITH_ROLLBACK };
	return { text: "Removed the old folder." };
}

function sse(response, delta, finish) {
	response.write(
		`data: ${JSON.stringify({
			id: "stub", object: "chat.completion.chunk", created: 0, model: "stub-model",
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
		if (body.messages.length > 0) requests.push(body);
		const move = nextMove(body);
		response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		if (move.tool) {
			sse(response, { role: "assistant", tool_calls: [{ index: 0, id: move.tool.id, type: "function", function: { name: move.tool.name, arguments: JSON.stringify(move.tool.args) } }] }, null);
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
writeFileSync(stubExtension, `export default function (pi) {
	pi.registerProvider("stub", { baseUrl: "http://127.0.0.1:${port}/v1", apiKey: "stub-key", api: "openai-completions",
		models: [{ id: "stub-model", name: "Stub", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 }] });
}
`);

const confirms = [];
const extensionErrors = [];
const stderr = [];
let finished = false;
const child = spawn("pi", ["--mode", "rpc", "-e", stubExtension, "-e", extensionSpec], {
	cwd: workDir,
	env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: sessionDir, PI_MODES_ACTIVE: "", PI_MODES_CAREFUL: "" },
	stdio: ["pipe", "pipe", "pipe"],
});
child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
const send = (payload) => child.stdin.write(`${JSON.stringify(payload)}\n`);
const settled = [];

let buffer = "";
child.stdout.on("data", (chunk) => {
	buffer += chunk.toString();
	let index = buffer.indexOf("\n");
	while (index >= 0) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		index = buffer.indexOf("\n");
		if (!line) continue;
		let event;
		try { event = JSON.parse(line); } catch { continue; }
		if (event.type === "extension_error") extensionErrors.push(line.slice(0, 300));
		if (event.type === "agent_settled") settled.push(event);
		if (event.type === "extension_ui_request" && event.method === "confirm") {
			confirms.push(event);
			// Decline the first destructive action (the `keep` folder), accept the rest.
			const decline = String(event.message).includes(`${join(workDir, "keep")}`);
			send({ type: "extension_ui_response", id: event.id, confirmed: !decline });
		}
	}
});

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function waitUntil(predicate, label, ms = 40_000) {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > ms) throw new Error(`timed out waiting for ${label}`);
		await sleep(100);
	}
}

function fail(message) {
	console.error(`FAIL: ${message}`);
	if (stderr.length) console.error(`stderr: ${stderr.join("").slice(-500)}`);
	finish(1);
}
function finish(code) {
	if (finished) return;
	finished = true;
	clearTimeout(timer);
	child.kill("SIGKILL");
	server.close();
	rmSync(root, { recursive: true, force: true });
	rmSync(workDir, { recursive: true, force: true });
	if (code === 0) console.log("e2e ok: read passes → npm test blocked (gercep) → decline keeps the folder → approve removes it → rollback follow-up");
	process.exit(code);
}
const timer = setTimeout(() => fail("timed out"), TIMEOUT_MS);

try {
	await sleep(3000);
	send({ id: "m", type: "set_model", provider: "stub", modelId: "stub-model" });
	await sleep(400);
	send({ id: "c1", type: "prompt", message: "/gercep on" });
	send({ id: "c2", type: "prompt", message: "/hati-hati on" });
	await sleep(800);

	const before = settled.length;
	const start = requests.length;
	send({ id: "p1", type: "prompt", message: "clean up the old folders" });
	await waitUntil(() => settled.length > before, "the run to settle");
	const run = requests.slice(start);

	if (!systemText(run[0]).includes("HATI-HATI (CAREFUL) MODE IS ACTIVE")) throw new Error("hati-hati rules missing from the system prompt");
	if (!systemText(run[0]).includes("GERCEP MODE IS ACTIVE")) throw new Error("gercep rules missing while both modes are on");

	const askedFor = confirms.map((event) => String(event.message));
	if (askedFor.some((message) => message.includes("ls -la"))) throw new Error("a read-only command asked for confirmation");
	if (askedFor.length !== 2) throw new Error(`expected 2 confirmations, saw ${askedFor.length}: ${askedFor.join(" | ")}`);

	const all = run.map(messagesText).join("\n");
	if (!all.includes("Blocked by gercep mode")) throw new Error("npm test was not blocked by gercep");
	if (!all.includes("Declined by the user")) throw new Error("the declined command did not report a decline");
	if (!existsSync(join(workDir, "keep", "data.txt"))) throw new Error("the declined rm -rf still ran");
	if (existsSync(join(workDir, "gone"))) throw new Error("the approved rm -rf did not run");
	if (!all.includes("did not end with \\\"### Rollback")) throw new Error("no rollback follow-up after the approved risky command");
	if (extensionErrors.length) throw new Error(`extension error: ${extensionErrors[0]}`);
	finish(0);
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
}
