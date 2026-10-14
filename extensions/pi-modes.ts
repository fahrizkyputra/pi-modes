/**
 * @fahrizkyputra/pi-modes — selectable, independent agent modes for a session.
 *
 * Default (every mode off) changes nothing: no prompt rules, no blocking, no
 * confirmations. Modes can be combined:
 *
 * - gercep:    skip all automated verification, end with a manual QA checklist
 * - hati-hati: confirm every risky command, end with a rollback section
 * - auto-effort: a small judge model picks medium/high/xhigh thinking per prompt
 * - auto-review: an independent reviewer model checks each task's diff; /review on demand
 */

import { execFileSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Loader, Text, matchesKey } from "@earendil-works/pi-tui";
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
import {
	AutoEffortController,
	DEFAULT_JUDGE_MODEL,
	EFFORT_MODE_ID,
	type EffortDecision,
	JUDGE_TIMEOUT_MS,
	type ThinkingLevel,
	decideEffort,
	judgeModelRef,
	readConfig,
	splitModelRef,
	writeJudgeModel,
} from "../src/effort.ts";
import { ENV_FLAG, MODE_ID, QA_HEADING, STATUS_TEXT, categoryLabel } from "../src/gercep.ts";
import { GercepEditor } from "../src/gercep-editor.ts";
import {
	MAX_SCAN_REPOS,
	dirtyRepos,
	diffNumstat,
	diffPatch,
	findReposUnder,
	headTree,
	repoForPath,
	repoRoot,
	scanRoot,
	snapshotTree,
} from "../src/git-snapshot.ts";
import {
	DEFAULT_REVIEW_MODEL,
	REVIEW_MODE_ID,
	REVIEW_TIMEOUT_MS,
	type DiffStats,
	type ReportDetails,
	type ReviewEffort,
	type ReviewScope,
	commandDirs,
	commonAncestor,
	labelNumstat,
	mergeStats,
	parseNumstat,
	repoLabel,
	reportExpanded,
	reportText,
	reviewConfig,
	reviewModelRef,
	riskyPatterns,
	shortModel,
	writeReviewModel,
} from "../src/review.ts";
import { type ReviewHost, type ReviewOutcome, type ReviewerRun, ReviewController, type TaskRecord } from "../src/review-controller.ts";
import { runReviewer } from "../src/reviewer.ts";

const STATE_ENTRY = "pi-modes-state";
const FOLLOW_UP_TYPE = "pi-modes-follow-up";
const STATUS_KEY = "pi-modes";
const REVIEW_TASK_ENTRY = "pi-modes-review-task";
const REVIEW_REPORT_TYPE = "pi-modes-review";
const REVIEW_FIX_TYPE = "pi-modes-review-fix";
const REVIEW_WIDGET = "pi-modes-review";
const REVIEW_STATUS_TEXT = "🔍 auto-review";

/** Persisted per session. Older versions wrote fewer fields, so every field is optional. */
interface ModeState {
	mode?: ModeId;
	careful?: boolean;
	autoEffort?: boolean;
	/** Thinking level to put back when auto-effort turns off. */
	effortRestore?: ThinkingLevel;
	autoReview?: boolean;
}

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
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
		if (typeof data?.autoEffort === "boolean") {
			state.autoEffort = data.autoEffort;
			state.effortRestore = isThinkingLevel(data.effortRestore) ? data.effortRestore : undefined;
		}
		if (typeof data?.autoReview === "boolean") state.autoReview = data.autoReview;
	}
	return state;
}

