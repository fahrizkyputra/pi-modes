/**
 * @fahrizkyputra/pi-modes — selectable, independent agent modes for a session.
 *
 * Default (every mode off) changes nothing: no prompt rules, no blocking, no
 * confirmations. Modes can be combined:
 *
 * - gercep:    skip all automated verification, end with a manual QA checklist
 * - hati-hati: confirm every risky command, end with a rollback section
 */

import { execFileSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CAREFUL_ENV_FLAG,
	CAREFUL_MODE_ID,
	CAREFUL_STATUS_TEXT,
	CarefulController,
	ROLLBACK_HEADING,
	confirmMessage,
	confirmTitle,
	declinedReason,
	noUiReason,
} from "../src/careful.ts";
import { type ModeId, ModeController } from "../src/controller.ts";
import { ENV_FLAG, MODE_ID, QA_HEADING, STATUS_TEXT, categoryLabel } from "../src/gercep.ts";
import { GercepEditor } from "../src/gercep-editor.ts";

const STATE_ENTRY = "pi-modes-state";
const FOLLOW_UP_TYPE = "pi-modes-follow-up";
const STATUS_KEY = "pi-modes";

/** Persisted per session. 0.1.0 only wrote `mode`; `careful` is optional for that reason. */
interface ModeState {
	mode?: ModeId;
	careful?: boolean;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
		.join("");
}

/** Latest persisted state on the active branch, so /resume and /reload restore it. */
function restoredState(ctx: ExtensionContext): ModeState {
	const state: ModeState = {};
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
		const data = entry.data as Partial<ModeState> | undefined;
		if (data?.mode === "gercep" || data?.mode === "default") state.mode = data.mode;
		if (typeof data?.careful === "boolean") state.careful = data.careful;
	}
	return state;
}

/** `Working ⚡ gercep`, `Working ⚡ gercep · 🛡 hati-hati`, or undefined for Pi's own "Working". */
export function workingMessage(activeModes: readonly string[]): string | undefined {
	return activeModes.length > 0 ? `Working ${activeModes.join(" · ")}` : undefined;
}

function gitBranch(cwd: string | undefined, fallbackCwd: string): string | undefined {
	try {
		const output = execFileSync("git", ["-C", cwd ?? fallbackCwd, "rev-parse", "--abbrev-ref", "HEAD"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 2000,
		});
		const branch = output.trim();
		return branch.length > 0 && branch !== "HEAD" ? branch : undefined;
	} catch {
		return undefined;
	}
}

