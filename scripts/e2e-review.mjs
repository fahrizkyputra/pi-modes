#!/usr/bin/env node
/**
 * End-to-end check of /auto-review and /review against a real Pi process.
 *
 * A local OpenAI-compatible stub serves "stub-main" (the coding agent) and
 * "stub-reviewer" (the reviewer). Both answer from the request text. The work
 * directory is a real git repository. The script checks:
 *   1. default: the agent writes a risky file, nothing is reviewed
 *   2. /review: the last task is reviewed, the major finding goes back to the
 *      agent, the agent fixes it, the fix is re-reviewed once
 *   3. /auto-review on: the next task is reviewed automatically at xhigh,
 *      with a read tool call by the reviewer, report + fix + re-review
 *   4. /auto-review off: no review
 *   5. the reviewer request never reaches the main model and carries the diff
 *
 * Usage:  npm run test:e2e
 */

import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TIMEOUT_MS = 180_000;
const extensionSpec =
	process.env.PI_MODES_EXTENSION ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "pi-modes.ts");

const root = mkdtempSync(join(tmpdir(), "pi-modes-e2e-review-"));
const agentDir = join(root, "agent");
const workDir = join(root, "work");
const sessionDir = join(root, "sessions");
for (const dir of [agentDir, workDir, sessionDir]) mkdirSync(dir, { recursive: true });
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
writeFileSync(join(agentDir, "pi-modes.json"), JSON.stringify({ autoReview: { model: "stub/stub-reviewer" } }));
const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: workDir, encoding: "utf8" });
git("init", "-q");
writeFileSync(join(workDir, "README.md"), "demo\n");
git("add", "-A");
git("commit", "-q", "-m", "init");

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
	findings: [
		{ severity: "major", file: "src/auth/limit.ts", line: 1, title: "counter kept in memory", fix: "use a shared store" },
		{ severity: "minor", title: "no Retry-After header" },
	],
	checked: ["bypass"],
});
const CLEAN = JSON.stringify({ findings: [], checked: ["the fix"] });

function reviewerMove(body) {
	const text = allText(body);
	if (text.includes("RE-REVIEW")) return { text: CLEAN };
	// First look: read the file with a tool, then answer.
	if (!text.includes("call_review_read")) return { tool: { id: "call_review_read", name: "read", args: { path: "src/auth/limit.ts" } } };
	return { text: "```json\n" + MAJOR + "\n```" };
}

