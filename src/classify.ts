/**
 * What counts as "testing" in gercep mode.
 *
 * Four categories can be blocked at tool level. Bash commands are split into
 * segments (`a && b; c | d`) and each segment is checked on its own, so
 * `cd app && npm test` is caught while `npm run dev` is not.
 */

export type Category = "test" | "typecheck" | "lint" | "build";
export const CATEGORIES: readonly Category[] = ["test", "typecheck", "lint", "build"];

const COMMAND_PATTERNS: Record<Category, RegExp[]> = {
	test: [
		/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::[\w:-]+)?\b/,
		/^(?:npm|pnpm|yarn|bun)\s+t\b/,
		/^(?:npx|bunx|pnpm\s+exec|pnpm\s+dlx|yarn\s+dlx)?\s*(?:vitest|jest|mocha|ava|tap|playwright\s+test|cypress\s+run)\b/,
		/^bun\s+test\b/,
		/^deno\s+test\b/,
		/^node\s+(?:--[\w-]+(?:=\S+)?\s+)*--test\b/,
		/^(?:python3?\s+-m\s+)?pytest\b/,
		/^python3?\s+-m\s+unittest\b/,
		/^(?:uv|poetry|pipenv)\s+run\s+(?:python3?\s+-m\s+)?pytest\b/,
		/^tox\b/,
		/^nox\b/,
		/^go\s+test\b/,
		/^cargo\s+(?:test|nextest)\b/,
		/^(?:\.\/)?gradlew?\s+(?:\S+\s+)*test\b/,
		/^mvn\s+(?:\S+\s+)*test\b/,
		/^dotnet\s+test\b/,
		/^swift\s+test\b/,
		/^xcodebuild\s+(?:\S+\s+)*test\b/,
		/^(?:bundle\s+exec\s+)?(?:rspec|rake\s+test)\b/,
		/^(?:php\s+)?(?:vendor\/bin\/)?(?:phpunit|pest)\b/,
		/^php\s+artisan\s+test\b/,
		/^mix\s+test\b/,
		/^make\s+(?:\S+\s+)*(?:test|check)\b/,
	],
	typecheck: [
		/^(?:npx|bunx|pnpm\s+exec)?\s*tsc\b/,
		/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:typecheck|type-check|tsc|check-types|types)\b/,
		/^(?:npx|bunx|pnpm\s+exec)?\s*vue-tsc\b/,
		/^(?:python3?\s+-m\s+)?(?:mypy|pyright|basedpyright)\b/,
		/^(?:uv|poetry)\s+run\s+(?:mypy|pyright)\b/,
		/^cargo\s+check\b/,
		/^go\s+vet\b/,
		/^flow\b/,
	],
	lint: [
		/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:lint|format:check|fmt:check)(?::[\w:-]+)?\b/,
		/^(?:npx|bunx|pnpm\s+exec)?\s*(?:eslint|biome\s+(?:check|lint|ci)|oxlint|stylelint|prettier\s+(?:--check|-c)|xo|standard)\b/,
		/^(?:python3?\s+-m\s+)?(?:ruff(?:\s+check)?|flake8|pylint|black\s+--check|isort\s+--check)\b/,
		/^(?:uv|poetry)\s+run\s+(?:ruff|flake8|pylint)\b/,
		/^cargo\s+(?:clippy|fmt\s+--check)\b/,
		/^golangci-lint\b/,
		/^gofmt\s+-l\b/,
		/^(?:bundle\s+exec\s+)?rubocop\b/,
		/^shellcheck\b/,
		/^swiftlint\b/,
	],
	build: [
		/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build(?::[\w:-]+)?\b/,
		/^(?:npx|bunx|pnpm\s+exec)?\s*(?:next|nuxt|vite|astro|remix|svelte-kit|ng|webpack|rollup|tsup|esbuild|parcel)\s+build\b/,
		/^cargo\s+build\b/,
		/^go\s+build\b/,
		/^(?:\.\/)?gradlew?\s+(?:\S+\s+)*(?:build|assemble)\b/,
		/^mvn\s+(?:\S+\s+)*(?:package|install|compile|verify)\b/,
		/^dotnet\s+build\b/,
		/^swift\s+build\b/,
		/^xcodebuild\b(?!.*\btest\b)/,
		/^make\s+(?:\S+\s+)*build\b/,
		/^python3?\s+-m\s+build\b/,
	],
};

/** Strip env assignments, `sudo`, `time`, and similar wrappers from a segment. */
function normalizeSegment(segment: string): string {
	let text = segment.trim();
	// Leading subshell/grouping characters.
	text = text.replace(/^[({\s]+/, "");
	for (;;) {
		const before = text;
		text = text.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, "");
		text = text.replace(/^(?:sudo|time|nice|nohup|exec|command|env)\s+/, "");
		text = text.replace(/^timeout\s+\S+\s+/, "");
		if (text === before) break;
	}
	return text;
}

/** `a && b || c; d | e` → [a, b, c, d, e]. Quotes are respected for the separators. */
export function splitCommand(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	for (let i = 0; i < command.length; i++) {
		const char = command[i] ?? "";
		if (quote) {
			current += char;
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			current += char;
			continue;
		}
		const next = command[i + 1];
		if ((char === "&" && next === "&") || (char === "|" && next === "|")) {
			segments.push(current);
			current = "";
			i++;
			continue;
		}
		if (char === ";" || char === "|" || char === "\n") {
			segments.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	segments.push(current);
	return segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0);
}

export interface CommandMatch {
	category: Category;
	segment: string;
}

/** Every blocked category the command touches, in order of appearance. */
export function classifyCommand(command: string): CommandMatch[] {
	const matches: CommandMatch[] = [];
	for (const raw of splitCommand(command)) {
		const segment = normalizeSegment(raw);
		for (const category of CATEGORIES) {
			if (COMMAND_PATTERNS[category].some((pattern) => pattern.test(segment))) {
				matches.push({ category, segment: raw });
				break;
			}
		}
	}
	return matches;
}

const TEST_FILE_PATTERNS: RegExp[] = [
	/\.(?:test|spec)\.[cm]?[jt]sx?$/i,
	/\.(?:test|spec)\.(?:vue|svelte|astro)$/i,
	/_test\.(?:go|py|rb|exs?|dart)$/i,
	/(?:^|\/)test_[^/]+\.py$/i,
	/_spec\.rb$/i,
	/Tests?\.(?:java|kt|swift|cs|php)$/,
	/(?:^|\/)(?:__tests__|tests?|spec|specs|e2e|cypress|playwright)\//i,
];

/** Paths a "write the tests" step would touch. */
export function isTestFilePath(path: string): boolean {
	const normalized = path.replace(/\\/g, "/");
	return TEST_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
}
