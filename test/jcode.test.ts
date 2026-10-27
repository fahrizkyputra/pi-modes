import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { evaluate, isSelfApproval, turnsCarefulOff, writtenPaths, type GateInput } from "../jcode/gate.ts";
import { readHookCommands } from "../jcode/kit.ts";
import { latestUserTextFrom } from "../jcode/transcript.ts";

const ROOT = resolve(import.meta.dirname, "..");

// Unit tests must never touch the real jcode home.
process.env.JCODE_HOME = realpathSync(mkdtempSync(join(tmpdir(), "pi-modes-jcode-default-")));

/** Run `fn` with JCODE_HOME on a scratch folder, restored only after `fn` (sync or async) finishes. */
async function withHome(fn: (home: string) => unknown): Promise<void> {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "pi-modes-jcode-")));
	const previous = process.env.JCODE_HOME;
	process.env.JCODE_HOME = home;
	try {
		await fn(home);
	} finally {
		if (previous === undefined) delete process.env.JCODE_HOME;
		else process.env.JCODE_HOME = previous;
	}
}

const gate = (over: Partial<GateInput>): GateInput => ({
	toolName: "bash",
	input: {},
	sessionId: "s1",
	state: { modes: [], pending: [], approved: [] },
	latestUserText: () => undefined,
	approveCommand: "jcode-modes",
	...over,
});

// ---------------------------------------------------------------- gercep

test("default mode allows everything", () => {
	assert.deepEqual(evaluate(gate({ input: { command: "npm test" } })), { allow: true });
});

test("gercep blocks test/typecheck/lint/build segments and test-file writes, nothing else", () => {
	const state = { modes: ["gercep" as const], pending: [], approved: [] };
	for (const command of ["npm test", "cd app && npx vitest run", "npx tsc --noEmit", "bun run lint", "next build"]) {
		const result = evaluate(gate({ state, input: { command } }));
		assert.equal(result.allow, false, command);
		if (!result.allow) assert.match(result.reason, /jcode-modes off gercep/);
	}
	for (const command of ["npm run dev", "npm install", "git status", "ls"]) {
		assert.deepEqual(evaluate(gate({ state, input: { command } })), { allow: true }, command);
	}
	assert.equal(evaluate(gate({ state, toolName: "write", input: { file_path: "src/a.test.ts", content: "" } })).allow, false);
	assert.equal(evaluate(gate({ state, toolName: "edit", input: { file_path: "src/a.ts" } })).allow, true);
	const patch = "*** Begin Patch\n*** Add File: tests/x.py\n+x\n*** End Patch";
	assert.equal(evaluate(gate({ state, toolName: "apply_patch", input: { patch_text: patch } })).allow, false);
});

test("gercep lets through what the user's latest message explicitly asked for", () => {
	const state = { modes: ["gercep" as const], pending: [], approved: [] };
	assert.equal(evaluate(gate({ state, input: { command: "npm test" }, latestUserText: () => "tolong jalankan test" })).allow, true);
	assert.equal(evaluate(gate({ state, input: { command: "npm run build" }, latestUserText: () => "jalankan test tapi jangan build" })).allow, false);
	assert.equal(evaluate(gate({ state, input: { command: "npm test" }, latestUserText: () => "jangan test dulu" })).allow, false);
});

test("writtenPaths reads every jcode write tool shape", () => {
	assert.deepEqual(writtenPaths("write", { file_path: "a.ts" }), ["a.ts"]);
	assert.deepEqual(writtenPaths("patch", { patch_text: "--- a/x\n+++ b/src/x.spec.ts\n" }), ["src/x.spec.ts"]);
	assert.deepEqual(writtenPaths("bash", { command: "x" }), []);
});

// ---------------------------------------------------------------- hati-hati

