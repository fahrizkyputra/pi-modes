import assert from "node:assert/strict";
import { test } from "node:test";
import { ModeController } from "../src/controller.ts";
import { hasQaChecklist } from "../src/gercep.ts";

function bash(command: string) {
	return { toolName: "bash", input: { command } };
}

test("default mode adds no rules and blocks nothing", () => {
	const controller = new ModeController();
	controller.onUserPrompt("ubah header");
	assert.equal(controller.getMode(), "default");
	assert.equal(controller.systemRules(), undefined);
	assert.deepEqual(controller.checkToolCall(bash("npm test")), { block: false });
	assert.deepEqual(controller.checkToolCall({ toolName: "write", input: { path: "src/a.test.ts" } }), { block: false });
	controller.onFileChanged("src/a.ts");
	assert.equal(controller.followUpFor("done"), undefined, "default mode never asks for a checklist");
});

test("gercep blocks every category and test files", () => {
	const controller = new ModeController();
	controller.setMode("gercep");
	controller.onUserPrompt("tambah tombol logout");

	for (const command of ["npm test", "npx tsc --noEmit", "npm run lint", "npm run build"]) {
		const decision = controller.checkToolCall(bash(command));
		assert.equal(decision.block, true, command);
		if (decision.block) assert.match(decision.reason, /Blocked by gercep mode/);
	}
	const write = controller.checkToolCall({ toolName: "write", input: { path: "src/logout.test.ts" } });
	assert.equal(write.block, true);
	assert.deepEqual(controller.checkToolCall(bash("npm run dev")), { block: false });
	assert.deepEqual(controller.checkToolCall({ toolName: "edit", input: { path: "src/header.tsx" } }), { block: false });
});

test("the rules mention every skipped activity and the checklist heading", () => {
	const controller = new ModeController();
	controller.setMode("gercep");
	controller.onUserPrompt("ubah header");
	const rules = controller.systemRules() ?? "";
	assert.match(rules, /Do NOT run tests, test runners, typecheck, lint, or build/);
	assert.match(rules, /Do NOT create or modify test files/);
	assert.match(rules, /Do NOT verify your own work/);
	assert.match(rules, /override skills .*test-driven-development/s);
	assert.match(rules, /### QA checklist/);
	assert.doesNotMatch(rules, /allowed for this response only/);
});

test("an explicit request unlocks only that category, for one run", () => {
	const controller = new ModeController();
	controller.setMode("gercep");
	controller.onUserPrompt("jalankan test dulu");

	assert.deepEqual(controller.checkToolCall(bash("npm test")), { block: false });
	assert.deepEqual(controller.checkToolCall({ toolName: "write", input: { path: "a.test.ts" } }), { block: false });
	assert.equal(controller.checkToolCall(bash("npm run build")).block, true, "build was not requested");
	assert.match(controller.systemRules() ?? "", /allowed for this response only: test runners/);

	controller.onUserPrompt("oke lanjut ubah warnanya");
	assert.equal(controller.checkToolCall(bash("npm test")).block, true, "the permission expires with the run");
});

test("follow-up only when files changed and the checklist is missing, once per run", () => {
	const controller = new ModeController();
	controller.setMode("gercep");
	controller.onUserPrompt("ubah header");

	assert.equal(controller.followUpFor("Sudah saya jelaskan."), undefined, "nothing changed");

	controller.onFileChanged("src/header.tsx");
	const prompt = controller.followUpFor("Sudah diubah.");
	assert.match(prompt ?? "", /did not end with "### QA checklist"/);
	assert.match(prompt ?? "", /- src\/header\.tsx/);
	assert.equal(controller.followUpFor("still no checklist"), undefined, "at most one follow-up per run");

	controller.onUserPrompt("ubah footer");
	controller.onFileChanged("src/footer.tsx");
	const withChecklist = "Done.\n\n### QA checklist\n- [ ] Buka /\n      → footer biru\n\nBelum diverifikasi: test.";
	assert.equal(controller.followUpFor(withChecklist), undefined);
});

test("hasQaChecklist needs the heading and an item", () => {
	assert.equal(hasQaChecklist("### QA checklist\n- [ ] Buka /login\n  → masuk"), true);
	assert.equal(hasQaChecklist("### qa CHECKLIST\n- [] cek"), true);
	assert.equal(hasQaChecklist("### QA checklist\n(none)"), false);
	assert.equal(hasQaChecklist("- [ ] something without heading"), false);
});

test("switching back to default clears per-run state", () => {
	const controller = new ModeController();
	controller.setMode("gercep");
	controller.onUserPrompt("jalankan test");
	controller.onFileChanged("a.ts");
	controller.setMode("default");
	assert.deepEqual(controller.changed(), []);
	assert.equal(controller.getUnlocked().size, 0);
});
