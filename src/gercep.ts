/**
 * Gercep mode: ship the change, skip every form of automated verification,
 * and hand the user a manual QA checklist instead.
 */

import type { Category } from "./classify.ts";

export const MODE_ID = "gercep";
/** Heading the agent must use; the package looks for it, so it is never translated. */
export const QA_HEADING = "QA checklist";
export const STATUS_TEXT = "⚡ gercep";
/** Inherited by child pi processes (subagents) so they start in gercep too. */
export const ENV_FLAG = "PI_MODES_ACTIVE";

const CATEGORY_LABEL: Record<Category, string> = {
	test: "test runners",
	typecheck: "typecheck",
	lint: "lint",
	build: "build",
};

export function categoryLabel(category: Category): string {
	return CATEGORY_LABEL[category];
}

/** Rules appended to the system prompt while gercep is on. */
export function gercepRules(unlocked: ReadonlySet<Category>): string {
	const allowed = [...unlocked].map(categoryLabel);
	return [
		"GERCEP MODE IS ACTIVE (the user's choice for this session: fast delivery, no automated verification).",
		"",
		"While this mode is active:",
		"- Do NOT run tests, test runners, typecheck, lint, or build commands.",
		"- Do NOT create or modify test files (*.test.*, *.spec.*, *_test.*, tests/, __tests__/).",
		"- Do NOT verify your own work by running the app, curl, a browser, or screenshots. The user verifies manually.",
		"- These rules override skills and instructions that require tests or verification (test-driven-development,",
		"  verification-before-completion, and similar). Other skills still apply.",
		"- Tool calls that break these rules are blocked by the pi-modes extension; do not retry them in another form.",
		"",
		`- After any response in which you changed files, end with a section headed exactly "### ${QA_HEADING}"`,
		"  (keep that heading in English; write everything else in the language of the conversation):",
		"  - one `- [ ]` item per scenario: what to do, where (URL, command, page, or file), and on the next line",
		"    `→ expected result` that the user should see;",
		"  - cover the happy path, the edge cases your change touches, and anything that could regress;",
		"  - finish with a short line starting with `Belum diverifikasi:` (Indonesian) or `Not verified:` (English)",
		"    listing what was not checked automatically (tests, typecheck, lint, build, files without coverage).",
		"- A response that changed nothing needs no checklist.",
		...(allowed.length > 0
			? [
					"",
					`The user explicitly asked for these in their latest message, so they are allowed for this response only: ${allowed.join(", ")}.`,
				]
			: []),
	].join("\n");
}

/** True when the text already contains the checklist heading with at least one item. */
export function hasQaChecklist(text: string): boolean {
	const index = text.toLowerCase().indexOf(QA_HEADING.toLowerCase());
	if (index < 0) return false;
	return /-\s*\[\s?\]/.test(text.slice(index));
}

export function followUpPrompt(changedFiles: readonly string[]): string {
	const files = changedFiles.slice(0, 20).map((file) => `- ${file}`);
	const more = changedFiles.length > 20 ? [`- … and ${changedFiles.length - 20} more`] : [];
	return [
		`[gercep] You changed files in this response but did not end with "### ${QA_HEADING}".`,
		"Write only that checklist now, in the language of the conversation, covering these changes:",
		...files,
		...more,
		"Do not change files or run commands.",
	].join("\n");
}

export function blockReason(category: Category, detail: string): string {
	return [
		`Blocked by gercep mode: ${categoryLabel(category)} are skipped in this session (${detail}).`,
		"Continue without running it, and cover it in the QA checklist instead.",
		"The user can allow it by asking explicitly (e.g. \"jalankan test\" / \"run the tests\") or with /gercep off.",
	].join("\n");
}

export function testFileBlockReason(path: string): string {
	return [
		`Blocked by gercep mode: writing test files is skipped in this session (${path}).`,
		"Continue without tests, and describe what to check in the QA checklist instead.",
		"The user can allow it by asking explicitly (e.g. \"tulis test\" / \"write the tests\") or with /gercep off.",
	].join("\n");
}