/** A snapshot map from storage: per repository, or the 0.5.0 form (one tree for the session's repository). */
function readSnapshot(value: unknown, legacyRoot: string | undefined): Record<string, string> | undefined {
	if (typeof value === "string") return legacyRoot ? { [legacyRoot]: value } : undefined;
	if (!value || typeof value !== "object") return undefined;
	const result: Record<string, string> = {};
	for (const [root, tree] of Object.entries(value as Record<string, unknown>)) {
		if (typeof tree === "string" && tree) result[root] = tree;
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

/** The latest task with a change on the active branch, so /review works after /reload or /resume. */
function restoredReviewTask(ctx: ExtensionContext, legacyRoot: string | undefined): TaskRecord | undefined {
	let record: TaskRecord | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== REVIEW_TASK_ENTRY) continue;
		const data = entry.data as { request?: unknown; base?: unknown; sessionBase?: unknown } | undefined;
		const base = readSnapshot(data?.base, legacyRoot);
		if (!base) continue;
		const sessionBase = readSnapshot(data?.sessionBase, legacyRoot);
		record = { request: typeof data?.request === "string" ? data.request : "", base, ...(sessionBase ? { sessionBase } : {}) };
	}
	return record;
}

const REVIEW_SCOPES: readonly ReviewScope[] = ["task", "session", "uncommitted"];

/** Text of the latest assistant message on the branch, for prompts after /resume. */
function lastAssistantOnBranch(ctx: ExtensionContext): string | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index] as { type?: string; message?: { role?: string; content?: unknown } };
		if (entry.type === "message" && entry.message?.role === "assistant") {
			const text = textOf(entry.message.content);
			if (text.trim()) return text;
		}
	}
	return undefined;
}

