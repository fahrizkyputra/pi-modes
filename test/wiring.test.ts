/**
 * Wiring: the extension entry point driven through fake Pi events.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piModesExtension from "../extensions/pi-modes.ts";
import { ENV_FLAG } from "../src/gercep.ts";

type Handler = (event: any, ctx: any) => unknown;

function fakePi(branch: unknown[] = [], options: { confirm?: boolean; hasUI?: boolean } = {}) {
	const hooks: Record<string, Handler[]> = {};
	const commands: Record<string, { handler: (args: string, ctx: any) => Promise<void> }> = {};
	const entries: { customType: string; data: unknown }[] = [];
	const notices: string[] = [];
	const statuses: (string | undefined)[] = [];
	const workingMessages: (string | undefined)[] = [];

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

	const confirms: { title: string; message: string }[] = [];
	const ctx = {
		hasUI: options.hasUI ?? true,
		cwd: process.cwd(),
		ui: {
			notify: (message: string) => notices.push(message),
			setStatus: (_key: string, text: string | undefined) => statuses.push(text),
			setWorkingMessage: (text?: string) => workingMessages.push(text),
			confirm: async (title: string, message: string) => {
				confirms.push({ title, message });
				return options.confirm ?? true;
			},
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

	return { pi, ctx, hooks, commands, entries, notices, statuses, emit, branch, confirms, workingMessages };
}

function promptEvent(prompt: string) {
	return { prompt, systemPromptOptions: { sections: {} as Record<string, string>, cwd: "/tmp" } };
}

afterEach(() => {
	delete process.env[ENV_FLAG];
	delete process.env.PI_MODES_CAREFUL;
});

test("/hati-hati asks before a risky command and passes the safe ones", async () => {
	const { pi, ctx, emit, commands, confirms, statuses } = fakePi();
	piModesExtension(pi);
	await emit("session_start", { reason: "startup" });
	await commands["hati-hati"]!.handler("", ctx);
	assert.equal(statuses.at(-1), "🛡 hati-hati");
	assert.equal(process.env.PI_MODES_CAREFUL, "hati-hati");

	const event = promptEvent("deploy");
	await emit("before_agent_start", event);
	assert.match(event.systemPromptOptions.sections.hati_hati_mode ?? "", /HATI-HATI \(CAREFUL\) MODE IS ACTIVE/);
	assert.equal(event.systemPromptOptions.sections.gercep_mode, undefined, "modes are independent");

	assert.equal(await emit("tool_call", { toolCallId: "a", toolName: "bash", input: { command: "ssh prod 'systemctl status api'" } }), undefined);
	assert.equal(confirms.length, 0, "reads do not ask");

	assert.equal(await emit("tool_call", { toolCallId: "b", toolName: "bash", input: { command: "ssh prod 'systemctl restart api'" } }), undefined);
	assert.equal(confirms.length, 1);
	assert.match(confirms[0]?.title ?? "", /remote\/production/);
	assert.match(confirms[0]?.message ?? "", /systemctl restart api/);
	assert.match(confirms[0]?.message ?? "", /changes a running service on prod/);
});

test("a declined command is blocked with a reason the agent can act on", async () => {
	const { pi, ctx, emit, commands } = fakePi([], { confirm: false });
	piModesExtension(pi);
	await emit("session_start", { reason: "startup" });
	await commands["hati-hati"]!.handler("on", ctx);
	await emit("before_agent_start", promptEvent("publish"));

	const result = (await emit("tool_call", { toolCallId: "c", toolName: "bash", input: { command: "npm publish" } })) as {
		block: boolean;
		reason: string;
	};
	assert.equal(result.block, true);
	assert.match(result.reason, /Declined by the user/);
	assert.match(result.reason, /Do not retry it/);
});

test("without a UI, risky commands are refused without asking", async () => {
	const { pi, ctx, emit, commands, confirms } = fakePi([], { hasUI: false });
	piModesExtension(pi);
	await emit("session_start", { reason: "startup" });
	await commands["hati-hati"]!.handler("on", ctx);
	await emit("before_agent_start", promptEvent("clean"));
	const result = (await emit("tool_call", { toolCallId: "d", toolName: "bash", input: { command: "rm -rf src/legacy" } })) as {
		block: boolean;
		reason: string;
	};
	assert.equal(result.block, true);
	assert.match(result.reason, /no interactive UI/);
	assert.equal(confirms.length, 0);
});

test("a confirmed risky command that ran owes a rollback section, asked once", async () => {
	const { pi, ctx, emit, commands } = fakePi();
	piModesExtension(pi);
	await emit("session_start", { reason: "startup" });
	await commands["hati-hati"]!.handler("on", ctx);
	await emit("before_agent_start", promptEvent("restart"));

	await emit("tool_call", { toolCallId: "e", toolName: "bash", input: { command: "ssh prod 'systemctl restart api'" } });
	await emit("tool_result", { toolCallId: "e", toolName: "bash", input: { command: "ssh prod 'systemctl restart api'" }, isError: false });
	await emit("message_end", { message: { role: "assistant", content: "Restarted." } });

	const first = (await emit("agent_before_settle", { outcome: "completed" })) as { continue: boolean; entries: { content: string }[] };
	assert.equal(first.continue, true);
	assert.match(first.entries[0]?.content ?? "", /### Rollback/);
	assert.match(first.entries[0]?.content ?? "", /systemctl restart api/);
	assert.equal(await emit("agent_before_settle", { outcome: "completed" }), undefined, "at most once");
});

test("a rollback section in the answer satisfies the follow-up", async () => {
	const { pi, ctx, emit, commands } = fakePi();
	piModesExtension(pi);
	await emit("session_start", { reason: "startup" });
	await commands["hati-hati"]!.handler("on", ctx);
	await emit("before_agent_start", promptEvent("restart"));
	await emit("tool_call", { toolCallId: "f", toolName: "bash", input: { command: "npm publish" } });
	await emit("tool_result", { toolCallId: "f", toolName: "bash", input: { command: "npm publish" }, isError: false });
	await emit("message_end", {
		message: { role: "assistant", content: "Published.\n\n### Rollback\n- `npm publish`\n  → npm deprecate pkg@0.2.0\n\nCannot be rolled back: the version number." },
	});
	assert.equal(await emit("agent_before_settle", { outcome: "completed" }), undefined);
});

test("gercep and hati-hati combine: one follow-up with both requests", async () => {
	const { pi, ctx, emit, commands, statuses } = fakePi();
	piModesExtension(pi);
	await emit("session_start", { reason: "startup" });
	await commands.gercep!.handler("on", ctx);
	await commands["hati-hati"]!.handler("on", ctx);
	assert.equal(statuses.at(-1), "⚡ gercep · 🛡 hati-hati");

	const event = promptEvent("ship it");
	await emit("before_agent_start", event);
	assert.ok(event.systemPromptOptions.sections.gercep_mode);
	assert.ok(event.systemPromptOptions.sections.hati_hati_mode);

	const test = (await emit("tool_call", { toolCallId: "g", toolName: "bash", input: { command: "npm test" } })) as { block: boolean };
	assert.equal(test.block, true, "gercep still blocks tests");

	await emit("tool_result", { toolCallId: "h", toolName: "write", input: { path: "src/a.ts" }, isError: false });
	await emit("tool_call", { toolCallId: "i", toolName: "bash", input: { command: "git push origin main" } });
	await emit("tool_result", { toolCallId: "i", toolName: "bash", input: { command: "git push origin main" }, isError: false });
	await emit("message_end", { message: { role: "assistant", content: "Done." } });

	const followUp = (await emit("agent_before_settle", { outcome: "completed" })) as { entries: { content: string }[] };
	assert.equal(followUp.entries.length, 1, "a single combined entry");
	assert.match(followUp.entries[0]?.content ?? "", /QA checklist/);
	assert.match(followUp.entries[0]?.content ?? "", /### Rollback/);

	await commands.gercep!.handler("off", ctx);
	assert.equal(statuses.at(-1), "🛡 hati-hati", "turning one off keeps the other");
});

test("both modes persist independently and old 0.1.0 entries still load", async () => {
	const branch: unknown[] = [{ type: "custom", customType: "pi-modes-state", data: { mode: "gercep" } }];
	const first = fakePi(branch);
	piModesExtension(first.pi);
	await first.emit("session_start", { reason: "resume" });
	assert.equal(first.statuses.at(-1), "⚡ gercep", "a 0.1.0 entry without `careful` loads");

	await first.commands["hati-hati"]!.handler("on", first.ctx);
	const reopened = fakePi(branch);
	piModesExtension(reopened.pi);
	await reopened.emit("session_start", { reason: "resume" });
	assert.equal(reopened.statuses.at(-1), "⚡ gercep · 🛡 hati-hati");
});

test("a subagent inherits hati-hati through the environment", async () => {
	process.env.PI_MODES_CAREFUL = "hati-hati";
	const child = fakePi([], { hasUI: false });
	piModesExtension(child.pi);
	await child.emit("session_start", { reason: "startup" });
	assert.equal(child.statuses.at(-1), "🛡 hati-hati");
	const result = (await child.emit("tool_call", { toolCallId: "j", toolName: "bash", input: { command: "git push --force" } })) as {
		block: boolean;
	};
	assert.equal(result.block, true, "no UI in the child: refused");
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

	assert.deepEqual(entries.at(-1), { customType: "pi-modes-state", data: { mode: "gercep", careful: false } });
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

test("the Working line names the active modes and resets when they are off", async () => {
	const { pi, ctx, emit, commands, workingMessages } = fakePi();
	piModesExtension(pi);
	await emit("session_start", { reason: "startup" });
	assert.equal(workingMessages.at(-1), undefined, "default mode keeps Pi's own Working");

	await commands.gercep!.handler("on", ctx);
	assert.equal(workingMessages.at(-1), "Working ⚡ gercep");

	await commands["hati-hati"]!.handler("on", ctx);
	assert.equal(workingMessages.at(-1), "Working ⚡ gercep · 🛡 hati-hati");

	await commands.gercep!.handler("off", ctx);
	assert.equal(workingMessages.at(-1), "Working 🛡 hati-hati");

	await commands["hati-hati"]!.handler("off", ctx);
	assert.equal(workingMessages.at(-1), undefined);
});

test("the Working line is restored after a reload", async () => {
	const branch: unknown[] = [{ type: "custom", customType: "pi-modes-state", data: { mode: "gercep", careful: false } }];
	const { pi, emit, workingMessages } = fakePi(branch);
	piModesExtension(pi);
	await emit("session_start", { reason: "reload" });
	assert.equal(workingMessages.at(-1), "Working ⚡ gercep");
});

test("an older Pi without setWorkingMessage still works", async () => {
	const { pi, ctx, emit, commands, statuses } = fakePi();
	delete (ctx.ui as { setWorkingMessage?: unknown }).setWorkingMessage;
	piModesExtension(pi);
	await emit("session_start", { reason: "startup" });
	await commands.gercep!.handler("on", ctx);
	assert.equal(statuses.at(-1), "⚡ gercep");
});
