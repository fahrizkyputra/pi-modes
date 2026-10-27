/**
 * `jcode-modes <install|uninstall|status|on|off|approve>`
 *
 * - `on <gercep|hati-hati>` / `off <mode>`: run by the /gercep and /hati-hati
 *   skills through bash, so `JCODE_SESSION_ID` names the session. `on` prints
 *   the mode's rules, which then stay in the conversation.
 * - `approve <code>`: typed by the user as a `!` line to let one held
 *   hati-hati command run once.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { carefulRules } from "../src/careful.ts";
import { gercepRules } from "../src/gercep.ts";
import {
	configPath,
	editConfig,
	installShim,
	linkSkill,
	readHookCommands,
	removeShim,
	shimCommand,
	unlinkSkill,
	withHookCommand,
	writeHookScript,
} from "./kit.ts";
import { SHIM } from "./gate.ts";
import { approveCode, loadState, MODES, setMode, stateDir, type JcodeMode } from "./state.ts";

export const PACKAGE = "pi-modes";
const HOOK_KEY = "pre_tool";
const MARKER = `/plugins/${PACKAGE}/`;

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = dirname(here);

/** Pi wording → jcode wording in the shared rules text. */
function forJcode(rules: string): string {
	return rules
		.replace("blocked by the pi-modes extension", "blocked by the pi-modes jcode gate")
		.replace(
			"the pi-modes extension will\n  then ask the user to confirm it.",
			"the pi-modes jcode gate will\n  then hold it and give you an approve line for the user.",
		);
}

export function modeRules(mode: JcodeMode): string {
	if (mode === "gercep") {
		return [
			forJcode(gercepRules(new Set())),
			"",
			"In jcode, the user's latest message is checked on every blocked call: if it explicitly asks for tests, typecheck,",
			"lint, or build (\"jalankan test\", \"run the build\"), those run for that request only.",
		].join("\n");
	}
	return forJcode(carefulRules());
}

export function skillText(mode: JcodeMode, shim: string): string {
	const label = mode === "gercep" ? "gercep (fast, no automated verification)" : "hati-hati (careful: confirm every risky command)";
	const description =
		mode === "gercep"
			? 'Turn gercep mode on or off for this jcode session: no tests, typecheck, lint, or build, and every response that changes files ends with a manual QA checklist. Use when the user types /gercep, /gercep off, or asks for "mode gercep", "tanpa test dulu", or fast delivery without verification.'
			: 'Turn hati-hati mode on or off for this jcode session: every risky command (deploy, push to main, publish, migrations, SQL writes, remote writes, destructive local commands) is held until the user approves it. Use when the user types /hati-hati, /hati-hati off, or asks for "mode hati-hati", "careful mode", or confirmation before risky actions.';
	return [
		"---",
		`name: ${mode}`,
		`description: ${JSON.stringify(description)}`,
		"---",
		"",
		`# ${label}`,
		"",
		"Act on the text after the command, then stop:",
		"",
		`- empty or \`on\`: run \`${shim} on ${mode}\` with bash. It prints the mode's rules; follow them for the rest of this session.`,
		`- \`off\`: run \`${shim} off ${mode}\` with bash and report that ${mode} is off.`,
		`- \`status\`: run \`${shim} status\` with bash and report the active modes.`,
		"",
		"Reply in one line with the new state. Do not start other work in the same response unless the user asked for it.",
		"",
	].join("\n");
}

function hookGuard(): string {
	return `[ -s "${stateDir()}/$JCODE_HOOK_SESSION_ID.json" ] || exit 0`;
}

function install(): string[] {
	const hook = writeHookScript(join(pluginRoot, "hooks", "gate.sh"), join(here, "gate.ts"), hookGuard());
	editConfig(PACKAGE, (toml) => withHookCommand(toml, HOOK_KEY, MARKER, hook));
	const shim = installShim(SHIM, join(here, "cli.ts"));
	const lines = [
		`${PACKAGE} installed for jcode`,
		`- gate: [hooks] ${HOOK_KEY} in ${configPath()} (live within seconds; no cost while no mode is on)`,
	];
	for (const mode of MODES) {
		const dir = join(pluginRoot, "skills", mode);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), skillText(mode, shim));
		const linked = linkSkill(dir, mode);
		lines.push(
			linked === "linked"
				? `- skill: /${mode}`
				: `- skill: /${mode} NOT linked: ~/.jcode/skills/${mode} already exists (remove it and run install again)`,
		);
	}
	lines.push(`- command: ${shim} status | on|off <mode> | approve <code> | uninstall`, "Reload skills in jcode (skill_manage reload_all) or start a new session.");
	return lines;
}

