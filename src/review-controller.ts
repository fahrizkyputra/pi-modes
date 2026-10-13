/**
 * The review state machine for one session, independent of Pi and git.
 *
 * A task starts when the user sends a prompt: the working tree is snapshotted.
 * When the run ends, the change since that snapshot is reviewed (automatically
 * when auto-review is on and the change is big or risky, or later with /review).
 * Critical/major findings go back to the agent; when that fix run ends, only the
 * fix diff is re-reviewed, once. Then the task is done.
 */

import {
	type DiffStats,
	type Finding,
	MAX_ROUNDS,
	type ReportDetails,
	type ReviewEffort,
	type ReviewScope,
	blockingFindings,
	decideAction,
	fixPrompt,
	parseReviewerReply,
	pickEffort,
	reviewerUserText,
	shortModel,
	shouldAutoReview,
} from "./review.ts";

export interface ReviewerRun {
	text: string;
	ok: boolean;
	error?: string;
	costUsd: number;
	durationMs: number;
}

export interface ReviewHost {
	/** Tree of the working tree now, or undefined outside git / on failure. */
	snapshot(): string | undefined;
	/** Tree of HEAD (the empty tree without commits). */
	headTree(): string | undefined;
	diff(from: string, to: string): { stats: DiffStats; patch: string } | undefined;
	/** Model reference used for reviews, e.g. 9router/cc/claude-opus-5-5. */
	modelRef(): string;
	runReviewer(userText: string, effort: ReviewEffort): Promise<ReviewerRun>;
}

/** Persisted so /review still finds the last task after /reload or /resume. */
export interface TaskRecord {
	request: string;
	base: string;
	sessionBase?: string;
}

type Phase = "idle" | "awaiting-fix" | "done";

export interface ReviewOutcome {
	/** The report, when a review ran. */
	details?: ReportDetails;
	/** Hidden prompt that sends critical/major findings to the agent. */
	fix?: string;
	/** Notice for the user when no report is produced (skipped, failed, nothing to review). */
	notice?: { text: string; level: "info" | "warning" };
	/** A task to persist (first time a run's change is seen). */
	record?: TaskRecord;
	/** Effort chosen, for the live status while the reviewer runs. */
	effort?: ReviewEffort;
}

export class ReviewController {
	private phase: Phase = "done";
	private request = "";
	private base: string | undefined;
	private sessionBase: string | undefined;
	private recorded = false;
	/** For the re-review after a fix. */
	private fixBase: string | undefined;
	private fixScope: ReviewScope = "task";
	private previous: Finding[] = [];
	/** The last task with a change, for /review. */
	private lastTask: TaskRecord | undefined;

	private readonly host: ReviewHost;

	constructor(host: ReviewHost) {
		this.host = host;
	}

	/** Restore /review's targets from persisted records. */
	restore(record: TaskRecord | undefined): void {
		this.lastTask = record;
		this.sessionBase = record?.sessionBase ?? record?.base;
		this.phase = "done";
		this.base = undefined;
	}

	getLastTask(): TaskRecord | undefined {
		return this.lastTask;
	}

	isAwaitingFix(): boolean {
		return this.phase === "awaiting-fix";
	}

	/**
	 * A prompt starts a run. From the user: a new task begins at the current working
	 * tree. From an extension (e.g. an auto-resume after a rate limit) while a task is
	 * still open: the same task continues, keeping its starting point.
	 */
	onUserPrompt(prompt: string, fromExtension = false): void {
		if (fromExtension && this.phase === "idle" && this.base !== undefined) return;
		if (fromExtension && this.phase === "awaiting-fix") return;
		this.base = this.host.snapshot();
		this.sessionBase ??= this.base;
		this.request = prompt;
		this.phase = "idle";
		this.recorded = false;
		this.previous = [];
		this.fixBase = undefined;
	}

	/**
	 * The run was aborted or failed. The task stays open (an auto-resume may continue
	 * it, and /review still covers it), but a pending re-review is dropped.
	 */
	onRunInterrupted(): void {
		if (this.phase === "awaiting-fix") this.phase = "done";
		if (this.phase === "idle" && this.base !== undefined && !this.recorded) {
			const end = this.host.snapshot();
			if (end !== undefined && end !== this.base) this.pendingRecord = true;
		}
	}

	/** A task changed files but its run was interrupted: record it for /review at the next settle. */
	private pendingRecord = false;

	/** Record an interrupted task with changes, so /review can still find it. */
	takeInterruptedRecord(): TaskRecord | undefined {
		if (!this.pendingRecord || this.recorded || this.base === undefined) return undefined;
		this.pendingRecord = false;
		this.recorded = true;
		this.lastTask = { request: this.request, base: this.base, sessionBase: this.sessionBase };
		return this.lastTask;
	}

