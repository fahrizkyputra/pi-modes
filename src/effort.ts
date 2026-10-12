/**
 * Auto-effort: before each prompt the user types, a small judge model rates
 * how heavy the task is and the session's thinking level is set to
 * medium, high, or xhigh for that prompt.
 *
 * Independent from gercep and hati-hati. Pure policy here; Pi calls live in
 * the extension so this file is testable without Pi.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type EffortLevel = "medium" | "high" | "xhigh";
/** Pi's thinking levels; kept local so this file needs no Pi import. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const EFFORT_LEVELS: readonly EffortLevel[] = ["medium", "high", "xhigh"];
export const EFFORT_MODE_ID = "auto-effort";
export const DEFAULT_JUDGE_MODEL = "9router/cc/claude-haiku-5-5";
export const FALLBACK_LEVEL: EffortLevel = "high";
export const JUDGE_TIMEOUT_MS = 3000;
/** Characters of the previous assistant answer given to the judge, so "lanjut" can be rated. */
export const CONTEXT_CHARS = 500;
const PROMPT_CHARS = 4000;

export interface EffortDecision {
	level: EffortLevel;
	reason: string;
	/** True when the judge failed and the fallback level was used. */
	fallback: boolean;
}

export const JUDGE_SYSTEM_PROMPT = [
	"You rate how much reasoning effort a coding agent needs for the user's next request.",
	"Answer with one JSON object only, no prose, no code fence:",
	'{"level":"medium"|"high"|"xhigh","reason":"<at most 8 words>"}',
	"",
	"Rubric:",
	"- medium: a quick question, a small edit, a rename, one clear file, a short explanation, confirming or continuing a simple step.",
	"- high: a bug fix, a medium feature, analysis, a code review, an ordinary multi-step task.",
	"- xhigh: a multi-file refactor or migration, hard debugging, a long investigation, heavy web or codebase research,",
	"  anything likely to take an agent more than 30 minutes.",
	"",
	"If the request only continues earlier work (\"lanjut\", \"ok gas\", \"continue\"), rate the work it continues,",
	"using the previous answer for context. The request may be in any language.",
].join("\n");

export function judgeUserText(prompt: string, previousAnswer: string | undefined): string {
	const request = prompt.length > PROMPT_CHARS ? `${prompt.slice(0, PROMPT_CHARS)}\n…(truncated)` : prompt;
	const parts: string[] = [];
	const context = previousAnswer?.trim();
	if (context) {
		const tail = context.length > CONTEXT_CHARS ? `…${context.slice(-CONTEXT_CHARS)}` : context;
		parts.push("<previous_answer>", tail, "</previous_answer>", "");
	}
	parts.push("<request>", request.trim() || "(empty request, only attachments)", "</request>");
	return parts.join("\n");
}

function isEffortLevel(value: unknown): value is EffortLevel {
	return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

/** The judge's level and reason, or undefined when the reply cannot be read. */
export function parseJudgeReply(text: string): { level: EffortLevel; reason: string } | undefined {
	const match = text.match(/\{[\s\S]*?\}/);
	if (match) {
		try {
			const data = JSON.parse(match[0]) as { level?: unknown; reason?: unknown };
			const level = typeof data.level === "string" ? data.level.trim().toLowerCase() : undefined;
			if (isEffortLevel(level)) {
				const reason = typeof data.reason === "string" ? data.reason.trim().slice(0, 80) : "";
				return { level, reason };
			}
		} catch {
			// fall through to the bare-word check
		}
	}
	// A reply of just the level word is still usable.
	const bare = text.trim().toLowerCase().replace(/[^a-z]/g, "");
	return isEffortLevel(bare) ? { level: bare, reason: "" } : undefined;
}

/** Sends the judge prompt; resolves to the reply text. Must honor the abort signal. */
export type JudgeCall = (systemPrompt: string, userText: string, signal: AbortSignal) => Promise<string>;

/**
 * Ask the judge, bounded by `timeoutMs`. Never rejects: any failure, timeout,
 * or unreadable reply gives the fallback level with the failure as the reason.
 */
export async function decideEffort(
	prompt: string,
	previousAnswer: string | undefined,
	call: JudgeCall,
	timeoutMs = JUDGE_TIMEOUT_MS,
): Promise<EffortDecision> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(new Error("timeout"));
		}, timeoutMs);
	});
	try {
		const reply = await Promise.race([call(JUDGE_SYSTEM_PROMPT, judgeUserText(prompt, previousAnswer), controller.signal), timeout]);
		const parsed = parseJudgeReply(reply);
		if (!parsed) return { level: FALLBACK_LEVEL, reason: "unreadable judge reply", fallback: true };
		return { ...parsed, fallback: false };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { level: FALLBACK_LEVEL, reason: message.slice(0, 80) || "judge failed", fallback: true };
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/** "9router/cc/claude-haiku-5-5" → provider "9router", id "cc/claude-haiku-5-5". */
export function splitModelRef(ref: string): { provider: string; id: string } | undefined {
	const trimmed = ref.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) return undefined;
	return { provider: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) };
}

