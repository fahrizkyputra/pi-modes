#!/usr/bin/env node
/**
 * End-to-end check of /review and /auto-review in a MONOREPO FOLDER against a real Pi process.
 *
 * The work folder is not a git repository; it holds three: api, web, idle. A local
 * OpenAI-compatible stub plays the coding agent (stub-main) and the reviewer (stub-reviewer).
 *   1. default: the agent changes api and web; no review runs
 *   2. /review: ONE review covers both repositories, with paths starting with the repository
 *      folder; `idle` is left out; the major finding goes back to the agent, which fixes api
 *      only; the re-review sees only the fix
 *   3. the user edits idle by hand; /review uncommitted covers idle too
 *   4. /review uncommitted with nothing left to review says so
 *   5. no repository got staged, stashed, or committed
 *
 * Usage:  node scripts/e2e-monorepo.mjs
 */

import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TIMEOUT_MS = 180_000;
const extensionSpec =
	process.env.PI_MODES_EXTENSION ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "pi-modes.ts");

const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-modes-e2e-mono-")));
const agentDir = join(root, "agent");
const workDir = join(root, "mono");
const sessionDir = join(root, "sessions");
for (const dir of [agentDir, workDir, sessionDir]) mkdirSync(dir, { recursive: true });
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
writeFileSync(join(agentDir, "pi-modes.json"), JSON.stringify({ autoReview: { model: "stub/stub-reviewer" } }));

const git = (dir, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, encoding: "utf8" });
const repos = {};
for (const name of ["api", "web", "idle"]) {
	const dir = join(workDir, name);
	mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q");
	writeFileSync(join(dir, "README.md"), `${name}\n`);
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "init");
	repos[name] = dir;
}
try {
	git(workDir, "rev-parse", "--show-toplevel");
	throw new Error("the monorepo folder must not be a git repository");
} catch (error) {
	if (error.message === "the monorepo folder must not be a git repository") throw error;
}

// ---- scripted models --------------------------------------------------------------
const mainRequests = [];
const reviewerRequests = [];
const allText = (body) => body.messages.map((message) => JSON.stringify(message)).join("\n");
const lastUser = (body) => {
	for (let index = body.messages.length - 1; index >= 0; index--) {
		const message = body.messages[index];
		if (message.role === "user") return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
	}
	return "";
};

const MAJOR = JSON.stringify({
	findings: [{ severity: "major", file: "api/src/auth/orders.ts", line: 1, title: "field amount not validated", fix: "validate it" }],
	checked: ["web caller"],
});
const CLEAN = JSON.stringify({ findings: [], checked: ["the fix"] });

function reviewerMove(body) {
	const text = allText(body);
	if (text.includes("RE-REVIEW")) return { text: CLEAN };
	if (!text.includes("call_read")) return { tool: { id: "call_read", name: "read", args: { path: "web/src/cart.ts" } } };
	return { text: "```json\n" + MAJOR + "\n```" };
}