test("hati-hati holds a risky command with a code; one approval lets exactly that command run once", () =>
	withHome(async () => {
		const { approveCode, loadState } = await import("../jcode/state.ts");
		const state = () => ({ ...loadState("s1"), modes: ["hati-hati" as const] });
		const command = "git push --force origin main";

		const held = evaluate(gate({ state: state(), input: { command } }));
		assert.equal(held.allow, false);
		const code = held.allow ? "" : (/approve ([0-9a-f]{6})/.exec(held.reason)?.[1] ?? "");
		assert.match(code, /^[0-9a-f]{6}$/);

		// Same command again before approval: same code, still held.
		const again = evaluate(gate({ state: state(), input: { command } }));
		assert.ok(!again.allow && again.reason.includes(code));

		assert.ok(approveCode(code, "s1"));
		assert.equal(evaluate(gate({ state: state(), input: { command: "git push --force origin develop" } })).allow, false);
		assert.deepEqual(evaluate(gate({ state: state(), input: { command } })), { allow: true });
		assert.equal(evaluate(gate({ state: state(), input: { command } })).allow, false, "approval is single-use");

		assert.equal(approveCode("ffffff", "s1"), undefined);
	}));

test("an approval without a session id finds the code across sessions", () =>
	withHome(async () => {
		const { approveCode, issueCode } = await import("../jcode/state.ts");
		const code = issueCode("other-session", "npm publish", ["publishes"]);
		assert.equal(approveCode(code, undefined)?.command, "npm publish");
	}));

test("the model cannot approve itself or switch hati-hati off without the user", () => {
	const state = { modes: ["hati-hati" as const], pending: [], approved: [] };
	for (const command of ["jcode-modes approve abc123", "~/.local/bin/jcode-modes approve abc123", "node /h/.jcode/plugins/pi-modes/jcode/cli.ts approve abc123"]) {
		assert.ok(isSelfApproval(command), command);
	}
	assert.ok(turnsCarefulOff("jcode-modes off hati-hati"));
	assert.ok(turnsCarefulOff("npx -y @fahrizkyputra/pi-modes jcode uninstall"));
	assert.ok(!turnsCarefulOff("jcode-modes off gercep"));
	return withHome(() => {
		const result = evaluate(gate({ state, input: { command: "jcode-modes approve abc123" } }));
		assert.ok(!result.allow && /must come from the user/.test(result.reason));
		const off = evaluate(gate({ state, input: { command: "jcode-modes off hati-hati" } }));
		assert.ok(!off.allow && /turns hati-hati off/.test(off.reason));
	});
});

test("read-only commands pass under hati-hati", () => {
	const state = { modes: ["hati-hati" as const], pending: [], approved: [] };
	for (const command of ["git status", "ssh host 'tail -n 50 /var/log/app.log'", "ls -la"]) {
		assert.deepEqual(evaluate(gate({ state, input: { command } })), { allow: true }, command);
	}
});

// ---------------------------------------------------------------- transcript

test("latest typed text skips tool results and system reminders, and reads the journal after the snapshot", () => {
	const snapshot = JSON.stringify({ messages: [{ role: "user", content: [{ type: "text", text: "old request" }] }] });
	const journal = [
		JSON.stringify({ meta: {}, append_messages: [{ role: "user", content: [{ type: "text", text: "jalankan test" }] }] }),
		JSON.stringify({ meta: {}, append_messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }] }),
		JSON.stringify({ meta: {}, append_messages: [{ role: "user", content: [{ type: "tool_result", content: "x" }] }] }),
		JSON.stringify({ meta: {}, append_messages: [{ role: "user", content: [{ type: "text", text: "<system-reminder>\nx" }] }] }),
		"{broken",
	].join("\n");
	assert.equal(latestUserTextFrom(snapshot, journal), "jalankan test");
	assert.equal(latestUserTextFrom(snapshot, undefined), "old request");
	assert.equal(latestUserTextFrom(undefined, undefined), undefined);
});

// ---------------------------------------------------------------- installer + hook, end to end

