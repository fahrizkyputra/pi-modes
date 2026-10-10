/**
 * @fahrizkyputra/pi-modes — selectable agent modes for a session.
 *
 * Default mode changes nothing: no prompt rules, no blocking. Gercep mode
 * skips every form of automated verification and ends each response that
 * changed files with a manual QA checklist.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ModeId, ModeController } from "../src/controller.ts";
import { ENV_FLAG, MODE_ID, QA_HEADING, STATUS_TEXT, categoryLabel } from "../src/gercep.ts";

const STATE_ENTRY = "pi-modes-state";
const FOLLOW_UP_TYPE = "pi-modes-qa-request";
const STATUS_KEY = "pi-modes";

interface ModeState {
	mode: ModeId;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
		.join("");
}

/** Latest persisted mode on the active branch, so /resume and /reload restore it. */
function restoredMode(ctx: ExtensionContext): ModeId | undefined {
	let mode: ModeId | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === STATE_ENTRY) {
			const data = entry.data as Partial<ModeState> | undefined;
			if (data?.mode === "gercep" || data?.mode === "default") mode = data.mode;
		}
	}
	return mode;
}

export default function piModesExtension(pi: ExtensionAPI) {
	const controller = new ModeController();
	let lastAssistantText: string | undefined;

	const applyIndicators = (ctx: ExtensionContext) => {
		ctx.ui.setStatus(STATUS_KEY, controller.isActive() ? STATUS_TEXT : undefined);
		if (controller.isActive()) process.env[ENV_FLAG] = MODE_ID;
		else delete process.env[ENV_FLAG];
	};

	const setMode = (mode: ModeId, ctx: ExtensionContext, persist: boolean) => {
		controller.setMode(mode);
		if (persist) pi.appendEntry<ModeState>(STATE_ENTRY, { mode });
		applyIndicators(ctx);
	};

	pi.on("session_start", (_event, ctx) => {
		const restored = restoredMode(ctx);
		// A subagent started from a gercep session inherits the flag through its environment.
		const inherited = restored === undefined && process.env[ENV_FLAG] === MODE_ID ? "gercep" : undefined;
		setMode(restored ?? inherited ?? "default", ctx, false);
	});

	pi.on("before_agent_start", (event) => {
		controller.onUserPrompt(event.prompt);
		lastAssistantText = undefined;
		const rules = controller.systemRules();
		if (rules) event.systemPromptOptions.sections.gercep_mode = rules;
		else delete event.systemPromptOptions.sections.gercep_mode;
	});

	pi.on("tool_call", (event, ctx) => {
		const decision = controller.checkToolCall({
			toolName: event.toolName,
			input: event.input as Record<string, unknown>,
		});
		if (!decision.block) return undefined;
		const what = decision.category === "test-file" ? "test files" : categoryLabel(decision.category);
		ctx.ui.notify(`⚡ gercep: blocked ${what}.`, "info");
		return { block: true, reason: decision.reason };
	});

	pi.on("tool_result", (event) => {
		if (event.isError) return undefined;
		if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
		const path = (event.input as { path?: unknown }).path;
		controller.onFileChanged(typeof path === "string" ? path : undefined);
		return undefined;
	});

	pi.on("message_end", (event) => {
		const message = event.message as { role?: string; content?: unknown };
		if (message.role === "assistant") lastAssistantText = textOf(message.content);
	});

	pi.on("agent_before_settle", (event) => {
		if (event.outcome !== "completed") return undefined;
		const prompt = controller.followUpFor(lastAssistantText);
		if (!prompt) return undefined;
		return {
			entries: [{ type: "custom_message", customType: FOLLOW_UP_TYPE, content: prompt, display: false }],
			continue: true,
		};
	});

	pi.on("session_shutdown", () => {
		delete process.env[ENV_FLAG];
	});

	pi.registerCommand("gercep", {
		description: "Gercep mode: no tests/typecheck/lint/build, manual QA checklist at the end (on | off | status)",
		getArgumentCompletions: (prefix) => {
			const options = [
				{ value: "on", label: "on — skip automated verification, end with a QA checklist" },
				{ value: "off", label: "off — back to the default mode" },
				{ value: "status", label: "status — show the current mode" },
			];
			const filtered = options.filter((option) => option.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || "on";

			if (action === "status") {
				ctx.ui.notify(
					controller.isActive()
						? `Mode: gercep — tests, typecheck, lint, and build are skipped; responses that change files end with "${QA_HEADING}". /gercep off returns to default.`
						: "Mode: default — pi behaves exactly as without this package. /gercep on to switch.",
					"info",
				);
				return;
			}

			if (action === "on") {
				if (controller.isActive()) {
					ctx.ui.notify("Gercep is already on for this session.", "info");
					return;
				}
				setMode("gercep", ctx, true);
				ctx.ui.notify(
					`⚡ Gercep on: no tests, typecheck, lint, or build; responses that change files end with a QA checklist. /gercep off to return.`,
					"info",
				);
				return;
			}

			if (action === "off") {
				if (!controller.isActive()) {
					ctx.ui.notify("Already in default mode.", "info");
					return;
				}
				setMode("default", ctx, true);
				ctx.ui.notify("Default mode: pi behaves as it does without this package.", "info");
				return;
			}

			ctx.ui.notify(`Unknown argument "${action}". Use /gercep on | off | status.`, "warning");
		},
	});
}
