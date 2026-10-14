/**
 * auto-review and /review: an independent reviewer model reads the diff of a
 * task with read-only tools and reports findings. Critical and major findings
 * go back to the agent to fix, then the fix gets one re-review.
 *
 * Pure logic only: prompts, thresholds, parsing, and report text. Git lives in
 * git-snapshot.ts, the reviewer run in reviewer.ts, the wiring in the extension.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, sep } from "node:path";
import { configPath, readConfig } from "./effort.ts";

export const REVIEW_MODE_ID = "auto-review";
export const DEFAULT_REVIEW_MODEL = "9router/cc/claude-opus-5-5";
/** Automatic review only for diffs above this many changed lines (risky paths always). */
export const MIN_LINES = 20;
/** Above either of these, the review runs at xhigh. */
export const LARGE_FILES = 10;
export const LARGE_LINES = 400;
/** Reviews per task: the first review plus one re-review of the fix. */
export const MAX_ROUNDS = 2;
/** /review uncommitted asks first when it would review more repositories than this, or more lines. */
export const CONFIRM_REPOS = 3;
export const CONFIRM_LINES = 3000;
/** The patch sent to the reviewer is cut here; it can still read the files. */
export const MAX_PATCH_CHARS = 120_000;
export const REVIEW_TIMEOUT_MS = 15 * 60_000;
/** After this many tool calls the reviewer is told to answer; at the hard cap it is stopped. */
export const TOOL_SOFT_CAP = 40;
export const TOOL_HARD_CAP = 60;

export type Severity = "critical" | "major" | "minor";
export type ReviewEffort = "high" | "xhigh";
export type ReviewScope = "task" | "session" | "uncommitted";

export const DEFAULT_RISKY_PATTERNS: readonly string[] = [
	"auth",
	"login",
	"session",
	"token",
	"secret",
	"password",
	"crypto",
	"payment",
	"billing",
	"migration",
	"permission",
	".env",
	".sql",
];

export interface Finding {
	severity: Severity;
	file?: string;
	line?: number;
	title: string;
	detail?: string;
	fix?: string;
}

export interface FileStat {
	path: string;
	added: number;
	deleted: number;
	binary: boolean;
}

export interface DiffStats {
	files: FileStat[];
	lines: number;
	riskyFiles: string[];
}

// ---- several repositories ----------------------------------------------------------

/** Working-tree snapshots, one git tree per repository root. */
export type Snapshot = Record<string, string>;

/** The folder that contains every given path (a single path is its own folder). */
export function commonAncestor(paths: readonly string[]): string {
	if (paths.length === 0) return sep;
	const split = paths.map((path) => path.split(sep));
	const first = split[0] ?? [];
	let length = first.length;
	for (const parts of split) {
		let index = 0;
		while (index < length && index < parts.length && parts[index] === first[index]) index++;
		length = index;
	}
	return first.slice(0, length).join(sep) || sep;
}

/** A repository's folder relative to the shared one, "" when it is that folder. */
export function repoLabel(workdir: string, root: string): string {
	return relative(workdir, root).split(sep).join("/");
}

/** Put every path of a `git diff --numstat` output under a folder name. */
export function labelNumstat(output: string, label: string): string {
	if (!label) return output;
	return output
		.split("\n")
		.map((line) => {
			const parts = line.split("\t");
			return parts.length < 3 ? line : `${parts[0]}\t${parts[1]}\t${label}/${parts.slice(2).join("\t")}`;
		})
		.join("\n");
}

/**
 * Directories a shell command works in: `cd <dir>`, `git -C <dir>`, `pushd <dir>`.
 * Only plain words are understood (no variables or substitutions), which covers the
 * usual `cd frnd-web && ...`. Anything else is ignored, never guessed.
 */
