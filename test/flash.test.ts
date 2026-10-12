import assert from "node:assert/strict";
import { test } from "node:test";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { detectColorMode, flashAnsi, flashPhase, paintLine } from "../src/flash.ts";
import { GercepEditor } from "../src/gercep-editor.ts";

test("the phase alternates every 250 ms", () => {
	assert.deepEqual([0, 249, 250, 499, 500, 750].map((now) => flashPhase(now)), [0, 0, 1, 1, 0, 1]);
});

test("bright yellow and orange, in truecolor and 256-color", () => {
	assert.equal(flashAnsi(0, "truecolor"), "\x1b[38;2;255;230;0m");
	assert.equal(flashAnsi(1, "truecolor"), "\x1b[38;2;255;140;0m");
	assert.equal(flashAnsi(0, "256color"), "\x1b[38;5;226m");
	assert.equal(flashAnsi(1, "256color"), "\x1b[38;5;208m");
});

test("color mode detection", () => {
	assert.equal(detectColorMode({ COLORTERM: "truecolor" }), "truecolor");
	assert.equal(detectColorMode({ TERM_PROGRAM: "iTerm.app" }), "truecolor");
	assert.equal(detectColorMode({}), "256color");
});

test("paintLine recolors without changing the visible width", () => {
	const styled = "\x1b[38;5;240m── \x1b[38;5;45m⠋\x1b[39m Working ⚡ gercep\x1b[38;5;240m ────\x1b[39m";
	const painted = paintLine(styled, 1, "truecolor");
	assert.ok(painted.startsWith("\x1b[38;2;255;140;0m"));
	assert.equal(visibleWidth(painted), visibleWidth(styled));
	assert.doesNotMatch(painted, /38;5;240/, "the old border color is gone");
});

function makeEditor() {
	const renders: number[] = [];
	const tui = { requestRender: () => renders.push(Date.now()), terminal: { rows: 40, columns: 80 } } as never;
	const theme = {
		borderColor: (text: string) => `\x1b[90m${text}\x1b[39m`,
		selectList: {
			selectedPrefix: (t: string) => t,
			selectedText: (t: string) => t,
			description: (t: string) => t,
			scrollInfo: (t: string) => t,
			noMatch: (t: string) => t,
		},
	} as never;
	const editor = new GercepEditor(tui, theme, new KeybindingsManager(TUI_KEYBINDINGS) as never, "truecolor");
	return { editor, renders };
}

const indicator = {
	renderInBorder: () => "⠋ Working ⚡ gercep",
	renderSpinnerInBorder: () => "⠋",
} as never;

test("the editor border flashes only while the Working indicator is embedded", async (t) => {
	const { editor } = makeEditor();
	t.after(() => editor.dispose());
	const top = () => editor.render(60)[0] ?? "";

	const idle = top();
	assert.doesNotMatch(idle, /38;2;255/, "idle border keeps its theme color");

	editor.setWorkingStatusIndicator(indicator);
	const phases = new Set<string>();
	const deadline = Date.now() + 700;
	while (Date.now() < deadline) {
		const line = top();
		const match = /38;2;255;(230|140);0m/.exec(line);
		if (match) phases.add(match[1] ?? "");
		assert.match(line, /Working ⚡ gercep/);
		assert.equal(visibleWidth(line), visibleWidth(idle), "same width as the normal border");
		await new Promise((resolve) => setTimeout(resolve, 40));
	}
	assert.deepEqual([...phases].sort(), ["140", "230"], "both colors appear within 700 ms");

	editor.setWorkingStatusIndicator(undefined);
	assert.doesNotMatch(top(), /38;2;255/, "back to the theme color when the agent stops");
});

test("the flash timer requests renders while working and stops afterwards", async () => {
	const { editor, renders } = makeEditor();
	editor.setWorkingStatusIndicator(indicator);
	await new Promise((resolve) => setTimeout(resolve, 600));
	const whileWorking = renders.length;
	assert.ok(whileWorking >= 2, `expected ≥ 2 render requests in 600 ms, saw ${whileWorking}`);
	editor.setWorkingStatusIndicator(undefined);
	const afterStop = renders.length;
	await new Promise((resolve) => setTimeout(resolve, 600));
	assert.equal(renders.length, afterStop, "no more renders once the indicator is gone");
	editor.dispose();
});