function modelKey(model: { provider?: string; id?: string } | undefined): string {
	return model ? `${model.provider ?? ""}/${model.id ?? ""}` : "";
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

	const effort = new AutoEffortController();
	/** Set by the input event for a prompt the user typed while idle; only those are judged. */
	let judgeNextPrompt = false;
	/** Model seen last, so a level change caused by switching models is not read as a manual one. */
	let knownModel = "";
	/** Subagents never run auto-effort, even when a forked history carries it. */
	const isSubagent = process.env.PI_SUBAGENT_CHILD === "1";
	let effortUsed = false;

	// ---- auto-review ----
	let autoReview = false;
	let reviewUsed = false;
	/** The repository the session runs in, when it runs inside one. A monorepo folder has none. */
	let repo: string | undefined;
	/** Repositories found for tool calls this task, so each path is resolved once. */
	let repoCache = new Map<string, string | null>();
	/** Repositories the session has touched, in order; the folder they share is the reviewer's working folder. */
	const touchedThisSession = new Set<string>();
	/** Set by the input event: the next prompt came from an extension (e.g. an auto-resume), not the user. */
	let nextPromptFromExtension = false;
	/** The context the running review belongs to; set just before a review starts. */
	let reviewCtx: ExtensionContext | undefined;
	let reviewManual = false;
	let reviewRunning = false;
	let reviewLabel = "";
	let reviewToolCalls = 0;
	let reviewLoader: Loader | undefined;

	const reviewHost: ReviewHost = {
		snapshot: (roots) => {
			const result: Record<string, string> = {};
			for (const root of roots) {
				const tree = snapshotTree(root);
				if (tree !== undefined) result[root] = tree;
			}
			return result;
		},
		headTrees: (roots) => Object.fromEntries(roots.map((root) => [root, headTree(root)])),
		scanDirty: async () => {
			const top = scanRoot(sessionCwd);
			if (!top) return { dirty: [], found: 0 };
			const { repos, skipped } = findReposUnder(top);
			if (skipped > 0) reviewCtx?.ui.notify(`🔍 Found more than ${MAX_SCAN_REPOS} repositories under ${top}; only the first ${MAX_SCAN_REPOS} were checked.`, "warning");
			const own = repoRoot(sessionCwd);
			const all = own && !repos.includes(own) ? [own, ...repos] : repos;
			return { dirty: await dirtyRepos(all), found: all.length };
		},
		diff: (from, to) => {
			const roots = Object.keys(from).filter((root) => to[root] !== undefined);
			if (roots.length === 0) return undefined;
			const workdir = roots.length === 1 ? roots[0]! : commonAncestor(roots);
			const patterns = riskyPatterns(reviewConfig());
			const stats: DiffStats[] = [];
			const patches: string[] = [];
			try {
				for (const root of roots) {
					const label = repoLabel(workdir, root);
					const numstat = labelNumstat(diffNumstat(root, from[root]!, to[root]!), label);
					const parsed = parseNumstat(numstat, patterns);
					if (parsed.files.length === 0) continue;
					stats.push(parsed);
					patches.push(diffPatch(root, from[root]!, to[root]!, label));
				}
			} catch {
				return undefined;
			}
			const changed = roots.filter((root) => {
				const label = repoLabel(workdir, root);
				return stats.some((item) => item.files.some((file) => (label ? file.path.startsWith(`${label}/`) : true)));
			});
			return { stats: mergeStats(stats), patch: patches.join("\n"), repos: changed.map((root) => repoLabel(workdir, root) || "."), workdir };
		},
		modelRef: () => reviewModelRef(reviewConfig()),
		runReviewer: (userText, effort, workdir) => runReviewerFor(userText, effort, workdir),
		confirm: async (question) => {
			const ctx = reviewCtx;
			if (!ctx?.hasUI) return false;
			try {
				return await ctx.ui.confirm("Review many repositories?", question);
			} catch {
				return false;
			}
		},
	};
	const review = new ReviewController(reviewHost);

	const reviewWidgetText = () =>
		`🔍 Reviewing with ${reviewLabel}${reviewToolCalls > 0 ? ` · ${reviewToolCalls} tool call${reviewToolCalls === 1 ? "" : "s"}` : ""} · Esc to cancel`;

	const showReviewWidget = (ctx: ExtensionContext) => {
		if (ctx.mode === "tui" && typeof ctx.ui.setWidget === "function") {
			ctx.ui.setWidget(REVIEW_WIDGET, (tui, theme) => {
				reviewLoader?.stop();
				const loader = new Loader(tui, (text) => theme.fg("accent", text), (text) => theme.fg("muted", text), reviewWidgetText());
				reviewLoader = loader;
				return Object.assign(loader, {
					dispose: () => {
						loader.stop();
						if (reviewLoader === loader) reviewLoader = undefined;
					},
				});
			});
		}
		ctx.ui.setStatus(`${STATUS_KEY}-review`, reviewWidgetText());
	};

	const hideReviewWidget = (ctx: ExtensionContext) => {
		reviewLoader?.stop();
		reviewLoader = undefined;
		if (ctx.mode === "tui" && typeof ctx.ui.setWidget === "function") ctx.ui.setWidget(REVIEW_WIDGET, undefined);
		ctx.ui.setStatus(`${STATUS_KEY}-review`, undefined);
	};

	/** Run the reviewer agent for the current reviewCtx. Never rejects. */
	async function runReviewerFor(userText: string, effort: ReviewEffort, workdir: string): Promise<ReviewerRun> {
		const ctx = reviewCtx;
		const ref = reviewModelRef(reviewConfig());
		const failed = (error: string): ReviewerRun => ({ text: "", ok: false, error, costUsd: 0, durationMs: 0 });
		if (!ctx) return failed("no session context");
		const parts = splitModelRef(ref);
		const model = parts ? ctx.modelRegistry.find(parts.provider, parts.id) : undefined;
		if (!model) return failed(`model ${ref} not found — set one with /auto-review model <provider/id>`);

		const abort = new AbortController();
		reviewLabel = `${shortModel(ref)} · ${effort}`;
		reviewToolCalls = 0;
		showReviewWidget(ctx);
		const manual = reviewManual;
		const stopListening =
			typeof ctx.ui.onTerminalInput === "function"
				? ctx.ui.onTerminalInput((data) => {
						if (!matchesKey(data, "escape")) return undefined;
						abort.abort();
						// During /review the agent is idle, so Esc would otherwise reach the editor.
						return manual ? { consume: true } : undefined;
					})
				: () => {};
		try {
			const result = await runReviewer({
				model,
				effort,
				cwd: workdir,
				userText,
				access: ctx.modelRegistry as never,
				signal: abort.signal,
				timeoutMs: REVIEW_TIMEOUT_MS,
				onProgress: (count) => {
					reviewToolCalls = count;
					reviewLoader?.setMessage(reviewWidgetText());
					ctx.ui.setStatus(`${STATUS_KEY}-review`, reviewWidgetText());
				},
			});
			return result;
		} finally {
			stopListening();
			hideReviewWidget(ctx);
		}
	}

	const reportMessage = (details: ReportDetails) => ({
		customType: REVIEW_REPORT_TYPE,
		content: reportText(details),
		display: true,
		details,
	});

	pi.registerMessageRenderer?.<ReportDetails>(REVIEW_REPORT_TYPE, (message, { expanded, outputPad }, theme) => {
		const details = message.details;
		const raw = typeof message.content === "string" ? message.content : textOf(message.content);
		const [header = "", ...rest] = raw.split("\n");
		const color = (line: string) => {
			if (line.startsWith("[critical]")) return theme.fg("error", line);
			if (line.startsWith("[major]")) return theme.fg("warning", line);
			if (line.startsWith("[minor]")) return theme.fg("muted", line);
			if (line.startsWith("→")) return theme.fg("dim", line);
			return line;
		};
		let text = [theme.fg("accent", theme.bold(header)), ...rest.map(color)].join("\n");
		if (expanded && details) text += `\n\n${theme.fg("dim", reportExpanded(details))}`;
		else if (details) text += `\n${theme.fg("dim", "(Ctrl+O for details)")}`;
		const box = new Box(outputPad, 1, (line) => theme.bg("customMessageBg", line));
		box.addChild(new Text(text, 0, 0));
		return box;
	});

	const persist = () => {
		const state: ModeState = { mode: gercep.getMode(), careful: careful.isActive() };
		// Only sessions that ever used auto-effort carry its fields.
		if (effortUsed) {
			state.autoEffort = effort.isActive();
			const restoreLevel = effort.getRestoreLevel();
			if (restoreLevel !== undefined) state.effortRestore = restoreLevel;
		}
		if (reviewUsed) state.autoReview = autoReview;
		pi.appendEntry<ModeState>(STATE_ENTRY, state);
	};

	/** Ask the judge model; never rejects. */
	const judge = async (ctx: ExtensionContext, prompt: string, previous: string | undefined): Promise<EffortDecision> => {
		const ref = judgeModelRef(readConfig());
		const parts = splitModelRef(ref);
		const model = parts ? ctx.modelRegistry.find(parts.provider, parts.id) : undefined;
		return decideEffort(
			prompt,
			previous,
			async (systemPrompt, userText, signal) => {
				if (!model) throw new Error(`judge model ${ref} not found`);
				const stream = ctx.modelRegistry.streamSimple(
					model,
					{ systemPrompt, messages: [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }] },
					{ signal, maxTokens: 200 },
				);
				const reply = await stream.result();
				if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage ?? reply.stopReason);
				return textOf(reply.content);
			},
			JUDGE_TIMEOUT_MS,
		);
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
		const modes = [gercep.isActive() ? STATUS_TEXT : undefined, careful.isActive() ? CAREFUL_STATUS_TEXT : undefined];
		const parts = [...modes, effort.statusText(), autoReview ? REVIEW_STATUS_TEXT : undefined].filter(
			(part): part is string => part !== undefined,
		);
		ctx.ui.setStatus(STATUS_KEY, parts.length > 0 ? parts.join(" · ") : undefined);
		// The "Working" line shown while the agent runs; undefined restores Pi's default.
		if (typeof ctx.ui.setWorkingMessage === "function") {
			const working = [...modes, effort.workingText()].filter((part): part is string => part !== undefined);
			ctx.ui.setWorkingMessage(workingMessage(working));
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
		effort.restore(!isSubagent && restored.autoEffort === true, restored.effortRestore);
		effortUsed = restored.autoEffort !== undefined;
		autoReview = !isSubagent && restored.autoReview === true;
		reviewUsed = restored.autoReview !== undefined;
		repo = isSubagent ? undefined : repoRoot(sessionCwd);
		repoCache = new Map();
		touchedThisSession.clear();
		review.restore(restoredReviewTask(ctx, repo));
		nextPromptFromExtension = false;
		knownModel = modelKey(ctx.model);
		judgeNextPrompt = false;
		applyIndicators(ctx);
	});

	pi.on("input", (event) => {
		// Only prompts the user typed while idle are judged; extension messages and
		// steering/follow-ups queued during a run keep the current level.
		judgeNextPrompt = event.source !== "extension" && event.streamingBehavior === undefined;
		if (event.streamingBehavior === undefined) nextPromptFromExtension = event.source === "extension";
		return undefined;
	});

	pi.on("model_select", (event) => {
		// Pi emits the re-clamped thinking level without awaiting it, so that handler may run
		// after this one. Record the new model only after pending handlers have run.
		const key = modelKey(event.model);
		setTimeout(() => {
			knownModel = key;
		}, 0);
	});

	pi.on("thinking_level_select", (event, ctx) => {
		// Pi sets the new model before re-clamping the level, so a model switch shows here first.
		const current = modelKey(ctx.model);
		const causedByModelSwitch = current !== knownModel;
		knownModel = current;
		if (effort.onLevelSelected(event.level, causedByModelSwitch)) {
			persist();
			applyIndicators(ctx);
			ctx.ui.notify(`🧠 auto-effort paused: you set thinking to ${event.level}. /auto-effort on to resume.`, "info");
		} else if (effort.isActive()) {
			applyIndicators(ctx);
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const shouldJudge = judgeNextPrompt;
		judgeNextPrompt = false;
		knownModel = modelKey(ctx.model);
		if (effort.isActive() && shouldJudge) {
			const decision = await judge(ctx, event.prompt, lastAssistantText ?? lastAssistantOnBranch(ctx));
			if (effort.isActive()) {
				effort.apply(decision, (level) => pi.setThinkingLevel(level), () => pi.getThinkingLevel());
				applyIndicators(ctx);
				if (decision.fallback) ctx.ui.notify(`🧠 auto-effort: judge failed (${decision.reason}), using ${decision.level}.`, "warning");
			}
		}

		// A prompt from an extension (e.g. an auto-resume after a rate limit) continues the
		// current task, so its review still covers everything since the user's prompt.
		if (!isSubagent) {
			repoCache = new Map();
			review.onUserPrompt(event.prompt, nextPromptFromExtension, repo ? [repo] : []);
		}
		nextPromptFromExtension = false;
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

		// Save each repository's state before the first change to it, so a monorepo folder
		// without git still gets a precise per-repository diff.
		if (!isSubagent) {
			for (const root of reposTouchedBy(event.toolName, input, ctx.cwd ?? sessionCwd)) {
				touchedThisSession.add(root);
				review.touch(root);
			}
		}

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

	// One combined boundary per run, so the modes never compete for it. The review comes
	// first; when it sends findings to fix, the QA/rollback follow-ups wait for the fix run.
	pi.on("agent_before_settle", async (event, ctx) => {
		if (event.outcome !== "completed") {
			review.onRunInterrupted();
			const record = review.takeInterruptedRecord();
			return record ? { entries: [{ type: "custom", customType: REVIEW_TASK_ENTRY, data: record }] } : undefined;
		}
		type Entry = { type: "custom"; customType: string; data: unknown } | { type: "custom_message"; customType: string; content: string; display: boolean; details?: unknown };
		const entries: Entry[] = [];

		let outcome: ReviewOutcome = {};
		if (!isSubagent && !reviewRunning) {
			reviewCtx = ctx;
			reviewManual = false;
			reviewRunning = true;
			try {
				outcome = await review.atSettle(autoReview, lastAssistantText);
			} finally {
				reviewRunning = false;
			}
		}
		if (outcome.record) entries.push({ type: "custom", customType: REVIEW_TASK_ENTRY, data: outcome.record });
		if (outcome.notice) ctx.ui.notify(outcome.notice.text, outcome.notice.level);
		if (outcome.details) entries.push({ type: "custom_message", ...reportMessage(outcome.details) });
		if (outcome.fix) {
			entries.push({ type: "custom_message", customType: REVIEW_FIX_TYPE, content: outcome.fix, display: false });
			return { entries, continue: true };
		}

		const prompts = [gercep.followUpFor(lastAssistantText), careful.followUpFor(lastAssistantText)].filter(
			(prompt): prompt is string => prompt !== undefined,
		);
		if (prompts.length > 0) {
			entries.push({ type: "custom_message", customType: FOLLOW_UP_TYPE, content: prompts.join("\n\n"), display: false });
			return { entries, continue: true };
		}
		return entries.length > 0 ? { entries } : undefined;
	});

	pi.on("session_shutdown", () => {
		reviewLoader?.stop();
		reviewLoader = undefined;
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

	pi.registerCommand(EFFORT_MODE_ID, {
		description: "Auto-effort: a small judge model sets thinking to medium/high/xhigh per prompt (on | off | status | model <provider/id>)",
		getArgumentCompletions: (prefix) => {
			const options = [
				{ value: "on", label: "on — judge each prompt and set medium, high, or xhigh" },
				{ value: "off", label: "off — stop, put back the level from before" },
				{ value: "status", label: "status — show the active modes and the judge model" },
				{ value: "model ", label: `model <provider/id> — judge model (default ${DEFAULT_JUDGE_MODEL})` },
			];
			const filtered = options.filter((option) => option.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const [first = "", ...rest] = trimmed.split(/\s+/);
			const action = first.toLowerCase() || "on";

			if (action === "status") {
				ctx.ui.notify(statusLine(), "info");
				return;
			}

			if (action === "model") {
				const ref = rest.join(" ").trim();
				if (!ref) {
					ctx.ui.notify(`Judge model: ${judgeModelRef(readConfig())}. Change it with /auto-effort model <provider/id>.`, "info");
					return;
				}
				const parts = splitModelRef(ref);
				if (!parts || !ctx.modelRegistry.find(parts.provider, parts.id)) {
					ctx.ui.notify(`Model "${ref}" not found. Use provider/id, e.g. ${DEFAULT_JUDGE_MODEL}.`, "warning");
					return;
				}
				try {
					writeJudgeModel(ref);
				} catch (error) {
					ctx.ui.notify(`Could not save the judge model: ${error instanceof Error ? error.message : String(error)}`, "error");
					return;
				}
				ctx.ui.notify(`🧠 Judge model set to ${ref} for every session.`, "info");
				return;
			}

			if (action === "on") {
				if (isSubagent) {
					ctx.ui.notify("Auto-effort does not run in subagents.", "warning");
					return;
				}
				if (effort.isActive()) {
					ctx.ui.notify("Auto-effort is already on for this session.", "info");
					return;
				}
				effort.turnOn(pi.getThinkingLevel());
				effortUsed = true;
				persist();
				applyIndicators(ctx);
				ctx.ui.notify(
					`🧠 Auto-effort on: ${judgeModelRef(readConfig())} picks medium, high, or xhigh before each prompt you send. Changing the level yourself pauses it. /auto-effort off to stop.`,
					"info",
				);
				return;
			}

			if (action === "off") {
				if (!effort.isActive()) {
					ctx.ui.notify("Auto-effort is already off.", "info");
					return;
				}
				const restoreTo = effort.turnOff();
				if (restoreTo !== undefined) effort.ownChange(() => pi.setThinkingLevel(restoreTo));
				persist();
				applyIndicators(ctx);
				ctx.ui.notify(`Auto-effort off: thinking is back to ${pi.getThinkingLevel()}.`, "info");
				return;
			}

			ctx.ui.notify(`Unknown argument "${action}". Use /auto-effort on | off | status | model <provider/id>.`, "warning");
		},
	});

	/** Repositories a tool call may change: the file's repository, or those a bash command moves into. */
	function reposTouchedBy(toolName: string, input: Record<string, unknown>, cwd: string): string[] {
		const found = new Set<string>();
		const add = (path: string | undefined) => {
			if (!path) return;
			const root = repoForPath(path, repoCache);
			if (root) found.add(root);
		};
		if (toolName === "write" || toolName === "edit") {
			const path = typeof input.path === "string" ? input.path : undefined;
			if (path) add(path.startsWith("/") ? path : `${cwd.replace(/\/$/, "")}/${path}`);
		} else if (toolName === "bash") {
			const command = typeof input.command === "string" ? input.command : "";
			for (const dir of commandDirs(command, cwd)) add(`${dir}/.`);
			add(`${cwd}/.`);
		}
		return [...found];
	}

	/** /review: review now, while the agent is idle; findings to fix start a new run. */
	const manualReview = async (scope: ReviewScope, ctx: ExtensionContext) => {
		if (isSubagent) {
			ctx.ui.notify("/review does not run in subagents.", "warning");
			return;
		}
		if (!ctx.isIdle()) {
			ctx.ui.notify("🔍 The agent is still working. Run /review when it is done.", "info");
			return;
		}
		if (reviewRunning) {
			ctx.ui.notify("🔍 A review is already running.", "info");
			return;
		}
		repo ??= repoRoot(ctx.cwd ?? sessionCwd);
		reviewCtx = ctx;
		reviewManual = true;
		reviewRunning = true;
		let outcome: ReviewOutcome;
		try {
			outcome = await review.manual(scope, lastAssistantText ?? lastAssistantOnBranch(ctx));
		} finally {
			reviewRunning = false;
			reviewManual = false;
		}
		if (outcome.notice) ctx.ui.notify(outcome.notice.text, outcome.notice.level);
		if (outcome.details) pi.sendMessage(reportMessage(outcome.details));
		if (outcome.fix) {
			// The fix run is a continuation of this review, not a new task.
			nextPromptFromExtension = true;
			pi.sendMessage({ customType: REVIEW_FIX_TYPE, content: outcome.fix, display: false }, { triggerTurn: true });
		}
	};

	pi.registerCommand("review", {
		description: "Review changes now with an independent reviewer model (task | session | uncommitted)",
		getArgumentCompletions: (prefix) => {
			const options = [
				{ value: "task", label: "task — the last task that changed files (default)" },
				{ value: "session", label: "session — every change the agent made in this session" },
				{ value: "uncommitted", label: "uncommitted — all uncommitted changes (git diff HEAD + new files)" },
			];
			const filtered = options.filter((option) => option.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const scope = (args.trim().toLowerCase() || "task") as ReviewScope;
			if (!REVIEW_SCOPES.includes(scope)) {
				ctx.ui.notify(`Unknown argument "${args.trim()}". Use /review, /review session, or /review uncommitted.`, "warning");
				return;
			}
			await manualReview(scope, ctx);
		},
	});

	pi.registerCommand(REVIEW_MODE_ID, {
		description: "Auto-review: an independent reviewer model checks each task's diff (on | off | status | model <provider/id>)",
		getArgumentCompletions: (prefix) => {
			const options = [
				{ value: "on", label: "on — review every task that changes more than 20 lines or a risky path" },
				{ value: "off", label: "off — stop automatic reviews (/review still works)" },
				{ value: "status", label: "status — show the active modes and the reviewer model" },
				{ value: "model ", label: `model <provider/id> — reviewer model (default ${DEFAULT_REVIEW_MODEL})` },
			];
			const filtered = options.filter((option) => option.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const [first = "", ...rest] = args.trim().split(/\s+/);
			const action = first.toLowerCase() || "on";

			if (action === "status") {
				ctx.ui.notify(statusLine(), "info");
				return;
			}

			if (action === "model") {
				const ref = rest.join(" ").trim();
				if (!ref) {
					ctx.ui.notify(`Reviewer model: ${reviewModelRef(reviewConfig())}. Change it with /auto-review model <provider/id>.`, "info");
					return;
				}
				const parts = splitModelRef(ref);
				if (!parts || !ctx.modelRegistry.find(parts.provider, parts.id)) {
					ctx.ui.notify(`Model "${ref}" not found. Use provider/id, e.g. ${DEFAULT_REVIEW_MODEL}.`, "warning");
					return;
				}
				try {
					writeReviewModel(ref);
				} catch (error) {
					ctx.ui.notify(`Could not save the reviewer model: ${error instanceof Error ? error.message : String(error)}`, "error");
					return;
				}
				ctx.ui.notify(`🔍 Reviewer model set to ${ref} for every session.`, "info");
				return;
			}

			if (action === "on") {
				if (isSubagent) {
					ctx.ui.notify("Auto-review does not run in subagents.", "warning");
					return;
				}
				if (autoReview) {
					ctx.ui.notify("Auto-review is already on for this session.", "info");
					return;
				}
				repo ??= repoRoot(ctx.cwd ?? sessionCwd);
				const monorepo = !repo && scanRoot(ctx.cwd ?? sessionCwd) !== undefined;
				autoReview = true;
				reviewUsed = true;
				persist();
				applyIndicators(ctx);
				ctx.ui.notify(
					`🔍 Auto-review on: ${reviewModelRef(reviewConfig())} reviews each task that changes more than 20 lines or a risky path; critical/major findings go back to the agent, then one re-review. /auto-review off to stop.${
						repo
							? ""
							: monorepo
								? " (This folder is not a git repository itself: repositories inside it are reviewed as the agent changes them.)"
								: " (This folder is not a git repository and has none inside it, so nothing will be reviewed here.)"
					}`,
					repo || monorepo ? "info" : "warning",
				);
				return;
			}

			if (action === "off") {
				if (!autoReview) {
					ctx.ui.notify("Auto-review is already off.", "info");
					return;
				}
				autoReview = false;
				persist();
				applyIndicators(ctx);
				ctx.ui.notify("Auto-review off. /review still reviews on demand.", "info");
				return;
			}

			ctx.ui.notify(`Unknown argument "${action}". Use /auto-review on | off | status | model <provider/id>.`, "warning");
		},
	});

	function statusLine(): string {
		const last = effort.getLastDecision();
		const active = [
			gercep.isActive() ? `gercep (no tests/typecheck/lint/build, ends with "${QA_HEADING}")` : undefined,
			careful.isActive() ? `hati-hati (confirms risky commands, ends with "${ROLLBACK_HEADING}")` : undefined,
			effort.isActive()
				? `auto-effort (judge ${judgeModelRef(readConfig())}${last ? `, last: ${last.level}${last.reason ? ` — ${last.reason}` : ""}` : ""})`
				: undefined,
			autoReview ? `auto-review (reviewer ${reviewModelRef(reviewConfig())}${repo ? "" : ", monorepo folder"})` : undefined,
		].filter((part): part is string => part !== undefined);
		return active.length > 0
			? `Active modes: ${active.join(" + ")}.`
			: "Mode: default — pi behaves exactly as without this package. /gercep, /hati-hati, /auto-effort, or /auto-review to switch.";
	}
}