function mainMove(body) {
	const text = allText(body);
	const user = lastUser(body);
	// A fix request is the last user message: write a fresh fix each time.
	if (user.includes("Fix each one") && body.messages.at(-1)?.role === "user") {
		return { tool: { id: `call_fix_${mainRequests.length}`, name: "write", args: { path: "src/auth/limit.ts", content: `export const counter = sharedStore(); // SHARED-STORE-FIX ${mainRequests.length}\n` } } };
	}
	const lastAssistant = [...body.messages].reverse().find((message) => message.role === "assistant");
	if (body.messages.at(-1)?.role === "tool" && JSON.stringify(lastAssistant ?? {}).includes("call_fix_")) return { text: "Moved the counter to a shared store." };
	for (const task of ["TASK-ONE", "TASK-TWO", "TASK-THREE"]) {
		if (user.includes(task) && !text.includes(`call_${task}`)) {
			return { tool: { id: `call_${task}`, name: "write", args: { path: "src/auth/limit.ts", content: `export const counter = new Map(); // ${task}\n` } } };
		}
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
			{ id: "stub-main", name: "Stub main", reasoning: true, input: ["text"], cost, contextWindow: 64000, maxTokens: 2048,
				thinkingLevelMap: { xhigh: "xhigh", max: "max" } },
			{ id: "stub-reviewer", name: "Stub reviewer", reasoning: true, input: ["text"], cost, contextWindow: 64000, maxTokens: 2048,
				thinkingLevelMap: { xhigh: "xhigh", max: "max" } },
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
	// /review sends its report with sendMessage (message_end); the settle boundary commits
	// its report as a session entry (entry_appended).
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

/** Send a prompt and wait until Pi settles with no continuation left. */
async function promptAndSettle(id, message, settles = 1) {
	const before = settled.length;
	send({ id, type: "prompt", message });
	await until(() => settled.length >= before + settles, `settle after ${id}`, 60_000);
	await sleep(300);
}

const reports = () => customMessages.filter((message) => message.customType === "pi-modes-review");

function fail(message) {
	console.error(`FAIL: ${message}`);
	console.error(`reports: ${JSON.stringify(reports().map((r) => r.content))}`);
	console.error(`custom: ${JSON.stringify(customMessages.map((m) => m.customType))}`);
	console.error(`reviewer calls: ${reviewerRequests.length}, main calls: ${mainRequests.length}, settled: ${settled.length}`);
	console.error(`last main: ${mainRequests.length ? allText(mainRequests.at(-1)).slice(-600) : "-"}`);
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
			"e2e ok: default no review → /review → major fixed → re-review clean → /auto-review xhigh with reviewer read → off no review → user git state untouched",
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

	// 1. Default: risky file written, no review.
	await promptAndSettle("p1", "TASK-ONE add a login rate limiter");
	if (reviewerRequests.length !== 0) throw new Error("the reviewer ran in default mode");
	if (reports().length !== 0) throw new Error("a review report appeared in default mode");
	if (!readFileSync(join(workDir, "src/auth/limit.ts"), "utf8").includes("TASK-ONE")) throw new Error("the agent did not write the file");

	// 2. /review: report, fix as a new turn, re-review.
	const settledBefore = settled.length;
	await request("r1", { type: "prompt", message: "/review" });
	await until(() => reports().length >= 2, "review + re-review reports", 60_000);
	await until(() => settled.length > settledBefore, "the fix run settled", 30_000);
	await sleep(300);
	const [manualReport, manualReReview] = reports();
	if (!/^🔍 Review \(stub-reviewer · xhigh\) — 1 major, 1 minor/.test(manualReport.content)) throw new Error(`manual report: ${manualReport.content}`);
	if (manualReport.details?.scope !== "task") throw new Error("manual review scope is not task");
	if (!/^🔍 Re-review .* — no issues found/.test(manualReReview.content)) throw new Error(`manual re-review: ${manualReReview.content}`);
	if (!readFileSync(join(workDir, "src/auth/limit.ts"), "utf8").includes("SHARED-STORE-FIX")) throw new Error("the agent did not apply the fix");
	const firstReview = reviewerRequests.find((body) => !allText(body).includes("RE-REVIEW"));
	if (!allText(firstReview).includes("TASK-ONE add a login rate limiter")) throw new Error("the reviewer did not get the request");
	if (!allText(firstReview).includes("new Map()")) throw new Error("the reviewer did not get the diff");
	if (firstReview.reasoning_effort !== "xhigh") throw new Error(`risky path reviewed at ${firstReview.reasoning_effort}`);
	if (allText(firstReview).includes("Done.") && allText(firstReview).includes("TASK-ONE add a login rate limiter") && firstReview.messages.length > 6) {
		throw new Error("the reviewer saw the main conversation");
	}
	const fixMessage = customMessages.find((message) => message.customType === "pi-modes-review-fix");
	if (!fixMessage || fixMessage.display !== false) throw new Error("no hidden fix message");
	const fixText = typeof fixMessage.content === "string" ? fixMessage.content : JSON.stringify(fixMessage.content);
	if (!fixText.includes("counter kept in memory")) throw new Error("the major finding is not in the fix prompt");
	if (fixText.includes("no Retry-After header")) throw new Error("a minor finding was sent to fix");
	if (!mainRequests.some((body) => allText(body).includes("Fix each one"))) throw new Error("the fix prompt never reached the main agent");
	if (mainRequests.some((body) => body.model === "stub-reviewer")) throw new Error("routing mixup");

	// 3. /auto-review on: automatic review of the next task.
	await request("c1", { type: "prompt", message: "/auto-review on" });
	await until(() => notices.some((notice) => /Auto-review on/.test(notice)), "auto-review on notice");
	const reviewsBefore = reports().length;
	const reviewerCallsBefore = reviewerRequests.length;
	await promptAndSettle("p2", "TASK-TWO tighten the limiter");
	await until(() => reports().length >= reviewsBefore + 2, "auto review + re-review", 30_000);
	const autoReport = reports()[reviewsBefore];
	if (autoReport.details?.action !== "sent-to-fix") throw new Error(`auto review action ${autoReport.details?.action}`);
	if (reports()[reviewsBefore + 1].details?.round !== 2) throw new Error("no automatic re-review");
	const autoReviewerCalls = reviewerRequests.slice(reviewerCallsBefore);
	if (!autoReviewerCalls.some((body) => allText(body).includes("call_review_read"))) throw new Error("the reviewer never used its read tool");
	if (!autoReviewerCalls.some((body) => allText(body).includes("TASK-TWO"))) throw new Error("the read tool result did not reach the reviewer");

	// 4. /auto-review off: no review.
	await request("c2", { type: "prompt", message: "/auto-review off" });
	await until(() => notices.some((notice) => /Auto-review off/.test(notice)), "auto-review off notice");
	const reviewerCallsOff = reviewerRequests.length;
	await promptAndSettle("p3", "TASK-THREE once more");
	if (reviewerRequests.length !== reviewerCallsOff) throw new Error("reviewed while auto-review was off");

	// 5. The user's git state is untouched: nothing staged, no stash, one commit.
	if (git("diff", "--cached", "--name-only").trim() !== "") throw new Error("something got staged");
	if (git("stash", "list").trim() !== "") throw new Error("a stash was created");
	if (git("rev-list", "--count", "HEAD").trim() !== "1") throw new Error("a commit was created");

	if (extensionErrors.length) throw new Error(`extension errors: ${extensionErrors.join(" | ")}`);
	finish(0);
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
}
