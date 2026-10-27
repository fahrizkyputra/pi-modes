/**
 * Per-session mode state for jcode: `~/.jcode/pi-modes/<session>.json`.
 *
 * The mode skills turn a mode on by running `jcode-modes on <mode>` through
 * bash, which jcode runs with `JCODE_SESSION_ID`; the `pre_tool` gate gets the
 * same id as `JCODE_HOOK_SESSION_ID`. So each session has its own modes, and
 * a fresh session starts in default.
 *
 * Hati-hati approvals live here too: a blocked command gets a short code, and
 * only a `!` shell line typed by the user (which never passes through the
 * gate) can turn that code into a one-time pass for the exact command.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { jcodeHome } from "./kit.ts";

export type JcodeMode = "gercep" | "hati-hati";
export const MODES: readonly JcodeMode[] = ["gercep", "hati-hati"];

/** How long an issued code, and then an approval, stays usable. */
export const PENDING_TTL_MS = 15 * 60 * 1000;
export const APPROVAL_TTL_MS = 10 * 60 * 1000;

export interface Pending {
	code: string;
	hash: string;
	command: string;
	reasons: string[];
	at: number;
}

export interface Approval {
	hash: string;
	at: number;
}

export interface SessionState {
	modes: JcodeMode[];
	pending: Pending[];
	approved: Approval[];
}

const EMPTY: SessionState = { modes: [], pending: [], approved: [] };

export const stateDir = (): string => join(jcodeHome(), "pi-modes");

function safeId(sessionId: string): string {
	return sessionId.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 200) || "unknown";
}

export function statePath(sessionId: string): string {
	return join(stateDir(), `${safeId(sessionId)}.json`);
}

export function commandHash(command: string): string {
	return createHash("sha256").update(command.trim()).digest("hex").slice(0, 32);
}

export function loadState(sessionId: string, now = Date.now()): SessionState {
	const path = statePath(sessionId);
	if (!existsSync(path)) return structuredClone(EMPTY);
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<SessionState>;
		return {
			modes: (raw.modes ?? []).filter((mode): mode is JcodeMode => MODES.includes(mode as JcodeMode)),
			pending: (raw.pending ?? []).filter((item) => now - item.at < PENDING_TTL_MS),
			approved: (raw.approved ?? []).filter((item) => now - item.at < APPROVAL_TTL_MS),
		};
	} catch {
		return structuredClone(EMPTY);
	}
}

export function saveState(sessionId: string, state: SessionState): void {
	const path = statePath(sessionId);
	if (state.modes.length === 0 && state.pending.length === 0 && state.approved.length === 0) {
		rmSync(path, { force: true });
		return;
	}
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
	renameSync(tmp, path);
}

export function setMode(sessionId: string, mode: JcodeMode, on: boolean): SessionState {
	const state = loadState(sessionId);
	const modes = new Set(state.modes);
	if (on) modes.add(mode);
	else modes.delete(mode);
	state.modes = MODES.filter((m) => modes.has(m));
	if (!state.modes.includes("hati-hati")) {
		state.pending = [];
		state.approved = [];
	}
	saveState(sessionId, state);
	return state;
}

/** Record a blocked risky command and return its code (the same code for a repeat). */
export function issueCode(sessionId: string, command: string, reasons: string[], now = Date.now()): string {
	const state = loadState(sessionId, now);
	const hash = commandHash(command);
	const existing = state.pending.find((item) => item.hash === hash);
	if (existing) return existing.code;
	const code = randomBytes(3).toString("hex");
	state.pending.push({ code, hash, command: command.trim(), reasons, at: now });
	saveState(sessionId, state);
	return code;
}

/** Consume a one-time approval for exactly this command. */
export function takeApproval(sessionId: string, command: string, now = Date.now()): boolean {
	const state = loadState(sessionId, now);
	const hash = commandHash(command);
	const index = state.approved.findIndex((item) => item.hash === hash);
	if (index < 0) return false;
	state.approved.splice(index, 1);
	saveState(sessionId, state);
	return true;
}

/**
 * The user approved `code`. Without a session id (a `!` line may not carry
 * one), the code is looked up across recent session files; codes are random,
 * so a match is unambiguous.
 */
export function approveCode(code: string, sessionId: string | undefined, now = Date.now()): Pending | undefined {
	const wanted = code.trim().toLowerCase();
	const candidates = sessionId ? [sessionId] : recentSessionIds(now);
	for (const id of candidates) {
		const state = loadState(id, now);
		const index = state.pending.findIndex((item) => item.code === wanted);
		if (index < 0) continue;
		const [item] = state.pending.splice(index, 1);
		if (!item) continue;
		state.approved.push({ hash: item.hash, at: now });
		saveState(id, state);
		return item;
	}
	return undefined;
}

function recentSessionIds(now: number): string[] {
	const dir = stateDir();
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((file) => file.endsWith(".json"))
		.filter((file) => now - statSync(join(dir, file)).mtimeMs < PENDING_TTL_MS)
		.map((file) => file.slice(0, -".json".length));
}
