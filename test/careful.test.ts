import assert from "node:assert/strict";
import { test } from "node:test";
import { CarefulController, carefulRules, confirmMessage, confirmTitle, hasRollbackSection } from "../src/careful.ts";
import { classifyRisk } from "../src/risk.ts";

test("inactive: nothing is risky", () => {
	const controller = new CarefulController();
	assert.deepEqual(controller.check("bash", { command: "rm -rf src" }).matches, []);
	assert.equal(controller.systemRules(), undefined);
});

test("active: bash commands are classified, other tools are not", () => {
	const controller = new CarefulController({ currentBranch: () => "feat/x" });
	controller.setActive(true);
	assert.equal(controller.check("bash", { command: "rm -rf src" }).matches.length, 1);
	assert.equal(controller.check("bash", { command: "git push origin feat/x" }).matches.length, 0);
	assert.equal(controller.check("write", { path: "src/a.ts" }).matches.length, 0);
});

test("rules name the four categories and the rollback heading", () => {
	const rules = carefulRules();
	for (const word of ["remote/production", "npm publish", "migrations", "rm -rf", "### Rollback", "dry-run"]) {
		assert.ok(rules.includes(word), word);
	}
});

test("rollback follow-up only after a risky command ran, once per run", () => {
	const controller = new CarefulController();
	controller.setActive(true);
	assert.equal(controller.followUpFor("ok"), undefined);
	controller.onRiskyCommandRan("ssh prod 'systemctl restart api'");
	assert.match(controller.followUpFor("ok") ?? "", /systemctl restart api/);
	assert.equal(controller.followUpFor("ok"), undefined);
	controller.onUserPrompt();
	assert.deepEqual(controller.ran(), []);
});

test("hasRollbackSection needs the heading and an item", () => {
	assert.equal(hasRollbackSection("### Rollback\n- `npm publish`\n  → deprecate"), true);
	assert.equal(hasRollbackSection("### rollback\n* `x`"), true);
	assert.equal(hasRollbackSection("### Rollback\n(none)"), false);
	assert.equal(hasRollbackSection("Rollback: nothing"), false);
});

test("dialog text lists every reason and the full command", () => {
	const command = "npm publish && git push origin main --tags";
	const matches = classifyRisk(command, { currentBranch: () => "main" });
	assert.match(confirmTitle(matches), /run 2 release\/publish actions\?/);
	const message = confirmMessage(command, matches);
	assert.match(message, /npm publish changes the public registry/);
	assert.match(message, /pushes tags/);
	assert.ok(message.endsWith(command));
});
