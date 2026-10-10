/**
 * Hati-hati (careful) mode: every risky command needs a human "yes" first,
 * and responses that ran one end with a rollback section.
 *
 * Independent from gercep: either, both, or neither can be active.
 */

import type { RiskCategory, RiskMatch } from "./risk.ts";
import { classifyRisk, type RiskContext } from "./risk.ts";

export const CAREFUL_MODE_ID = "hati-hati";
export const CAREFUL_STATUS_TEXT = "🛡 hati-hati";
export const ROLLBACK_HEADING = "Rollback";
/** Inherited by child pi processes (subagents) so they start careful too. */
export const CAREFUL_ENV_FLAG = "PI_MODES_CAREFUL";

const CATEGORY_LABEL: Record<RiskCategory, string> = {
	remote: "remote/production",
	release: "release/publish",
	database: "database",
	destructive: "destructive",
};

export function riskLabel(category: RiskCategory): string {
	return CATEGORY_LABEL[category];
}

export function carefulRules(): string {
	return [
		"HATI-HATI (CAREFUL) MODE IS ACTIVE: the user wants a human confirmation before anything risky.",
		"",
		"Risky actions are: changing remote/production hosts (ssh/scp/rsync that restart, deploy, write, or delete),",
		"releases and publishing (force push, push to main/master/production, npm publish, gh release, gh pr merge,",
		"deploy commands), database migrations and SQL writes, and destructive local commands (rm -rf outside temp,",
		"git reset --hard, git clean -f, git branch -D, chmod/chown -R).",
		"",
		"While this mode is active:",
		"- Before a risky command, say in one line what it does and why it is needed; the pi-modes extension will",
		"  then ask the user to confirm it. If the user declines, do not retry it in another form — explain the",
		"  alternative or ask what to do instead.",
		"- Prefer the read-only or dry-run variant first (status, --dry-run, SELECT, rsync -n) when it gives the",
		"  information you need.",
		`- After any response in which a risky command actually ran, end with a section headed exactly "### ${ROLLBACK_HEADING}"`,
		"  (keep that heading in English; write the rest in the language of the conversation):",
		"  - one item per risky action that ran, the action in backticks, and on the next line `→ how to undo it`;",
		"  - finish with `Tidak bisa di-rollback:` (Indonesian) or `Cannot be rolled back:` (English) for anything",
		"    irreversible (published package versions, sent messages, dropped data without a backup), or `-` if none.",
		"- Declined or blocked commands did not run and need no rollback entry.",
	].join("\n");
}

export function hasRollbackSection(text: string): boolean {
	const index = text.toLowerCase().indexOf(`### ${ROLLBACK_HEADING.toLowerCase()}`);
	if (index < 0) return false;
	return /^\s*[-*]\s+\S/m.test(text.slice(index));
}

export function rollbackFollowUp(actions: readonly string[]): string {
	const list = actions.slice(0, 15).map((action) => `- \`${action.replace(/`/g, "'").slice(0, 160)}\``);
	const more = actions.length > 15 ? [`- … and ${actions.length - 15} more`] : [];
	return [
		`[hati-hati] Risky commands ran in this response but it did not end with "### ${ROLLBACK_HEADING}".`,
		"Write only that section now, in the language of the conversation, for these actions:",
		...list,
		...more,
		"Do not run any commands.",
	].join("\n");
}

export function confirmTitle(matches: readonly RiskMatch[]): string {
	const categories = [...new Set(matches.map((match) => riskLabel(match.category)))];
	return `🛡 Hati-hati: run ${matches.length === 1 ? "a" : matches.length} ${categories.join(" + ")} action${matches.length === 1 ? "" : "s"}?`;
}

export function confirmMessage(command: string, matches: readonly RiskMatch[]): string {
	const reasons = matches.map((match) => `• ${match.reason}`);
	const shown = command.length > 1200 ? `${command.slice(0, 1200)}\n… (${command.length - 1200} more characters)` : command;
	return [...reasons, "", shown].join("\n");
}

export function declinedReason(matches: readonly RiskMatch[]): string {
	return [
		`Declined by the user (hati-hati mode): ${matches.map((match) => match.reason).join("; ")}.`,
		"The command did not run. Do not retry it in another form; explain the alternative or ask the user what to do.",
	].join("\n");
}

export function noUiReason(matches: readonly RiskMatch[]): string {
	return [
		`Blocked by hati-hati mode: this needs a human confirmation, and no interactive UI is available here (${matches
			.map((match) => match.reason)
			.join("; ")}).`,
		"The command did not run. Report what you wanted to run so the user can do it from an interactive session.",
	].join("\n");
}

export interface CarefulCheck {
	/** Risky segments, empty when nothing needs confirmation. */
	matches: RiskMatch[];
}

export class CarefulController {
	private active = false;
	private ranActions: string[] = [];
	private followUpSentThisRun = false;
	private readonly context: RiskContext;

	constructor(context: RiskContext = {}) {
		this.context = context;
	}

	isActive(): boolean {
		return this.active;
	}

	setActive(active: boolean): void {
		this.active = active;
		this.resetRun();
	}

	onUserPrompt(): void {
		this.resetRun();
	}

	systemRules(): string | undefined {
		return this.active ? carefulRules() : undefined;
	}

	check(toolName: string, input: Record<string, unknown>): CarefulCheck {
		if (!this.active) return { matches: [] };
		if (toolName !== "bash" && toolName !== "powershell") return { matches: [] };
		const command = typeof input.command === "string" ? input.command : "";
		return { matches: classifyRisk(command, this.context) };
	}

	/** A confirmed risky command finished successfully. */
	onRiskyCommandRan(command: string): void {
		this.ranActions.push(command.replace(/\s+/g, " ").trim());
	}

	ran(): string[] {
		return [...this.ranActions];
	}

	followUpFor(finalText: string | undefined): string | undefined {
		if (!this.active || this.followUpSentThisRun || this.ranActions.length === 0) return undefined;
		if (finalText !== undefined && hasRollbackSection(finalText)) return undefined;
		this.followUpSentThisRun = true;
		return rollbackFollowUp(this.ranActions);
	}

	private resetRun(): void {
		this.ranActions = [];
		this.followUpSentThisRun = false;
	}
}
