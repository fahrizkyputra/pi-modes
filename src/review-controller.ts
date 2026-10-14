/**
 * The review state machine for one session, independent of Pi and git.
 *
 * A task starts when the user sends a prompt. Every repository the task touches
 * is snapshotted before its first change (a monorepo folder may hold many
 * repositories, and only the touched ones matter). When the run ends, the change
 * since those snapshots is reviewed (automatically when auto-review is on and the
 * change is big or risky, or later with /review). Critical/major findings go back
 * to the agent; when that fix run ends, only the fix diff is re-reviewed, once.
 */

import {
	type DiffStats,
	type Finding,
	type Snapshot,
	MAX_ROUNDS,
	type ReportDetails,
	type ReviewEffort,
	type ReviewScope,
	CONFIRM_LINES,
	CONFIRM_REPOS,
	blockingFindings,
	decideAction,
	largeReviewQuestion,
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
	/** The current working tree of each given repository (those that cannot be read are left out). */
	snapshot(roots: readonly string[]): Snapshot;
	/** Repositories with uncommitted changes under the monorepo folder (or the repository itself). */
	scanDirty(): Promise<{ dirty: string[]; found: number }>;
	/** HEAD tree of each repository (the empty tree before the first commit). */
	headTrees(roots: readonly string[]): Snapshot;
	/**
	 * Diff of every repository present in both snapshots, merged into one patch whose paths
	 * start with the repository folder, relative to `workdir` (the folder that contains them
	 * all). Undefined when a snapshot is gone.
	 */
	diff(from: Snapshot, to: Snapshot): { stats: DiffStats; patch: string; repos: string[]; workdir: string } | undefined;
	/** Model reference used for reviews, e.g. 9router/cc/claude-opus-5-5. */
	modelRef(): string;
	runReviewer(userText: string, effort: ReviewEffort, workdir: string): Promise<ReviewerRun>;
	/** Ask the user before a large review; false means "no" (also when there is no way to ask). */
	confirm(question: string): Promise<boolean>;
}

/** Persisted so /review still finds the last task after /reload or /resume. */
export interface TaskRecord {
	request: string;
	/** One git tree per repository root, taken before the task first touched that repository. */
	base: Snapshot;
	/** Same, taken before the session first touched each repository. */
	sessionBase?: Snapshot;
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

const changedRoots = (from: Snapshot, to: Snapshot): string[] =>
	Object.keys(from).filter((root) => to[root] !== undefined && to[root] !== from[root]);

export class ReviewController {
	private phase: Phase = "done";
	private request = "";
	/** Repositories this task touched, as they were before the task first touched them. */
	private base: Snapshot = {};
	private sessionBase: Snapshot = {};
	private recorded = false;
	/** For the re-review after a fix: the state after the first review, plus repositories the fix touched. */
	private fixBase: Snapshot = {};
	private fixScope: ReviewScope = "task";
	private previous: Finding[] = [];
	/** The last task with a change, for /review. */
	private lastTask: TaskRecord | undefined;
	/** Set when a run was interrupted after changing files, so /review can still find the task. */
	private pendingRecord = false;

	private readonly host: ReviewHost;

	constructor(host: ReviewHost) {
		this.host = host;
	}

	/** Restore /review's targets from persisted records. */
	restore(record: TaskRecord | undefined): void {
		this.lastTask = record;
		this.sessionBase = { ...(record?.sessionBase ?? record?.base ?? {}) };
		this.phase = "done";
		this.base = {};
	}

	getLastTask(): TaskRecord | undefined {
		return this.lastTask;
	}

	isAwaitingFix(): boolean {
		return this.phase === "awaiting-fix";
	}

	/**
	 * A prompt starts a run. From the user: a new task begins, with `startRoots` (the
	 * repository the session runs in) snapshotted now. From an extension (e.g. an
	 * auto-resume after a rate limit) while a task is still open: the same task continues.
	 */
	onUserPrompt(prompt: string, fromExtension = false, startRoots: readonly string[] = []): void {
		if (fromExtension && this.phase === "idle") return;
		if (fromExtension && this.phase === "awaiting-fix") return;
		this.base = {};
		this.request = prompt;
		this.phase = "idle";
		this.recorded = false;
		this.pendingRecord = false;
		this.previous = [];
		this.fixBase = {};
		for (const root of startRoots) this.touch(root);
	}

	/**
	 * A tool is about to change something in this repository. Its state is saved the
	 * first time, before the change, so the task's diff starts from here.
	 */
	touch(root: string): void {
		if (this.phase === "done") return;
		const target = this.phase === "awaiting-fix" ? this.fixBase : this.base;
		if (root in target && root in this.sessionBase) return;
		const snapshot = this.host.snapshot([root])[root];
		if (snapshot === undefined) return;
		if (!(root in target)) target[root] = snapshot;
		if (!(root in this.sessionBase)) this.sessionBase[root] = snapshot;
	}

	/**
	 * The run was aborted or failed. The task stays open (an auto-resume may continue
	 * it, and /review still covers it), but a pending re-review is dropped.
	 */
	onRunInterrupted(): void {
		if (this.phase === "awaiting-fix") this.phase = "done";
		if (this.phase === "idle" && !this.recorded) {
			const roots = Object.keys(this.base);
			if (changedRoots(this.base, this.host.snapshot(roots)).length > 0) this.pendingRecord = true;
		}
	}