	/**
	 * The run is about to settle. Records the task, and reviews when auto-review
	 * is on (first round) or a fix is waiting for its re-review.
	 */
	async atSettle(autoActive: boolean, agentSummary: string | undefined, onEffort?: (effort: ReviewEffort) => void): Promise<ReviewOutcome> {
		if (this.phase === "awaiting-fix") {
			return this.reReview(agentSummary, onEffort);
		}
		if (this.phase !== "idle" || this.base === undefined) return {};

		const end = this.host.snapshot();
		if (end === undefined || end === this.base) return {};
		const outcome: ReviewOutcome = {};
		if (!this.recorded) {
			this.recorded = true;
			this.lastTask = { request: this.request, base: this.base, sessionBase: this.sessionBase };
			outcome.record = this.lastTask;
		}
		if (!autoActive) return outcome;

		const diff = this.host.diff(this.base, end);
		if (!diff || !shouldAutoReview(diff.stats)) {
			this.phase = "done";
			return outcome;
		}
		const result = await this.review({ round: 1, scope: "task", request: this.request, agentSummary, end, ...diff }, onEffort);
		return { ...outcome, ...result };
	}

	/** /review [task|session|uncommitted], run while the agent is idle. */
	async manual(scope: ReviewScope, agentSummary: string | undefined, onEffort?: (effort: ReviewEffort) => void): Promise<ReviewOutcome> {
		const end = this.host.snapshot();
		if (end === undefined) return { notice: { text: "🔍 /review needs a git repository.", level: "warning" } };

		let from: string | undefined;
		let request = "";
		if (scope === "task") {
			if (!this.lastTask) return { notice: { text: "🔍 No task with file changes in this session yet. Try /review uncommitted.", level: "info" } };
			from = this.lastTask.base;
			request = this.lastTask.request;
		} else if (scope === "session") {
			from = this.sessionBase ?? this.lastTask?.sessionBase ?? this.lastTask?.base;
			if (!from) return { notice: { text: "🔍 Nothing changed in this session yet. Try /review uncommitted.", level: "info" } };
			request = this.lastTask ? `All work in this session. Latest request: ${this.lastTask.request}` : "All work in this session.";
		} else {
			from = this.host.headTree();
			request = "Review all uncommitted changes (working tree against HEAD).";
		}
		if (!from) return { notice: { text: "🔍 Could not read the repository state.", level: "warning" } };

		const diff = this.host.diff(from, end);
		if (diff === undefined) {
			return { notice: { text: "🔍 The saved snapshot is no longer available (git may have pruned it). Try /review uncommitted.", level: "warning" } };
		}
		if (diff.stats.files.length === 0) return { notice: { text: "🔍 No changes to review.", level: "info" } };
		this.request = request;
		return this.review({ round: 1, scope, request, agentSummary, end, ...diff }, onEffort);
	}

	private async reReview(agentSummary: string | undefined, onEffort?: (effort: ReviewEffort) => void): Promise<ReviewOutcome> {
		this.phase = "done";
		const end = this.host.snapshot();
		if (end === undefined || this.fixBase === undefined) return {};
		if (end === this.fixBase) {
			return { notice: { text: "🔍 The agent changed no files for the findings; no re-review.", level: "info" } };
		}
		const diff = this.host.diff(this.fixBase, end);
		if (!diff) return {};
		return this.review({ round: 2, scope: this.fixScope, request: this.request, agentSummary, end, previous: this.previous, ...diff }, onEffort);
	}

	private async review(
		input: {
			round: number;
			scope: ReviewScope;
			request: string;
			agentSummary?: string;
			end: string;
			stats: DiffStats;
			patch: string;
			previous?: Finding[];
		},
		onEffort?: (effort: ReviewEffort) => void,
	): Promise<ReviewOutcome> {
		const { effort, reason } = pickEffort(input.stats);
		onEffort?.(effort);
		const model = this.host.modelRef();
		const run = await this.host.runReviewer(reviewerUserText(input), effort);
		if (!run.ok) {
			this.phase = "done";
			const cancelled = run.error === "cancelled";
			return {
				effort,
				notice: {
					text: cancelled ? "🔍 Review cancelled." : `🔍 Review failed (${shortModel(model)}): ${run.error ?? "unknown error"}. Nothing was sent to fix.`,
					level: cancelled ? "info" : "warning",
				},
			};
		}

		const parsed = parseReviewerReply(run.text);
		const action = decideAction(input.round, parsed?.findings);
		const details: ReportDetails = {
			round: input.round,
			scope: input.scope,
			model,
			effort,
			effortReason: reason,
			files: input.stats.files.length,
			lines: input.stats.lines,
			findings: parsed?.findings ?? [],
			checked: parsed?.checked ?? [],
			action,
			costUsd: run.costUsd,
			durationMs: run.durationMs,
			raw: run.text,
		};

		if (action === "sent-to-fix" && input.round < MAX_ROUNDS) {
			this.phase = "awaiting-fix";
			this.fixBase = input.end;
			this.fixScope = input.scope;
			this.previous = blockingFindings(details.findings);
			return { details, effort, fix: fixPrompt(this.previous, shortModel(model)) };
		}
		this.phase = "done";
		return { details, effort };
	}
}
