/**
 * The latest message the user typed in a jcode session, read from
 * `~/.jcode/sessions/<id>.json` plus its append-only `.journal.jsonl`.
 * Gercep uses it the way the Pi extension uses the prompt: "jalankan test"
 * unlocks tests for that request only.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { jcodeHome } from "./kit.ts";

interface Block {
	type?: string;
	text?: string;
}
interface Message {
	role?: string;
	content?: unknown;
}

/** Text the user typed, or undefined for tool results and injected reminders. */
export function typedText(message: Message): string | undefined {
	if (message.role !== "user" || !Array.isArray(message.content)) return undefined;
	const blocks = message.content as Block[];
	if (blocks.some((block) => block.type === "tool_result")) return undefined;
	const text = blocks
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text ?? "")
		.join("\n")
		.trim();
	if (text.length === 0 || text.startsWith("<system-reminder>")) return undefined;
	return text;
}

export function latestUserTextFrom(snapshot: string | undefined, journal: string | undefined): string | undefined {
	const messages: Message[] = [];
	if (snapshot) {
		try {
			const parsed = JSON.parse(snapshot) as { messages?: Message[] };
			messages.push(...(parsed.messages ?? []));
		} catch {
			// unreadable snapshot: rely on the journal
		}
	}
	for (const line of (journal ?? "").split("\n")) {
		if (!line.includes("append_messages")) continue;
		try {
			const entry = JSON.parse(line) as { append_messages?: Message[] };
			messages.push(...(entry.append_messages ?? []));
		} catch {
			// a line being written right now
		}
	}
	for (let i = messages.length - 1; i >= 0; i--) {
		const text = typedText(messages[i] ?? {});
		if (text !== undefined) return text;
	}
	return undefined;
}

export function latestUserText(sessionId: string): string | undefined {
	const base = join(jcodeHome(), "sessions", sessionId.replace(/[^A-Za-z0-9_.-]/g, "_"));
	const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);
	return latestUserTextFrom(read(`${base}.json`), read(`${base}.journal.jsonl`));
}