	/** Record an interrupted task with changes, so /review can still find it. */
	takeInterruptedRecord(): TaskRecord | undefined {
		if (!this.pendingRecord || this.recorded) return undefined;
		this.pendingRecord = false;
		this.recorded = true;
		this.lastTask = { request: this.request, base: { ...this.base }, sessionBase: { ...this.sessionBase } };
		return this.lastTask;
	}

	/**
	 * The run is about to settle. Records the task, and reviews when auto-review
	 * is on (first round) or a fix is waiting for its re-review.
	 */
	async atSettle(autoActive: boolean, agentSummary: string | undefined, onEffort?: (effort: ReviewEffort) => void): Promise<ReviewOutcome> {
		if (this.phase === "awaiting-fix") return this.reReview(agentSummary, onEffort);
		if (this.phase !== "idle") return {};

		const roots = Object.keys(this.base);
		if (roots.length === 0) return {};
		const end = this.host.snapshot(roots);
		if (changedRoots(this.base, end).length === 0) return {};

		const outcome: ReviewOutcome = {};
		if (!this.recorded) {
			this.recorded = true;
			this.lastTask = { request: this.request, base: { ...this.base }, sessionBase: { ...this.sessionBase } };
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
		let from: Snapshot;
		let roots: string[];
		let request = "";
		if (scope === "task") {
			if (!this.lastTask) return { notice: { text: "🔍 No task with file changes in this session yet. Try /review uncommitted.", level: "info" } };
			from = this.lastTask.base;
			roots = Object.keys(from);
			request = this.lastTask.request;
		} else if (scope === "session") {
			from = this.sessionBase;
			if (Object.keys(from).length === 0) return { notice: { text: "🔍 Nothing changed in this session yet. Try /review uncommitted.", level: "info" } };
			roots = Object.keys(from);
			request = this.lastTask ? `All work in this session. Latest request: ${this.lastTask.request}` : "All work in this session.";
		} else {
			const scan = await this.host.scanDirty();
			if (scan.found === 0) return { notice: { text: "🔍 /review uncommitted needs a git repository here or in a folder below.", level: "warning" } };
			if (scan.dirty.length === 0) return { notice: { text: `🔍 No uncommitted changes in ${scan.found} repositor${scan.found === 1 ? "y" : "ies"}.`, level: "info" } };
			roots = scan.dirty;
			from = this.host.headTrees(roots);
			request =
				roots.length > 1
					? `Review all uncommitted changes (working tree against HEAD) in ${roots.length} repositories.`
					: "Review all uncommitted changes (working tree against HEAD).";
		}

		const end = this.host.snapshot(roots);
		if (Object.keys(end).length === 0) return { notice: { text: "🔍 Could not read the repository state.", level: "warning" } };
		const diff = this.host.diff(from, end);
		if (diff === undefined) {
			return { notice: { text: "🔍 The saved snapshot is no longer available (git may have pruned it). Try /review uncommitted.", level: "warning" } };
		}
		if (diff.stats.files.length === 0) return { notice: { text: "🔍 No changes to review.", level: "info" } };
		// A folder of unrelated projects is not one change: ask before sending that much.
		if (scope === "uncommitted" && (diff.repos.length > CONFIRM_REPOS || diff.stats.lines > CONFIRM_LINES)) {
			const approved = await this.host.confirm(largeReviewQuestion(diff.repos, diff.stats.files.length, diff.stats.lines));
			if (!approved) return { notice: { text: "🔍 Review skipped. Run /review inside one repository, or /review task for what the agent changed.", level: "info" } };
		}
		this.request = request;
		return this.review({ round: 1, scope, request, agentSummary, end, ...diff }, onEffort);
	}

	private async reReview(agentSummary: string | undefined, onEffort?: (effort: ReviewEffort) => void): Promise<ReviewOutcome> {
		this.phase = "done";
		const roots = Object.keys(this.fixBase);
		if (roots.length === 0) return {};
		const end = this.host.snapshot(roots);
		if (changedRoots(this.fixBase, end).length === 0) {
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
			end: Snapshot;
			stats: DiffStats;
			patch: string;
			repos: string[];
			workdir: string;
			previous?: Finding[];
		},
		onEffort?: (effort: ReviewEffort) => void,
	): Promise<ReviewOutcome> {
		const { effort, reason } = pickEffort(input.stats);
		onEffort?.(effort);
		const model = this.host.modelRef();
		const run = await this.host.runReviewer(reviewerUserText(input), effort, input.workdir);
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
			...(input.repos.length > 1 ? { repos: input.repos } : {}),
			findings: parsed?.findings ?? [],
			checked: parsed?.checked ?? [],
			action,
			costUsd: run.costUsd,
			durationMs: run.durationMs,
			raw: run.text,
		};

		if (action === "sent-to-fix" && input.round < MAX_ROUNDS) {
			this.phase = "awaiting-fix";
			this.fixBase = { ...input.end };
			this.fixScope = input.scope;
			this.previous = blockingFindings(details.findings);
			return { details, effort, fix: fixPrompt(this.previous, shortModel(model)) };
		}
		this.phase = "done";
		return { details, effort };
	}
}