function mainMove(body) {
	const user = lastUser(body);
	if (user.includes("Fix each one") && body.messages.at(-1)?.role === "user") {
		return { tool: { id: `call_fix_${mainRequests.length}`, name: "write", args: { path: join(repos.api, "src/auth/orders.ts"), content: "export const amount = validate(1); // FIXED\n" } } };
	}
	const lastAssistant = [...body.messages].reverse().find((message) => message.role === "assistant");
	if (body.messages.at(-1)?.role === "tool") {
		const calls = JSON.stringify(lastAssistant ?? {});
		if (calls.includes("call_api")) return { tool: { id: "call_web", name: "write", args: { path: join(repos.web, "src/cart.ts"), content: "import { amount } from 'api';\nexport const cart = amount;\n" } } };
		return { text: calls.includes("call_fix_") ? "Validated the amount." : "Renamed in api and web." };
	}
	if (user.includes("RENAME-TASK")) {
		return { tool: { id: "call_api", name: "write", args: { path: join(repos.api, "src/auth/orders.ts"), content: "export const amount = 1;\nexport const more = 2;\n" } } };
	}
	return { text: "Done." };
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
		response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		if (body.messages.length === 0) {
			sse(response, { role: "assistant", content: "" }, "stop");
			response.end("data: [DONE]\n\n");
			return;
		}
		let move;
		if (body.model === "stub-reviewer") {
			reviewerRequests.push(body);
			move = reviewerMove(body);
		} else {
			mainRequests.push(body);
			move = mainMove(body);
		}
		if (move.tool) {
			sse(response, { role: "assistant", content: null, tool_calls: [{ index: 0, id: move.tool.id, type: "function", function: { name: move.tool.name, arguments: JSON.stringify(move.tool.args) } }] }, null);
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
	const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	pi.registerProvider("stub", {
		baseUrl: "http://127.0.0.1:${port}/v1",
		apiKey: "stub-key",
		api: "openai-completions",
		models: [
			{ id: "stub-main", name: "Stub main", reasoning: true, input: ["text"], cost, contextWindow: 64000, maxTokens: 2048, thinkingLevelMap: { xhigh: "xhigh", max: "max" } },
			{ id: "stub-reviewer", name: "Stub reviewer", reasoning: true, input: ["text"], cost, contextWindow: 64000, maxTokens: 2048, thinkingLevelMap: { xhigh: "xhigh", max: "max" } },
		],
	});
}
`,
);

// ---- pi process ----------------------------------------------------------------------
const extensionErrors = [];
const notices = [];
const stderr = [];
const responses = new Map();
const settled = [];
const customMessages = [];
let child;
let finished = false;

function handle(line) {
	let event;
	try {
		event = JSON.parse(line);
	} catch {
		return;
	}
	if (event.type === "extension_error") extensionErrors.push(JSON.stringify(event).slice(0, 400));
	if (event.type === "extension_ui_request" && event.method === "notify") notices.push(String(event.message));
	if (event.type === "agent_settled") settled.push(event);
	if (event.type === "message_end" && event.message?.role === "custom") customMessages.push(event.message);
	if (event.type === "entry_appended" && event.entry?.type === "custom_message") customMessages.push(event.entry);
	if (event.type === "response" && event.id) responses.set(event.id, event);
}

function startPi() {
	const proc = spawn("pi", ["--mode", "rpc", "-e", stubExtension, "-e", extensionSpec], {
		cwd: workDir,
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: sessionDir, PI_MODES_ACTIVE: "", PI_MODES_CAREFUL: "", PI_SUBAGENT_CHILD: "" },
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

async function until(check, label, ms = 40_000) {
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

async function promptAndSettle(id, message) {
	const before = settled.length;
	send({ id, type: "prompt", message });
	await until(() => settled.length >= before + 1, `settle after ${id}`, 60_000);
	await sleep(300);
}

const reports = () => customMessages.filter((message) => message.customType === "pi-modes-review");
const contentOf = (message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content));

function fail(message) {
	console.error(`FAIL: ${message}`);
	console.error(`reports: ${JSON.stringify(reports().map(contentOf))}`);
	console.error(`reviewer calls: ${reviewerRequests.length}, main calls: ${mainRequests.length}, settled: ${settled.length}`);
	if (extensionErrors.length) console.error(`extension errors: ${extensionErrors.join(" | ")}`);
	if (notices.length) console.error(`notices: ${notices.join(" | ")}`);
	if (stderr.length) console.error(`stderr: ${stderr.join("").slice(-800)}`);
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
		console.log(
			"e2e ok: monorepo folder without git → api+web changed, no review → /review one report over both repos (idle left out) → fix api only → re-review → /review uncommitted adds idle → clean → git untouched",
		);
	}
	process.exit(code);
}

const timer = setTimeout(() => fail("timed out"), TIMEOUT_MS);

try {
	child = startPi();
	await sleep(3000);
	await request("m1", { type: "set_model", provider: "stub", modelId: "stub-main" });
	await request("t1", { type: "set_thinking_level", level: "medium" });

	// 1. Default: api and web change, nothing is reviewed.
	await promptAndSettle("p1", "RENAME-TASK rename total to amount in api and web");
	if (reviewerRequests.length !== 0) throw new Error("the reviewer ran in default mode");
	if (!readFileSync(join(repos.web, "src/cart.ts"), "utf8").includes("amount")) throw new Error("the agent did not change web");

	// 2. /review: one report over both repositories, fix goes to api only, re-review of the fix.
	const settledBefore = settled.length;
	await request("r1", { type: "prompt", message: "/review" });
	await until(() => reports().length >= 2, "review + re-review reports", 60_000);
	await until(() => settled.length > settledBefore, "the fix run settled", 30_000);
	await sleep(300);
	const [first, second] = reports();
	if (!/^🔍 Review \(stub-reviewer · xhigh\) — 1 major/.test(contentOf(first))) throw new Error(`first report: ${contentOf(first)}`);
	if (JSON.stringify(first.details?.repos) !== JSON.stringify(["api", "web"])) throw new Error(`repos in the report: ${JSON.stringify(first.details?.repos)}`);
	if (!/^🔍 Re-review .* — no issues found/.test(contentOf(second))) throw new Error(`re-review: ${contentOf(second)}`);
	const firstReview = reviewerRequests.find((body) => !allText(body).includes("RE-REVIEW"));
	const prompt = allText(firstReview);
	if (!prompt.includes("spans 2 separate git repositories: api, web")) throw new Error("the reviewer was not told about both repositories");
	if (!prompt.includes("api/src/auth/orders.ts") || !prompt.includes("web/src/cart.ts")) throw new Error("paths do not start with the repository folder");
	if (prompt.includes("idle")) throw new Error("the untouched repository leaked into the review");
	if (!allText(reviewerRequests.find((body) => allText(body).includes("call_read") && body.messages.at(-1)?.role === "tool")).includes("amount")) {
		throw new Error("the reviewer could not read a file in another repository");
	}
	const reReview = reviewerRequests.find((body) => allText(body).includes("RE-REVIEW"));
	if (allText(reReview).includes("web/src/cart.ts")) throw new Error("the re-review included web, which the fix did not touch");
	if (!readFileSync(join(repos.api, "src/auth/orders.ts"), "utf8").includes("FIXED")) throw new Error("the agent did not apply the fix in api");

	// 3. The user edits idle by hand; /review uncommitted covers it as well.
	writeFileSync(join(repos.idle, "by-hand.ts"), "edited by the user\n");
	const reportsBefore = reports().length;
	const reviewerCallsBefore = reviewerRequests.length;
	await request("r2", { type: "prompt", message: "/review uncommitted" });
	await until(() => reports().length > reportsBefore, "uncommitted report", 60_000);
	const uncommittedPrompt = allText(reviewerRequests[reviewerCallsBefore]);
	if (!uncommittedPrompt.includes("idle/by-hand.ts")) throw new Error("idle was not part of /review uncommitted");
	if (!uncommittedPrompt.includes("api/src/auth/orders.ts")) throw new Error("api was not part of /review uncommitted");
	if (!uncommittedPrompt.includes("3 repositories") && !uncommittedPrompt.includes("separate git repositories: api, idle, web")) {
		throw new Error("the reviewer was not told about all three repositories");
	}
	await sleep(1500);

	// 4. Nothing left uncommitted → a clear message. Commit everything, then ask again.
	for (const dir of Object.values(repos)) {
		git(dir, "add", "-A");
		git(dir, "commit", "-q", "-m", "all");
	}
	const callsBefore = reviewerRequests.length;
	await request("r3", { type: "prompt", message: "/review uncommitted" });
	await until(() => notices.some((notice) => /No uncommitted changes in 3 repositories/.test(notice)), "clean notice");
	if (reviewerRequests.length !== callsBefore) throw new Error("reviewed a clean tree");

	// 5. No staging, stash, or extra commit came from pi-modes: each repository has exactly init + all.
	for (const [name, dir] of Object.entries(repos)) {
		if (git(dir, "stash", "list").trim() !== "") throw new Error(`a stash was created in ${name}`);
		if (git(dir, "rev-list", "--count", "HEAD").trim() !== "2") throw new Error(`unexpected commits in ${name}`);
	}
	if (extensionErrors.length) throw new Error(`extension errors: ${extensionErrors.join(" | ")}`);
	finish(0);
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
}