function uninstall(): string[] {
	editConfig(PACKAGE, (toml) => withHookCommand(toml, HOOK_KEY, MARKER, undefined));
	for (const mode of MODES) unlinkSkill(join(pluginRoot, "skills", mode), mode);
	removeShim(SHIM);
	rmSync(stateDir(), { recursive: true, force: true });
	rmSync(pluginRoot, { recursive: true, force: true });
	return [`${PACKAGE} removed from jcode (gate, /gercep, /hati-hati, command, session state).`];
}

function sessionOrFail(): string {
	const id = process.env.JCODE_SESSION_ID?.trim();
	if (!id) throw new Error("no JCODE_SESSION_ID: run this from a jcode session (the /gercep and /hati-hati skills do it)");
	return id;
}

function parseMode(value: string | undefined): JcodeMode {
	const mode = (value ?? "").toLowerCase().replace(/^careful$/, "hati-hati") as JcodeMode;
	if (!MODES.includes(mode)) throw new Error(`unknown mode "${value ?? ""}"; use ${MODES.join(" or ")}`);
	return mode;
}

function status(): string[] {
	const toml = existsSync(configPath()) ? readFileSync(configPath(), "utf8") : "";
	const gate = readHookCommands(toml, HOOK_KEY).some((command) => command.includes(MARKER));
	const id = process.env.JCODE_SESSION_ID?.trim();
	const modes = id ? loadState(id).modes : [];
	return [
		PACKAGE,
		`gate (${HOOK_KEY}): ${gate ? "installed" : "missing — run install"}`,
		id ? `this session: ${modes.length > 0 ? modes.join(" + ") : "default (no mode)"}` : "this session: unknown (not run from a jcode session)",
		`command: ${shimCommand(SHIM)}`,
	];
}

export async function run(args: readonly string[]): Promise<{ code: number; lines: string[] }> {
	const command = (args[0] ?? "status").toLowerCase();
	switch (command) {
		case "install":
			return { code: 0, lines: install() };
		case "uninstall":
			return { code: 0, lines: uninstall() };
		case "status":
			return { code: 0, lines: status() };
		case "on":
		case "off": {
			const mode = parseMode(args[1]);
			const state = setMode(sessionOrFail(), mode, command === "on");
			const active = state.modes.length > 0 ? state.modes.join(" + ") : "default (no mode)";
			if (command === "off") return { code: 0, lines: [`${mode} off. Active: ${active}.`] };
			return { code: 0, lines: [`${mode} on. Active: ${active}.`, "", modeRules(mode)] };
		}
		case "approve": {
			const code = args[1];
			if (!code) return { code: 2, lines: ["usage: approve <code>"] };
			const item = approveCode(code, process.env.JCODE_SESSION_ID?.trim() || undefined);
			if (!item) return { code: 1, lines: [`no held command with code ${code} (expired after 15 minutes, or already approved)`] };
			return {
				code: 0,
				lines: [`approved once: ${item.command.length > 300 ? `${item.command.slice(0, 300)}…` : item.command}`, "Tell the agent to continue; it runs the same command again."],
			};
		}
		default:
			return { code: 2, lines: [`unknown command "${command}". Use install, uninstall, status, on|off <mode>, approve <code>.`] };
	}
}

if (import.meta.main) {
	try {
		const { code, lines } = await run(process.argv.slice(2));
		(code === 0 ? console.log : console.error)(lines.join("\n"));
		process.exitCode = code;
	} catch (error) {
		console.error(`${PACKAGE}: ${(error as Error).message}`);
		process.exitCode = 1;
	}
}