export default function piModesExtension(pi: ExtensionAPI) {
	const gercep = new ModeController();
	let sessionCwd = process.cwd();
	const careful = new CarefulController({ currentBranch: (cwd) => gitBranch(cwd, sessionCwd) });
	let lastAssistantText: string | undefined;
	/** Risky tool calls that were confirmed, keyed by call id, waiting for their result. */
	const confirmedCalls = new Map<string, string>();

	const persist = () => {
		pi.appendEntry<ModeState>(STATE_ENTRY, { mode: gercep.getMode(), careful: careful.isActive() });
	};

	/** The editor factory pi-modes installed, so it is only ever removed by pi-modes. */
	let flashFactory: ((...args: Parameters<NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>>) => GercepEditor) | undefined;
	let flashEditor: GercepEditor | undefined;

	/** Gercep on: flashing border editor. Off: Pi's editor back. Never replaces another extension's editor. */
	const applyFlashEditor = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		const ui = ctx.ui as Partial<ExtensionContext["ui"]>;
		if (typeof ui.setEditorComponent !== "function" || typeof ui.getEditorComponent !== "function") return;
		const current = ui.getEditorComponent();
		if (gercep.isActive()) {
			if (current !== undefined && current !== flashFactory) return; // someone else owns the editor
			if (current === flashFactory && flashFactory !== undefined) return;
			flashFactory = (tui, theme, keybindings) => {
				flashEditor?.dispose();
				flashEditor = new GercepEditor(tui, theme, keybindings);
				return flashEditor;
			};
			ui.setEditorComponent(flashFactory);
			return;
		}
		if (flashFactory !== undefined && current === flashFactory) ui.setEditorComponent(undefined);
		flashEditor?.dispose();
		flashEditor = undefined;
		flashFactory = undefined;
	};

	const applyIndicators = (ctx: ExtensionContext) => {
		const parts = [gercep.isActive() ? STATUS_TEXT : undefined, careful.isActive() ? CAREFUL_STATUS_TEXT : undefined].filter(
			(part): part is string => part !== undefined,
		);
		ctx.ui.setStatus(STATUS_KEY, parts.length > 0 ? parts.join(" · ") : undefined);
		// The "Working" line shown while the agent runs; undefined restores Pi's default.
		if (typeof ctx.ui.setWorkingMessage === "function") {
			ctx.ui.setWorkingMessage(workingMessage(parts));
		}
		if (gercep.isActive()) process.env[ENV_FLAG] = MODE_ID;
		else delete process.env[ENV_FLAG];
		if (careful.isActive()) process.env[CAREFUL_ENV_FLAG] = CAREFUL_MODE_ID;
		else delete process.env[CAREFUL_ENV_FLAG];
		applyFlashEditor(ctx);
	};

	pi.on("session_start", (_event, ctx) => {
		sessionCwd = ctx.cwd ?? process.cwd();
		const restored = restoredState(ctx);
		// Subagents started from a session with a mode inherit it through the environment.
		const inheritedGercep = process.env[ENV_FLAG] === MODE_ID;
		const inheritedCareful = process.env[CAREFUL_ENV_FLAG] === CAREFUL_MODE_ID;
		gercep.setMode(restored.mode ?? (inheritedGercep ? "gercep" : "default"));
		careful.setActive(restored.careful ?? inheritedCareful);
		applyIndicators(ctx);
	});

	pi.on("before_agent_start", (event) => {
		gercep.onUserPrompt(event.prompt);
		careful.onUserPrompt();
		confirmedCalls.clear();
		lastAssistantText = undefined;

		const sections = event.systemPromptOptions.sections;
		const gercepRules = gercep.systemRules();
		if (gercepRules) sections.gercep_mode = gercepRules;
		else delete sections.gercep_mode;
		const carefulRules = careful.systemRules();
		if (carefulRules) sections.hati_hati_mode = carefulRules;
		else delete sections.hati_hati_mode;
	});

	pi.on("tool_call", async (event, ctx) => {
		const input = event.input as Record<string, unknown>;

		const decision = gercep.checkToolCall({ toolName: event.toolName, input });
		if (decision.block) {
			const what = decision.category === "test-file" ? "test files" : categoryLabel(decision.category);
			ctx.ui.notify(`⚡ gercep: blocked ${what}.`, "info");
			return { block: true, reason: decision.reason };
		}

		const { matches } = careful.check(event.toolName, input);
		if (matches.length === 0) return undefined;
		const command = typeof input.command === "string" ? input.command : "";

		if (!ctx.hasUI) {
			return { block: true, reason: noUiReason(matches) };
		}
		const approved = await ctx.ui.confirm(confirmTitle(matches), confirmMessage(command, matches));
		if (!approved) {
			ctx.ui.notify("🛡 hati-hati: declined.", "info");
			return { block: true, reason: declinedReason(matches) };
		}
		confirmedCalls.set(event.toolCallId, command);
		return undefined;
	});

	pi.on("tool_result", (event) => {
		const confirmed = confirmedCalls.get(event.toolCallId);
		if (confirmed !== undefined) {
			confirmedCalls.delete(event.toolCallId);
			// A failed command may still have changed something, so it still owes a rollback entry.
			careful.onRiskyCommandRan(confirmed);
		}

		if (event.isError) return undefined;
		if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
		const path = (event.input as { path?: unknown }).path;
		gercep.onFileChanged(typeof path === "string" ? path : undefined);
		return undefined;
	});

	pi.on("message_end", (event) => {
		const message = event.message as { role?: string; content?: unknown };
		if (message.role === "assistant") lastAssistantText = textOf(message.content);
	});

	// One combined follow-up per run, so the two modes never compete for the boundary.
	pi.on("agent_before_settle", (event) => {
		if (event.outcome !== "completed") return undefined;
		const prompts = [gercep.followUpFor(lastAssistantText), careful.followUpFor(lastAssistantText)].filter(
			(prompt): prompt is string => prompt !== undefined,
		);
		if (prompts.length === 0) return undefined;
		return {
			entries: [{ type: "custom_message", customType: FOLLOW_UP_TYPE, content: prompts.join("\n\n"), display: false }],
			continue: true,
		};
	});

	pi.on("session_shutdown", () => {
		flashEditor?.dispose();
		flashEditor = undefined;
		delete process.env[ENV_FLAG];
		delete process.env[CAREFUL_ENV_FLAG];
	});

	pi.registerCommand("gercep", {
		description: "Gercep mode: no tests/typecheck/lint/build, manual QA checklist at the end (on | off | status)",
		getArgumentCompletions: (prefix) => {
			const options = [
				{ value: "on", label: "on — skip automated verification, end with a QA checklist" },
				{ value: "off", label: "off — stop skipping verification" },
				{ value: "status", label: "status — show the active modes" },
			];
			const filtered = options.filter((option) => option.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || "on";

			if (action === "status") {
				ctx.ui.notify(statusLine(), "info");
				return;
			}

			if (action === "on") {
				if (gercep.isActive()) {
					ctx.ui.notify("Gercep is already on for this session.", "info");
					return;
				}
				gercep.setMode("gercep");
				persist();
				applyIndicators(ctx);
				ctx.ui.notify(
					"⚡ Gercep on: no tests, typecheck, lint, or build; responses that change files end with a QA checklist. /gercep off to return.",
					"info",
				);
				return;
			}

			if (action === "off") {
				if (!gercep.isActive()) {
					ctx.ui.notify("Gercep is already off.", "info");
					return;
				}
				gercep.setMode("default");
				persist();
				applyIndicators(ctx);
				ctx.ui.notify(careful.isActive() ? "Gercep off (hati-hati is still on)." : "Default mode: pi behaves as it does without this package.", "info");
				return;
			}

			ctx.ui.notify(`Unknown argument "${action}". Use /gercep on | off | status.`, "warning");
		},
	});

	pi.registerCommand("hati-hati", {
		description: "Hati-hati mode: confirm every risky command, end with a rollback section (on | off | status)",
		getArgumentCompletions: (prefix) => {
			const options = [
				{ value: "on", label: "on — confirm remote, release, database, and destructive commands" },
				{ value: "off", label: "off — stop asking for confirmation" },
				{ value: "status", label: "status — show the active modes" },
			];
			const filtered = options.filter((option) => option.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || "on";

			if (action === "status") {
				ctx.ui.notify(statusLine(), "info");
				return;
			}

			if (action === "on") {
				if (careful.isActive()) {
					ctx.ui.notify("Hati-hati is already on for this session.", "info");
					return;
				}
				careful.setActive(true);
				persist();
				applyIndicators(ctx);
				ctx.ui.notify(
					`🛡 Hati-hati on: remote, release, database, and destructive commands need your confirmation; responses that ran one end with "${ROLLBACK_HEADING}". /hati-hati off to stop.`,
					"info",
				);
				return;
			}

			if (action === "off") {
				if (!careful.isActive()) {
					ctx.ui.notify("Hati-hati is already off.", "info");
					return;
				}
				careful.setActive(false);
				persist();
				applyIndicators(ctx);
				ctx.ui.notify(gercep.isActive() ? "Hati-hati off (gercep is still on)." : "Default mode: pi behaves as it does without this package.", "info");
				return;
			}

			ctx.ui.notify(`Unknown argument "${action}". Use /hati-hati on | off | status.`, "warning");
		},
	});

	function statusLine(): string {
		const active = [
			gercep.isActive() ? `gercep (no tests/typecheck/lint/build, ends with "${QA_HEADING}")` : undefined,
			careful.isActive() ? `hati-hati (confirms risky commands, ends with "${ROLLBACK_HEADING}")` : undefined,
		].filter((part): part is string => part !== undefined);
		return active.length > 0
			? `Active modes: ${active.join(" + ")}.`
			: "Mode: default — pi behaves exactly as without this package. /gercep or /hati-hati to switch.";
	}
}
