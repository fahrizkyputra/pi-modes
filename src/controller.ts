/**
 * Mode state and the per-run rules, behind injected plain inputs so the
 * whole policy is testable without Pi.
 */

import { type Category, classifyCommand, isTestFilePath } from "./classify.ts";
import { blockReason, followUpPrompt, gercepRules, hasQaChecklist, testFileBlockReason } from "./gercep.ts";
import { explicitlyRequested } from "./permissions.ts";

export type ModeId = "default" | "gercep";

export interface ToolCallInput {
	toolName: string;
	input: Record<string, unknown>;
}

export type ToolDecision = { block: false } | { block: true; reason: string; category: Category | "test-file" };

export class ModeController {
	private mode: ModeId = "default";
	/** Categories the latest user message unlocked; reset at every user prompt. */
	private unlocked = new Set<Category>();
	private changedFiles = new Set<string>();
	private followUpSentThisRun = false;

	getMode(): ModeId {
		return this.mode;
	}

	isActive(): boolean {
		return this.mode === "gercep";
	}

	setMode(mode: ModeId): void {
		this.mode = mode;
		this.resetRun();
	}

	getUnlocked(): ReadonlySet<Category> {
		return this.unlocked;
	}

	/** A new user prompt starts a run: recompute what it explicitly allows. */
	onUserPrompt(text: string | undefined): void {
		this.resetRun();
		if (this.isActive()) this.unlocked = explicitlyRequested(text);
	}

	/** Rules for the system prompt, or undefined in default mode. */
	systemRules(): string | undefined {
		return this.isActive() ? gercepRules(this.unlocked) : undefined;
	}

	checkToolCall(call: ToolCallInput): ToolDecision {
		if (!this.isActive()) return { block: false };

		if (call.toolName === "bash" || call.toolName === "powershell") {
			const command = typeof call.input.command === "string" ? call.input.command : "";
			for (const match of classifyCommand(command)) {
				if (this.unlocked.has(match.category)) continue;
				return { block: true, category: match.category, reason: blockReason(match.category, match.segment) };
			}
			return { block: false };
		}

		if (call.toolName === "write" || call.toolName === "edit") {
			const path = typeof call.input.path === "string" ? call.input.path : "";
			if (path && isTestFilePath(path) && !this.unlocked.has("test")) {
				return { block: true, category: "test-file", reason: testFileBlockReason(path) };
			}
		}

		return { block: false };
	}

	/** A write/edit that succeeded: the response owes a QA checklist. */
	onFileChanged(path: string | undefined): void {
		if (path) this.changedFiles.add(path);
	}

	changed(): string[] {
		return [...this.changedFiles];
	}

	/**
	 * At the end of a run: the follow-up prompt to send when files changed but
	 * the final answer has no checklist. At most once per run.
	 */
	followUpFor(finalText: string | undefined): string | undefined {
		if (!this.isActive() || this.followUpSentThisRun) return undefined;
		if (this.changedFiles.size === 0) return undefined;
		if (finalText !== undefined && hasQaChecklist(finalText)) return undefined;
		this.followUpSentThisRun = true;
		return followUpPrompt(this.changed());
	}

	private resetRun(): void {
		this.unlocked = new Set();
		this.changedFiles = new Set();
		this.followUpSentThisRun = false;
	}
}
