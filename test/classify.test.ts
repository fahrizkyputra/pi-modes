import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyCommand, isTestFilePath, splitCommand } from "../src/classify.ts";

function categories(command: string): string[] {
	return classifyCommand(command).map((match) => match.category);
}

test("test runners across ecosystems", () => {
	for (const command of [
		"npm test",
		"npm run test",
		"npm run test:unit",
		"pnpm test",
		"yarn test --watch=false",
		"bun test",
		"npx vitest run",
		"vitest",
		"jest src/foo",
		"node --test test/*.test.ts",
		"node --experimental-strip-types --test",
		"pytest -q",
		"python -m pytest tests/",
		"python3 -m unittest",
		"uv run pytest",
		"go test ./...",
		"cargo test",
		"./gradlew test",
		"mvn -q test",
		"php artisan test",
		"bundle exec rspec",
		"make test",
		"npx playwright test",
	]) {
		assert.deepEqual(categories(command), ["test"], command);
	}
});

test("typecheck, lint, and build", () => {
	assert.deepEqual(categories("npx tsc --noEmit"), ["typecheck"]);
	assert.deepEqual(categories("npm run typecheck"), ["typecheck"]);
	assert.deepEqual(categories("mypy src"), ["typecheck"]);
	assert.deepEqual(categories("cargo check"), ["typecheck"]);
	assert.deepEqual(categories("npm run lint"), ["lint"]);
	assert.deepEqual(categories("npx eslint ."), ["lint"]);
	assert.deepEqual(categories("ruff check ."), ["lint"]);
	assert.deepEqual(categories("biome check src"), ["lint"]);
	assert.deepEqual(categories("npm run build"), ["build"]);
	assert.deepEqual(categories("pnpm build"), ["build"]);
	assert.deepEqual(categories("next build"), ["build"]);
	assert.deepEqual(categories("go build ./cmd/app"), ["build"]);
	assert.deepEqual(categories("cargo build --release"), ["build"]);
});

test("compound commands are checked segment by segment", () => {
	assert.deepEqual(categories("cd app && npm test"), ["test"]);
	assert.deepEqual(categories("npm run lint; npm run build"), ["lint", "build"]);
	assert.deepEqual(categories("CI=1 npm test | tee out.log"), ["test"]);
	assert.deepEqual(categories("timeout 60 pytest"), ["test"]);
	assert.deepEqual(categories("sudo -E npm test"), [], "unknown flags after sudo are not guessed");
});

test("ordinary work is never blocked", () => {
	for (const command of [
		"npm run dev",
		"npm install",
		"pnpm add zod",
		"git status",
		"ls test",
		"cat tests/fixture.json",
		"grep -rn test src",
		"rg 'build' src",
		"echo npm test",
		"node scripts/seed.js",
		"docker build .",
		"docker compose up",
		"make",
		"python manage.py runserver",
		"curl localhost:3000",
	]) {
		assert.deepEqual(categories(command), [], command);
	}
});

test("splitCommand respects quotes", () => {
	assert.deepEqual(splitCommand(`echo "a && b"; ls`), ['echo "a && b"', "ls"]);
	assert.deepEqual(splitCommand("a || b && c | d"), ["a", "b", "c", "d"]);
});

test("test file paths", () => {
	for (const path of [
		"src/auth.test.ts",
		"src/auth.spec.tsx",
		"lib/thing.test.mjs",
		"components/Button.test.vue",
		"pkg/server_test.go",
		"app/test_views.py",
		"spec/models/user_spec.rb",
		"src/test/java/UserServiceTest.java",
		"tests/integration/api.ts",
		"src/__tests__/util.ts",
		"e2e/login.ts",
	]) {
		assert.equal(isTestFilePath(path), true, path);
	}
	for (const path of ["src/auth.ts", "src/testing-utils-notes.md", "src/contest.ts", "docs/latest.md", "src/attest.ts"]) {
		assert.equal(isTestFilePath(path), false, path);
	}
});
