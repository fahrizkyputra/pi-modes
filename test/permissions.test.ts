import assert from "node:assert/strict";
import { test } from "node:test";
import { explicitlyRequested } from "../src/permissions.ts";

function granted(message: string): string[] {
	return [...explicitlyRequested(message)].sort();
}

test("Indonesian requests unlock the named category only", () => {
	assert.deepEqual(granted("jalankan test dulu"), ["test"]);
	assert.deepEqual(granted("tolong build sekarang"), ["build"]);
	assert.deepEqual(granted("cek typecheck ya"), ["typecheck"]);
	assert.deepEqual(granted("lint dulu sebelum commit"), ["lint"]);
	assert.deepEqual(granted("test-nya jalankan"), ["test"]);
	assert.deepEqual(granted("tulis test untuk fungsi ini"), ["test"]);
	assert.deepEqual(granted("jalankan test lalu build"), ["build", "test"]);
});

test("English requests", () => {
	assert.deepEqual(granted("run the tests"), ["test"]);
	assert.deepEqual(granted("please run all unit tests"), ["test"]);
	assert.deepEqual(granted("run a type-check"), ["typecheck"]);
	assert.deepEqual(granted("run typecheck and lint"), ["lint", "typecheck"]);
	assert.deepEqual(granted("write the tests for this module"), ["test"]);
});

test("concrete commands count as requests", () => {
	assert.deepEqual(granted("coba `npm test`"), ["test"]);
	assert.deepEqual(granted("npm run build"), ["build"]);
	assert.deepEqual(granted("habis ini pytest -q"), ["test"]);
});

test("negations never unlock", () => {
	assert.deepEqual(granted("jangan test dulu"), []);
	assert.deepEqual(granted("gak usah jalankan test"), []);
	assert.deepEqual(granted("tanpa build"), []);
	assert.deepEqual(granted("don't run tests"), []);
	assert.deepEqual(granted("do not run the build"), []);
	assert.deepEqual(granted("skip lint"), []);
	assert.deepEqual(granted("jalankan test tapi jangan build"), ["test"], "a contrast clause keeps its negation");
	assert.deepEqual(granted("run the tests but do not build"), ["test"]);
	assert.deepEqual(granted("jangan `npm test`"), []);
});

test("merely mentioning a category is not a request", () => {
	assert.deepEqual(granted("test-nya nanti saja"), []);
	assert.deepEqual(granted("build-nya sudah jalan kok"), []);
	assert.deepEqual(granted("tambah tombol logout di header"), []);
	assert.deepEqual(granted("the latest build broke the header"), []);
	assert.deepEqual(granted("make a test plan for later"), [], "`make` is not read as a command mid-sentence");
	assert.deepEqual(granted(""), []);
});