export function commandDirs(command: string, cwd: string): string[] {
	const dirs: string[] = [];
	for (const match of command.matchAll(/(?:^|[;&|(])\s*(?:cd|pushd|git\s+-C)\s+(?:"([^"$`]+)"|'([^']+)'|([^\s;&|)$`"']+))/g)) {
		const raw = match[1] ?? match[2] ?? match[3];
		if (!raw) continue;
		const expanded = raw === "~" || raw.startsWith("~/") ? (process.env.HOME ?? "") + raw.slice(1) : raw;
		dirs.push(expanded.startsWith("/") ? expanded : `${cwd.replace(/\/$/, "")}/${expanded}`);
	}
	return dirs;
}

/** The question shown before a large /review uncommitted. */
export function largeReviewQuestion(repos: readonly string[], files: number, lines: number): string {
	const shown = repos.slice(0, 8).join(", ");
	const more = repos.length > 8 ? ` and ${repos.length - 8} more` : "";
	return [
		`/review uncommitted would send ${files} files (${lines} lines) from ${repos.length} repositories to the reviewer:`,
		`${shown}${more}`,
		"",
		"A folder of unrelated projects is not one change. Review them together anyway? The diff is cut at 120k characters.",
	].join("\n");
}

export function mergeStats(list: readonly DiffStats[]): DiffStats {
	return {
		files: list.flatMap((stats) => stats.files),
		lines: list.reduce((sum, stats) => sum + stats.lines, 0),
		riskyFiles: list.flatMap((stats) => stats.riskyFiles),
	};
}

// ---- config (~/.pi/agent/pi-modes.json, key "autoReview") -------------------------

export interface ReviewConfig {
	model?: string;
	riskyPaths?: string[];
}

export function reviewConfig(path = configPath()): ReviewConfig {
	const config = readConfig(path) as { autoReview?: unknown };
	const value = config.autoReview;
	return value && typeof value === "object" ? (value as ReviewConfig) : {};
}

export function reviewModelRef(config: ReviewConfig): string {
	const ref = config.model;
	return typeof ref === "string" && /^[^/\s]+\/\S+$/.test(ref.trim()) ? ref.trim() : DEFAULT_REVIEW_MODEL;
}

export function riskyPatterns(config: ReviewConfig): string[] {
	const extra = Array.isArray(config.riskyPaths) ? config.riskyPaths.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];
	return [...DEFAULT_RISKY_PATTERNS, ...extra.map((item) => item.trim())];
}

export function writeReviewModel(ref: string, path = configPath()): void {
	let config: Record<string, unknown> = {};
	try {
		if (existsSync(path)) {
			const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
			if (data && typeof data === "object") config = data as Record<string, unknown>;
		}
	} catch {
		config = {};
	}
	const current = config.autoReview && typeof config.autoReview === "object" ? (config.autoReview as Record<string, unknown>) : {};
	config.autoReview = { ...current, model: ref };
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

// ---- diff size and risk ---------------------------------------------------------

export function isRiskyPath(path: string, patterns: readonly string[]): boolean {
	const lower = path.toLowerCase();
	return patterns.some((pattern) => lower.includes(pattern.toLowerCase()));
}

/** Parse `git diff --numstat -z`-free output: "added<TAB>deleted<TAB>path" per line. */
export function parseNumstat(output: string, patterns: readonly string[]): DiffStats {
	const files: FileStat[] = [];
	for (const line of output.split("\n")) {
		if (!line.trim()) continue;
		const [added = "", deleted = "", ...rest] = line.split("\t");
		const path = rest.join("\t");
		if (!path) continue;
		const binary = added === "-" || deleted === "-";
		files.push({ path, added: binary ? 0 : Number(added) || 0, deleted: binary ? 0 : Number(deleted) || 0, binary });
	}
	return {
		files,
		lines: files.reduce((sum, file) => sum + file.added + file.deleted, 0),
		riskyFiles: files.filter((file) => isRiskyPath(file.path, patterns)).map((file) => file.path),
	};
}

/** Automatic review: more than MIN_LINES changed lines, or any risky path. */
export function shouldAutoReview(stats: DiffStats): boolean {
	if (stats.files.length === 0) return false;
	return stats.lines > MIN_LINES || stats.riskyFiles.length > 0;
}

export function pickEffort(stats: DiffStats): { effort: ReviewEffort; reason: string } {
	if (stats.riskyFiles.length > 0) return { effort: "xhigh", reason: `risky path: ${stats.riskyFiles.slice(0, 3).join(", ")}` };
	if (stats.files.length > LARGE_FILES) return { effort: "xhigh", reason: `${stats.files.length} files changed` };
	if (stats.lines > LARGE_LINES) return { effort: "xhigh", reason: `${stats.lines} lines changed` };
	return { effort: "high", reason: "normal change" };
}

// ---- reviewer prompts -------------------------------------------------------------

export const REVIEWER_SYSTEM_PROMPT = [
	"You are an independent senior code reviewer. Another agent made the change below; you did not see its conversation.",
	"Your job: find real defects in the change before it ships. You have read-only tools (read, grep, find, ls) on the repository at its current state. Use them to check callers, types, and code around the diff instead of guessing.",
	"",
	"Look for, in this order:",
	"1. Behavior that does not do what the request asked, or breaks existing behavior (regressions, changed contracts, callers not updated).",
	"2. Bugs on realistic inputs: wrong conditions, off-by-one, null/undefined, error paths, async/race issues, resource leaks.",
	"3. Security: injection, auth/permission bypass, secrets in code or logs, unsafe deserialization, path traversal.",
	"4. Data safety: destructive operations, migrations without rollback, lost writes.",
	"Do not report style, naming, or formatting preferences. Do not report things you could not confirm from the code; read the code first.",
	"",
	"Severity:",
	"- critical: security hole, data loss, or a crash/failure on the main path.",
	"- major: wrong behavior or a regression on a realistic input, or the request is not met.",
	"- minor: unlikely edge case, missing test, or maintainability concern.",
	"",
	"Finish with exactly one JSON block and nothing after it:",
	"```json",
	'{"findings":[{"severity":"major","file":"src/a.ts","line":12,"title":"one line","detail":"why it is wrong, with evidence","fix":"what to change"}],"checked":["short list of risks you checked and found fine"]}',
	"```",
	'Use "findings": [] when the change is correct. Paths are relative to the repository root.',
].join("\n");

export interface ReviewInput {
	round: number;
	scope: ReviewScope;
	request: string;
	agentSummary?: string;
	stats: DiffStats;
	patch: string;
	/** Findings from the previous round, for a re-review of the fix. */
	previous?: Finding[];
	/** Repository folders (relative to the review's working folder) when the change spans several. */
	repos?: string[];
}

export function truncatePatch(patch: string, limit = MAX_PATCH_CHARS): { patch: string; truncated: boolean } {
	if (patch.length <= limit) return { patch, truncated: false };
	return { patch: `${patch.slice(0, limit)}\n… [diff truncated at ${limit} characters]`, truncated: true };
}

function clip(text: string, limit: number): string {
	const trimmed = text.trim();
	return trimmed.length > limit ? `${trimmed.slice(0, limit)} …` : trimmed;
}

export function reviewerUserText(input: ReviewInput): string {
	const { patch, truncated } = truncatePatch(input.patch);
	const files = input.stats.files
		.map((file) => `- ${file.path} ${file.binary ? "(binary)" : `(+${file.added} −${file.deleted})`}`)
		.join("\n");
	const what =
		input.round > 1
			? "RE-REVIEW. The agent changed the code to address the findings below. Review only whether this fix diff resolves them and whether it introduces new problems."
			: input.scope === "uncommitted"
				? "Review all uncommitted changes in the repository."
				: input.scope === "session"
					? "Review every change the agent made in this session."
					: "Review the change the agent made for this request.";
	const parts = [
		what,
		"",
		"## Request",
		clip(input.request || "(no request text available)", 4000),
	];
	if (input.previous && input.previous.length > 0) {
		parts.push("", "## Findings being fixed", formatFindingsForPrompt(input.previous));
	}
	if (input.agentSummary) parts.push("", "## The agent's own summary (may be wrong)", clip(input.agentSummary, 3000));
	if (input.repos && input.repos.length > 1) {
		parts.push(
			"",
			`## Repositories`,
			`The change spans ${input.repos.length} separate git repositories: ${input.repos.join(", ")}. Every path below starts with its repository folder and is relative to your working folder, which contains all of them. Check whether a change in one repository breaks code that depends on it in another.`,
		);
	}
	parts.push("", `## Changed files (${input.stats.files.length}, ${input.stats.lines} lines)`, files || "(none)");
	parts.push("", "## Diff", "```diff", patch, "```");
	if (truncated) parts.push("", "The diff was truncated. Read the remaining files with the read tool.");
	return parts.join("\n");
}

function location(finding: Finding): string {
	if (!finding.file) return "";
	return finding.line ? `${finding.file}:${finding.line}` : finding.file;
}

function formatFindingsForPrompt(findings: Finding[]): string {
	return findings
		.map((finding, index) => {
			const where = location(finding);
			const lines = [`${index + 1}. [${finding.severity}] ${where ? `${where} — ` : ""}${finding.title}`];
			if (finding.detail) lines.push(`   Why: ${finding.detail}`);
			if (finding.fix) lines.push(`   Suggested fix: ${finding.fix}`);
			return lines.join("\n");
		})
		.join("\n");
}

// ---- parsing the reviewer's answer -----------------------------------------------------

const SEVERITIES: readonly Severity[] = ["critical", "major", "minor"];

function asFinding(value: unknown): Finding | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	const severity = typeof raw.severity === "string" ? raw.severity.toLowerCase().trim() : "";
	const title = typeof raw.title === "string" ? raw.title.trim() : "";
	if (!(SEVERITIES as readonly string[]).includes(severity) || !title) return undefined;
	const finding: Finding = { severity: severity as Severity, title };
	if (typeof raw.file === "string" && raw.file.trim()) finding.file = raw.file.trim();
	const line = typeof raw.line === "number" ? raw.line : typeof raw.line === "string" ? Number.parseInt(raw.line, 10) : Number.NaN;
	if (Number.isInteger(line) && line > 0) finding.line = line;
	if (typeof raw.detail === "string" && raw.detail.trim()) finding.detail = raw.detail.trim();
	if (typeof raw.fix === "string" && raw.fix.trim()) finding.fix = raw.fix.trim();
	return finding;
}

function candidates(text: string): string[] {
	const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((match) => match[1] ?? "");
	const list = blocks.reverse();
	const first = text.indexOf("{");
	const last = text.lastIndexOf("}");
	if (first >= 0 && last > first) list.push(text.slice(first, last + 1));
	return list;
}

/** The findings, or undefined when the reply has no usable JSON. */
export function parseReviewerReply(text: string): { findings: Finding[]; checked: string[] } | undefined {
	for (const candidate of candidates(text)) {
		try {
			const data = JSON.parse(candidate.trim()) as { findings?: unknown; checked?: unknown };
			if (!data || typeof data !== "object" || !Array.isArray(data.findings)) continue;
			const findings = data.findings.map(asFinding).filter((finding): finding is Finding => finding !== undefined);
			findings.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
			const checked = Array.isArray(data.checked) ? data.checked.filter((item): item is string => typeof item === "string") : [];
			return { findings, checked };
		} catch {
			// try the next candidate
		}
	}
	return undefined;
}

export function blockingFindings(findings: readonly Finding[]): Finding[] {
	return findings.filter((finding) => finding.severity === "critical" || finding.severity === "major");
}

/** Hidden follow-up that sends critical/major findings back to the agent. */
export function fixPrompt(findings: readonly Finding[], reviewer: string): string {
	return [
		`An independent reviewer (${reviewer}) checked your change and found these critical/major problems:`,
		"",
		formatFindingsForPrompt([...findings]),
		"",
		"Fix each one. If you are sure a finding is wrong, do not change the code for it; say in one sentence why.",
		"Leave minor findings from the review report alone unless the user asks for them.",
		"Keep the fix minimal and do not touch unrelated code. End with a short summary of what you changed.",
	].join("\n");
}

// ---- report shown in the chat ------------------------------------------------------------

export type ReportAction = "sent-to-fix" | "none-blocking" | "unresolved" | "clean" | "unparsed";

export interface ReportDetails {
	round: number;
	scope: ReviewScope;
	model: string;
	effort: ReviewEffort;
	effortReason: string;
	files: number;
	lines: number;
	/** Repository folders, when the review spanned more than one. */
	repos?: string[];
	findings: Finding[];
	checked: string[];
	action: ReportAction;
	costUsd?: number;
	durationMs?: number;
	/** The reviewer's raw answer, shown when expanded. */
	raw: string;
}

export function decideAction(round: number, findings: readonly Finding[] | undefined): ReportAction {
	if (findings === undefined) return "unparsed";
	if (findings.length === 0) return "clean";
	if (blockingFindings(findings).length === 0) return "none-blocking";
	return round < MAX_ROUNDS ? "sent-to-fix" : "unresolved";
}

export function shortModel(ref: string): string {
	const id = ref.includes("/") ? ref.slice(ref.lastIndexOf("/") + 1) : ref;
	return id.replace(/^claude-/, "");
}

export function countLine(findings: readonly Finding[]): string {
	if (findings.length === 0) return "no issues found";
	return SEVERITIES.map((severity) => {
		const count = findings.filter((finding) => finding.severity === severity).length;
		return count > 0 ? `${count} ${severity}` : undefined;
	})
		.filter((part): part is string => part !== undefined)
		.join(", ");
}

export function reportHeader(details: ReportDetails): string {
	const label = details.round > 1 ? "Re-review" : "Review";
	const result = details.action === "unparsed" ? "could not read the reviewer's verdict" : countLine(details.findings);
	return `🔍 ${label} (${shortModel(details.model)} · ${details.effort}) — ${result}`;
}

export function actionLine(action: ReportAction): string {
	switch (action) {
		case "sent-to-fix":
			return "→ critical/major sent to the agent to fix; the fix gets one re-review";
		case "none-blocking":
			return "→ minor only; nothing sent to fix";
		case "unresolved":
			return "→ still open after the re-review; not sent again — decide yourself";
		case "clean":
			return "→ nothing to fix";
		case "unparsed":
			return "→ nothing sent to fix; expand to read the reviewer's answer";
	}
}

/** Compact text: stored in the session and shown collapsed. */
export function reportText(details: ReportDetails): string {
	const lines = [reportHeader(details)];
	for (const finding of details.findings) {
		const where = location(finding);
		lines.push(`[${finding.severity}] ${where ? `${where} — ` : ""}${finding.title}`);
	}
	lines.push(actionLine(details.action));
	return lines.join("\n");
}

/** Extra lines shown when the report is expanded. */
export function reportExpanded(details: ReportDetails): string {
	const lines: string[] = [];
	lines.push(
		`Scope: ${details.scope}${details.round > 1 ? " (fix diff)" : ""} · ${details.files} files, ${details.lines} lines · effort ${details.effort} (${details.effortReason})`,
	);
	if (details.repos && details.repos.length > 1) lines.push(`Repositories (${details.repos.length}): ${details.repos.join(", ")}`);
	const meta = [
		details.durationMs !== undefined ? `${Math.round(details.durationMs / 1000)}s` : undefined,
		details.costUsd !== undefined && details.costUsd > 0 ? `$${details.costUsd.toFixed(2)}` : undefined,
	].filter((part): part is string => part !== undefined);
	if (meta.length > 0) lines.push(meta.join(" · "));
	for (const finding of details.findings) {
		const where = location(finding);
		lines.push("", `[${finding.severity}] ${where ? `${where} — ` : ""}${finding.title}`);
		if (finding.detail) lines.push(`  why: ${finding.detail}`);
		if (finding.fix) lines.push(`  fix: ${finding.fix}`);
	}
	if (details.checked.length > 0) lines.push("", `Checked and fine: ${details.checked.join("; ")}`);
	if (details.action === "unparsed") lines.push("", details.raw.trim());
	return lines.join("\n");
}