test("install, a mode turned on from a session, the real gate blocking, approval by code, uninstall", () => {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "pi-modes-jcode-e2e-")));
	const jcodeHome = join(home, ".jcode");
	const bin = join(home, ".local", "bin");
	mkdirSync(bin, { recursive: true });
	mkdirSync(jcodeHome, { recursive: true });
	const original = "[hooks]\npre_tool = \"~/bin/policy\"\n";
	writeFileSync(join(jcodeHome, "config.toml"), original);
	const env = { ...process.env, HOME: home, JCODE_HOME: jcodeHome, PATH: `${bin}:${process.env.PATH}` };
	const sh = (file: string, args: string[], extra: Record<string, string> = {}, input?: string) =>
		spawnSync(file, args, { env: { ...env, ...extra }, encoding: "utf8", input });

	const installed = sh(process.execPath, [join(ROOT, "bin", "jcode.mjs"), "jcode", "install"]);
	assert.equal(installed.status, 0, installed.stderr);
	const hooks = readHookCommands(readFileSync(join(jcodeHome, "config.toml"), "utf8"), "pre_tool");
	assert.equal(hooks[0], "~/bin/policy");
	const gateHook = hooks[1] ?? "";
	assert.ok(gateHook.endsWith("/plugins/pi-modes/hooks/gate.sh"));
	for (const mode of ["gercep", "hati-hati"]) {
		assert.ok(lstatSync(join(jcodeHome, "skills", mode)).isSymbolicLink());
		assert.match(readFileSync(join(jcodeHome, "skills", mode, "SKILL.md"), "utf8"), new RegExp(`jcode-modes on ${mode}`));
	}

	const session = { JCODE_SESSION_ID: "session_test_1" };
	const fire = (tool: string, input: object) =>
		sh(gateHook, [], { JCODE_HOOK_SESSION_ID: "session_test_1", JCODE_HOOK_TOOL_NAME: tool, JCODE_HOOK_CWD: home }, JSON.stringify(input));

	// No mode yet: the gate allows without starting Node.
	assert.equal(fire("bash", { command: "npm test" }).status, 0);

	const on = sh(join(bin, "jcode-modes"), ["on", "gercep"], session);
	assert.equal(on.status, 0, on.stderr);
	assert.match(on.stdout, /GERCEP MODE IS ACTIVE/);
	const blocked = fire("bash", { command: "npm test" });
	assert.equal(blocked.status, 2);
	assert.match(blocked.stderr, /Blocked by gercep mode/);
	assert.equal(fire("bash", { command: "npm run dev" }).status, 0);

	assert.equal(sh(join(bin, "jcode-modes"), ["on", "hati-hati"], session).status, 0);
	const held = fire("bash", { command: "npm publish" });
	assert.equal(held.status, 2);
	const code = /approve ([0-9a-f]{6})/.exec(held.stderr)?.[1] ?? "";
	assert.match(code, /^[0-9a-f]{6}$/);
	// The user's `!` line: no session id in its env.
	assert.equal(sh(join(bin, "jcode-modes"), ["approve", code]).status, 0);
	assert.equal(fire("bash", { command: "npm publish" }).status, 0);
	assert.equal(fire("bash", { command: "npm publish" }).status, 2);

	// Bad input fails open.
	assert.equal(sh(gateHook, [], { JCODE_HOOK_SESSION_ID: "session_test_1", JCODE_HOOK_TOOL_NAME: "bash" }, "nope").status, 0);

	assert.equal(sh(join(bin, "jcode-modes"), ["uninstall"]).status, 0);
	assert.equal(readFileSync(join(jcodeHome, "config.toml"), "utf8"), original);
	assert.ok(!existsSync(join(jcodeHome, "skills", "gercep")));
	assert.ok(!existsSync(join(bin, "jcode-modes")));
	assert.ok(!existsSync(join(jcodeHome, "pi-modes")));
});
