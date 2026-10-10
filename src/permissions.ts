/**
 * Explicit requests inside gercep mode.
 *
 * A category is unlocked for one run only when the latest user message pairs
 * an action verb with that category ("jalankan test", "run the tests", "tolong
 * build", "cek typecheck"), or names a concrete command ("npm test"). A negated
 * phrase ("jangan test dulu", "don't run tests") never unlocks anything.
 */

import { type Category, CATEGORIES, classifyCommand } from "./classify.ts";

const CATEGORY_WORDS: Record<Category, string> = {
	test: "(?:test|tests|testing|tes|unit[\\s-]?test|e2e|pytest|vitest|jest)",
	typecheck: "(?:typecheck|type[\\s-]?check|typechecking|tsc|mypy|pyright|cek\\s+tipe)",
	lint: "(?:lint|linter|linting|eslint|ruff|biome)",
	build: "(?:build|compile|kompilasi)",
};

const VERBS = [
	// Indonesian
	"jalankan",
	"jalanin",
	"jalan",
	"lakukan",
	"lakuin",
	"coba",
	"cek",
	"check",
	"tolong",
	"bikin",
	"buat",
	"pastikan",
	"verifikasi",
	"lanjut",
	"lanjutkan",
	"tulis",
	"tulisin",
	"tambah",
	"tambahkan",
	"tambahin",
	// English
	"run",
	"execute",
	"please",
	"do",
	"perform",
	"verify",
	"kick\\s+off",
	"rerun",
	"re-run",
	"write",
	"add",
	"create",
].join("|");

const NEGATIONS = [
	"jangan",
	"gak\\s+usah",
	"ga\\s+usah",
	"nggak\\s+usah",
	"tidak\\s+usah",
	"tak\\s+usah",
	"tanpa",
	"skip",
	"lewati",
	"don't",
	"dont",
	"do\\s+not",
	"no\\s+need\\s+to",
	"without",
	"never",
	"stop",
	"nanti\\s+saja",
	"later",
].join("|");

/** Words allowed between a verb and the category, for "run the unit tests". */
const FILLER = "(?:\\s+(?:the|a|an|all|semua|lagi|dulu|ulang|aja|saja|sekarang|now|again|first|unit|full|[a-z]+[-_][a-z]+))*";

/** A request clause ends at a sentence break or a contrast ("tapi jangan build"). */
const CLAUSE_END = /[.!?\n]|\b(?:tapi|tetapi|namun|kecuali|but|except|however)\b/i;

function verbBeforeCategory(category: Category): RegExp {
	return new RegExp(`\\b(?:${VERBS})${FILLER}\\s+${CATEGORY_WORDS[category]}\\b`, "i");
}

/** "test-nya jalankan", "build dulu", "lint dulu ya" */
function categoryThenAction(category: Category): RegExp {
	return new RegExp(
		`\\b${CATEGORY_WORDS[category]}(?:-?nya)?\\s+(?:dulu|sekarang|jalankan|jalanin|lagi|please|now|first)\\b`,
		"i",
	);
}

function negationNear(text: string, index: number): boolean {
	const window = text.slice(Math.max(0, index - 40), index);
	return new RegExp(`\\b(?:${NEGATIONS})\\b[^.!?\\n]*$`, "i").test(window);
}

/**
 * Backticked or plainly written commands, also mid-sentence: `npm test`,
 * "habis ini pytest -q". Every word position is tried as a command start,
 * except `make`, which reads too much like plain English ("make a test plan").
 */
function commandCategories(text: string): Set<Category> {
	const found = new Set<Category>();
	const candidates = [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");
	for (const line of text.split(/\n|(?<=[.!?])\s+/)) {
		const words = line.trim().split(/\s+/);
		for (let start = 0; start < words.length; start++) {
			if (words[start] === "make") continue;
			candidates.push(words.slice(start).join(" "));
		}
	}
	for (const candidate of candidates) {
		for (const { category } of classifyCommand(candidate.trim())) found.add(category);
	}
	return found;
}

/** Categories named after a request verb in the same clause: "jalankan test lalu build". */
function clauseCategories(text: string, from: number): Category[] {
	const rest = text.slice(from);
	const end = rest.search(CLAUSE_END);
	const clause = end < 0 ? rest : rest.slice(0, end);
	return CATEGORIES.filter((category) => {
		const match = new RegExp(`\\b${CATEGORY_WORDS[category]}\\b`, "i").exec(clause);
		return match !== null && !negationNear(clause, match.index + 1);
	});
}

export function explicitlyRequested(message: string | undefined): Set<Category> {
	const granted = new Set<Category>();
	if (!message || message.trim().length === 0) return granted;
	const text = message.toLowerCase();

	for (const category of CATEGORIES) {
		for (const pattern of [verbBeforeCategory(category), categoryThenAction(category)]) {
			const match = pattern.exec(text);
			if (match && !negationNear(text, match.index + 1)) {
				granted.add(category);
				for (const sibling of clauseCategories(text, match.index)) granted.add(sibling);
				break;
			}
		}
	}

	for (const category of commandCategories(text)) {
		const index = text.search(new RegExp(CATEGORY_WORDS[category], "i"));
		if (index < 0 || !negationNear(text, index + 1)) granted.add(category);
	}

	return granted;
}