// ---- global config (~/.pi/agent/pi-modes.json) -------------------------------

export interface PiModesConfig {
	autoEffort?: { judgeModel?: string };
}

export function agentDir(): string {
	const env = process.env.PI_CODING_AGENT_DIR;
	if (env) return env.startsWith("~") ? join(homedir(), env.slice(1)) : env;
	return join(homedir(), ".pi", "agent");
}

export function configPath(dir = agentDir()): string {
	return join(dir, "pi-modes.json");
}

export function readConfig(path = configPath()): PiModesConfig {
	try {
		if (!existsSync(path)) return {};
		const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return data && typeof data === "object" ? (data as PiModesConfig) : {};
	} catch {
		return {};
	}
}

export function judgeModelRef(config: PiModesConfig): string {
	const ref = config.autoEffort?.judgeModel;
	return typeof ref === "string" && splitModelRef(ref) ? ref.trim() : DEFAULT_JUDGE_MODEL;
}

export function writeJudgeModel(ref: string, path = configPath()): void {
	const config = readConfig(path);
	config.autoEffort = { ...config.autoEffort, judgeModel: ref };
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

// ---- state ------------------------------------------------------------------------

/**
 * On/off state, the level to restore when turned off, and the guard that tells
 * the extension's own level changes apart from the user's.
 */
export class AutoEffortController {
	private active = false;
	private restoreLevel: ThinkingLevel | undefined;
	private lastDecision: EffortDecision | undefined;
	/** The level pi-modes itself last applied; a change to anything else is the user's. */
	private appliedLevel: ThinkingLevel | undefined;
	private applying = false;

	isActive(): boolean {
		return this.active;
	}

	getRestoreLevel(): ThinkingLevel | undefined {
		return this.restoreLevel;
	}

	getLastDecision(): EffortDecision | undefined {
		return this.lastDecision;
	}

	/** Restore from the session without touching the level. */
	restore(active: boolean, restoreLevel: ThinkingLevel | undefined): void {
		this.active = active;
		this.restoreLevel = restoreLevel;
		this.lastDecision = undefined;
		this.appliedLevel = undefined;
	}

	turnOn(currentLevel: ThinkingLevel): void {
		this.active = true;
		this.restoreLevel = currentLevel;
		this.lastDecision = undefined;
		this.appliedLevel = undefined;
	}

	/** Turn off; returns the level to put back, if any. */
	turnOff(): ThinkingLevel | undefined {
		const level = this.restoreLevel;
		this.active = false;
		this.restoreLevel = undefined;
		this.appliedLevel = undefined;
		return level;
	}

	/**
	 * Apply a decision through `set` (Pi's setThinkingLevel), then read back the
	 * effective level (Pi clamps to the model). Returns the effective level.
	 */
	apply(decision: EffortDecision, set: (level: ThinkingLevel) => void, get: () => ThinkingLevel): ThinkingLevel {
		this.lastDecision = decision;
		this.ownChange(() => set(decision.level));
		this.appliedLevel = get();
		return this.appliedLevel;
	}

	/** Run a level change pi-modes makes itself (apply, restore on off), so it never reads as a manual one. */
	ownChange(change: () => void): void {
		this.applying = true;
		try {
			change();
		} finally {
			this.applying = false;
		}
	}

	/**
	 * A thinking level change Pi reported. True when it is the user's own manual
	 * change and auto-effort must pause; the user's level is kept.
	 */
	onLevelSelected(level: ThinkingLevel, causedByModelSwitch: boolean): boolean {
		if (!this.active || this.applying) return false;
		if (causedByModelSwitch) {
			// Pi re-clamped the level for the new model; the next prompt is judged again.
			this.appliedLevel = level;
			return false;
		}
		if (level === this.appliedLevel) return false;
		this.active = false;
		this.restoreLevel = undefined;
		this.appliedLevel = undefined;
		return true;
	}

	statusText(): string | undefined {
		if (!this.active) return undefined;
		const level = this.appliedLevel ?? this.lastDecision?.level;
		return level ? `🧠 auto→${level}` : "🧠 auto";
	}

	workingText(): string | undefined {
		if (!this.active) return undefined;
		const level = this.appliedLevel ?? this.lastDecision?.level;
		return level ? `🧠 ${level}` : undefined;
	}
}
