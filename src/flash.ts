/**
 * The gercep border flash: while the agent works, the editor's top border
 * (the "── ⠋ Working ⚡ gercep ───" line) alternates between two bright colors.
 *
 * Pure helpers only; the editor that uses them lives in gercep-editor.ts.
 */

export const FLASH_INTERVAL_MS = 250;

/** Bright yellow and bright orange, with 256-color fallbacks. */
export const FLASH_COLORS = [
	{ rgb: [255, 230, 0] as const, ansi256: 226 },
	{ rgb: [255, 140, 0] as const, ansi256: 208 },
] as const;

export type ColorMode = "truecolor" | "256color";

/** Which of the two colors is showing at `now`. */
export function flashPhase(now: number, intervalMs: number = FLASH_INTERVAL_MS): 0 | 1 {
	return Math.floor(now / intervalMs) % 2 === 0 ? 0 : 1;
}

/** ANSI escape that sets the foreground for one phase. */
export function flashAnsi(phase: 0 | 1, mode: ColorMode): string {
	const color = FLASH_COLORS[phase];
	if (mode === "truecolor") return `\x1b[38;2;${color.rgb[0]};${color.rgb[1]};${color.rgb[2]}m`;
	return `\x1b[38;5;${color.ansi256}m`;
}

/** The terminal's color support, judged like most CLIs do. */
export function detectColorMode(env: NodeJS.ProcessEnv = process.env): ColorMode {
	const colorterm = (env.COLORTERM ?? "").toLowerCase();
	if (colorterm === "truecolor" || colorterm === "24bit") return "truecolor";
	const program = env.TERM_PROGRAM ?? "";
	if (["iTerm.app", "WezTerm", "vscode", "ghostty", "Hyper", "WarpTerminal"].includes(program)) return "truecolor";
	return "256color";
}

const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * Recolor an already-styled border line: drop its color codes and paint the
 * whole visible line in the flash color. Width is unchanged, because only
 * zero-width escape sequences are touched.
 */
export function paintLine(line: string, phase: 0 | 1, mode: ColorMode): string {
	const plain = line.replace(ANSI, "");
	return `${flashAnsi(phase, mode)}${plain}\x1b[39m`;
}
