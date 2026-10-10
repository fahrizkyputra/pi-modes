/**
 * Wiring: the extension entry point driven through fake Pi events.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piModesExtension from "../extensions/pi-modes.ts";
import { ENV_FLAG } from "../src/gercep.ts";

type Handler = (event: any, ctx: any) => unknown;

function fakePi(branch: unknown[] = []) {
	const hooks: Record<string, Handler[]> = {};
	const commands: Record<string, { handler: (args: string, ctx: any) => Promise<void> }> = {};
	const entries: { customType: string; data: unknown }[] = [];
	const notices: string[] = [];
	const statuses: (string | undefined)[] = [];

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
	} as unknown as ExtensionAPI;

	const ctx = {
		ui: {
			notify: (message: string) => notices.push(message),
			setStatus: (_key: string, text: string | undefined) => statuses.push(text),
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

	return { pi, ctx, hooks, commands, entries, notices, statuses, emit, branch };
}

function promptEvent(prompt: string) {
	return { prompt, systemPromptOptions: { sections: {} as Record<string, string>, cwd: "/tmp" } };
}

afterEach(() => {
	delete process.env[ENV_FLAG];
});

test("default mode: no prompt section, no blocks, no follow-up", async () => {
	const { pi, emit } = fakePi();
	piModesExtension(pi);
	await emit("session_start", { reason: "startup" });

	const event = promptEvent("ubah header");
	await emit("before_agent_start", event);
	assert.equal(event.systemPromptOptions.sections.gercep_mode, undefined);

	assert.equal(await emit("tool_call", { toolName: "bash", input: { command: "npm test" } }), undefined);
	await emit("tool_result", { toolName: "write", input: { path: "src/a.ts" }, isError: false });
	await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Selesai." }] } });
	assert.equal(await emit("agent_before_settle", { outcome: "completed" }), undefined);
});

test("/gercep on injects rules, blocks tests, and persists the mode", async () => {
	const { pi, ctx, emit, commands, entries, statuses } = fakePi();
	piModesExtension(pi);
	await emit("session_start", { reason: "startup" });
	await commands.gercep!.handler("", ctx);

	assert.deepEqual(entries.at(-1), { customType: "pi-modes-state", data: { mode: "gercep" } });
	assert.equal(statuses.at(-1), "⚡ gercep");
	assert.equal(process.env[ENV_FLAG], "gercep");

	const event = promptEvent("tambah tombol logout");
	await emit("before_agent_start", event);
	assert.match(event.systemPromptOptions.sections.gercep_mode ?? "", /GERCEP MODE IS ACTIVE/);

	const blocked = (await emit("tool_call", { toolName: "bash", input: { command: "npm test" } })) as {
		block: boolean;
		reason: string;
	};
	assert.equal(blocked.block, true);
	assert.match(blocked.reason, /Blocked by gercep mode/);
	assert.equal(await emit("tool_call", { toolName: "bash", input: { command: "npm run dev" } }), undefined);
});

test("a missing checklist triggers exactly one follow-up", async () => {
	const { pi, ctx, emit, commands } = fakePi();
	piModesExtension(pi);
	await emit("session_start", { reason: "startup" });
	await commands.gercep!.handler("on", ctx);
	await emit("before_agent_start", promptEvent("ubah header"));

	await emit("tool_result", { toolName: "edit", input: { path: "src/header.tsx" }, isError: false });
	await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Header sudah diubah." }] } });

	const first = (await emit("agent_before_settle", { outcome: "completed" })) as {
		continue: boolean;
		entries: { content: string; display: boolean }[];
	};
	assert.equal(first.continue, true);
	assert.match(first.entries[0]?.content ?? "", /src\/header\.tsx/);
	assert.equal(first.entries[0]?.display, false);

	await emit("message_end", { message: { role: "assistant", content: "Masih tanpa checklist." } });
	assert.equal(await emit("agent_before_settle", { outcome: "completed" }), undefined, "no second nudge");
});

test("a failed write does not count as a change, and aborted runs are not nudged", async () => {
	const { pi, ctx, emit, commands } = fakePi();
	piModesExtension(pi);
	await emit("session_start", { reason: "startup" });
	await commands.gercep!.handler("on", ctx);
	await emit("before_agent_start", promptEvent("ubah header"));

	await emit("tool_result", { toolName: "write", input: { path: "src/a.ts" }, isError: true });
	await emit("message_end", { message: { role: "assistant", content: "Gagal." } });
	assert.equal(await emit("agent_before_settle", { outcome: "completed" }), undefined);

	await emit("tool_result", { toolName: "write", input: { path: "src/a.ts" }, isError: false });
	assert.equal(await emit("agent_before_settle", { outcome: "aborted" }), undefined);
});

test("the mode survives a reload through the persisted entry", async () => {
	const branch: unknown[] = [];
	const first = fakePi(branch);
	piModesExtension(first.pi);
	await first.emit("session_start", { reason: "startup" });
	await first.commands.gercep!.handler("on", first.ctx);

	const reloaded = fakePi(branch);
	piModesExtension(reloaded.pi);
	await reloaded.emit("session_start", { reason: "reload" });
	assert.equal(reloaded.statuses.at(-1), "⚡ gercep");

	await reloaded.commands.gercep!.handler("off", reloaded.ctx);
	const again = fakePi(branch);
	piModesExtension(again.pi);
	await again.emit("session_start", { reason: "resume" });
	assert.equal(again.statuses.at(-1), undefined, "off is persisted too");
});

test("a subagent inherits gercep through the environment", async () => {
	process.env[ENV_FLAG] = "gercep";
	const child = fakePi();
	piModesExtension(child.pi);
	await child.emit("session_start", { reason: "startup" });
	assert.equal(child.statuses.at(-1), "⚡ gercep");
	const blocked = (await child.emit("tool_call", { toolName: "bash", input: { command: "pytest" } })) as { block: boolean };
	assert.equal(blocked.block, true);
});

test("an explicit request in the prompt unlocks that category through the wiring", async () => {
	const { pi, ctx, emit, commands } = fakePi();
	piModesExtension(pi);
	await emit("session_start", { reason: "startup" });
	await commands.gercep!.handler("on", ctx);
	await emit("before_agent_start", promptEvent("jalankan test dulu"));
	assert.equal(await emit("tool_call", { toolName: "bash", input: { command: "npm test" } }), undefined);
	const build = (await emit("tool_call", { toolName: "bash", input: { command: "npm run build" } })) as { block: boolean };
	assert.equal(build.block, true);
});

test("/gercep status and unknown arguments", async () => {
	const { pi, ctx, emit, commands, notices } = fakePi();
	piModesExtension(pi);
	await emit("session_start", { reason: "startup" });
	await commands.gercep!.handler("status", ctx);
	assert.match(notices.at(-1) ?? "", /Mode: default/);
	await commands.gercep!.handler("wat", ctx);
	assert.match(notices.at(-1) ?? "", /Unknown argument/);
});
