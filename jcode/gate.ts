/**
 * jcode `pre_tool` gate for gercep and hati-hati.
 *
 * Contract (jcode docs/HOOKS.md): tool input JSON on stdin, `JCODE_HOOK_TOOL_NAME`
 * and `JCODE_HOOK_SESSION_ID` in the env. Exit 2 blocks the call and stderr is
 * returned to the model; exit 0 allows it. Anything else fails open, so a
 * crash here never bricks a session.
 *
 * - gercep blocks test/typecheck/lint/build commands and writes to test files,
 *   unless the user's latest message explicitly asked for them.
 * - hati-hati blocks risky commands until the user approves the exact command
 *   with a `!jcode-modes approve <code>` line, which only a human can type:
 *   the model's own attempts to run `approve` are blocked here.
 */

import { classifyCommand, isTestFilePath, type Category } from "../src/classify.ts";
import { blockReason } from "../src/gercep.ts";
import { explicitlyRequested } from "../src/permissions.ts";
import { classifyRisk, type RiskContext, type RiskMatch } from "../src/risk.ts";
import { issueCode, loadState, takeApproval, type SessionState } from "./state.ts";

export const SHIM = "jcode-modes";

export type GateResult = { allow: true } | { allow: false; reason: string };

export interface GateInput {
	toolName: string;
	input: Record<string, unknown>;
	sessionId: string;
	state: SessionState;
	/** The user's latest typed message, for gercep's explicit-request unlock. */
	latestUserText: () => string | undefined;
	risk?: RiskContext;
	/** How the user types the approve command (`jcode-modes` or a full path). */
	approveCommand: string;
}

const SHELL_TOOLS = new Set(["bash"]);

/** Paths a jcode write tool would touch (`write`, `edit`, `patch`, `apply_patch`, `multiedit`). */
export function writtenPaths(toolName: string, input: Record<string, unknown>): string[] {
	if (!["write", "edit", "multiedit", "patch", "apply_patch"].includes(toolName)) return [];
	const paths: string[] = [];
	for (const key of ["file_path", "path", "target_path", "new_path"]) {
		const value = input[key];
		if (typeof value === "string") paths.push(value);
	}
	const patch = input.patch_text ?? input.patch;
	if (typeof patch === "string") {
		for (const line of patch.split("\n")) {
			const match = /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$|^\+\+\+ b\/(.+)$/.exec(line.trim());
			const path = match?.[1] ?? match?.[2] ?? match?.[3];
			if (path) paths.push(path.trim());
		}
	}
	return paths;
}

/** The model may not approve its own risky command. */
export function isSelfApproval(command: string): boolean {
	return /(?:^|[\s;&|(`/])jcode-modes\s+approve\b/.test(command) || /pi-modes\/jcode\/cli\.ts["']?\s+approve\b/.test(command);
}

/** Turning hati-hati off (or removing the gate) is itself held for the user's approval. */
export function turnsCarefulOff(command: string): boolean {
	return /(?:^|[\s;&|(`/])jcode-modes\s+(?:off\s+(?:hati-hati|careful)\b|uninstall\b)/.test(command) || /pi-modes\s+jcode\s+uninstall\b/.test(command);
}

function gercepCheck(input: GateInput): GateResult {
	const { toolName } = input;
	let unlocked: Set<Category> | undefined;
	const allowed = (category: Category) => {
		unlocked ??= explicitlyRequested(input.latestUserText());
		return unlocked.has(category);
	};

	if (SHELL_TOOLS.has(toolName)) {
		const command = typeof input.input.command === "string" ? input.input.command : "";
		for (const match of classifyCommand(command)) {
			if (allowed(match.category)) continue;
			return { allow: false, reason: jcodeBlockReason(match.category, match.segment) };
		}
	}
	for (const path of writtenPaths(toolName, input.input)) {
		if (isTestFilePath(path) && !allowed("test")) {
			return {
				allow: false,
				reason: [
					`Blocked by gercep mode: writing test files is skipped in this session (${path}).`,
					"Continue without tests, and describe what to check in the QA checklist instead.",
					`The user can allow it by asking explicitly ("tulis test" / "write the tests") or by turning gercep off (\`${SHIM} off gercep\`).`,
				].join("\n"),
			};
		}
	}
	return { allow: true };
}

function jcodeBlockReason(category: Category, segment: string): string {
	return blockReason(category, segment).replace("or with /gercep off.", `or by turning gercep off (\`${SHIM} off gercep\`).`);
}

function carefulCheck(input: GateInput): GateResult {
	if (!SHELL_TOOLS.has(input.toolName)) return { allow: true };
	const command = typeof input.input.command === "string" ? input.input.command : "";
	if (isSelfApproval(command)) {
		return {
			allow: false,
			reason: "Blocked by hati-hati mode: approvals must come from the user. Ask the user to type the `!` approve line themselves, then wait.",
		};
	}
	const matches: RiskMatch[] = classifyRisk(command, input.risk ?? {});
	if (turnsCarefulOff(command)) matches.push({ category: "destructive", action: command.trim(), reason: "turns hati-hati off" });
	if (matches.length === 0) return { allow: true };
	if (takeApproval(input.sessionId, command)) return { allow: true };

	const reasons = matches.map((match) => match.reason);
	const code = issueCode(input.sessionId, command, reasons);
	return {
		allow: false,
		reason: [
			// The model tends to quote only the first line, so the approve line leads.
			`Held by hati-hati mode — to run it, the user types: !${input.approveCommand} approve ${code}`,
			`Why it needs confirmation: ${reasons.join("; ")}. The command did not run.`,
			"Tell the user in one line what it does and why, and show them that exact `!` line to type.",
			"After they confirm, issue the SAME command again, unchanged; it will then run once.",
			"If they decline, do not retry it in another form; explain the alternative instead.",
			"Do not run the approve command yourself; it is blocked.",
		].join("\n"),
	};
}

export function evaluate(input: GateInput): GateResult {
	const modes = input.state.modes;
	if (modes.includes("gercep")) {
		const result = gercepCheck(input);
		if (!result.allow) return result;
	}
	if (modes.includes("hati-hati")) return carefulCheck(input);
	return { allow: true };
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

if (import.meta.main) {
	try {
		const sessionId = process.env.JCODE_HOOK_SESSION_ID ?? "";
		const raw = await readStdin();
		const state = sessionId ? loadState(sessionId) : undefined;
		if (state && state.modes.length > 0) {
			const parsed: unknown = JSON.parse(raw);
			const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
			const { latestUserText } = await import("./transcript.ts");
			const { gitBranch } = await import("./git.ts");
			const { shimCommand } = await import("./kit.ts");
			const cwd = process.env.JCODE_HOOK_CWD;
			const result = evaluate({
				toolName: process.env.JCODE_HOOK_TOOL_NAME ?? "",
				input: record,
				sessionId,
				state,
				latestUserText: () => latestUserText(sessionId),
				risk: { currentBranch: (dir) => gitBranch(dir, cwd) },
				approveCommand: shimCommand(SHIM),
			});
			if (!result.allow) {
				process.stderr.write(result.reason);
				process.exitCode = 2;
			}
		}
	} catch {
		// fail open
	}
}
