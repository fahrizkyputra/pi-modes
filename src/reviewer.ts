/**
 * Runs the reviewer: a separate agent with a fresh context, read-only tools
 * (read, grep, find, ls) on the repository, and its own model and thinking level.
 * It never sees the main conversation, only the text it is given.
 *
 * In-process with pi-agent-core's Agent, so it uses the same provider auth as
 * the session (ctx.modelRegistry) without spawning another Pi.
 */

import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import { createReadOnlyTools } from "@earendil-works/pi-coding-agent";
import { REVIEWER_SYSTEM_PROMPT, type ReviewEffort, TOOL_HARD_CAP, TOOL_SOFT_CAP } from "./review.ts";

export interface ReviewerModelAccess {
	streamSimple: (model: Model<Api>, context: { messages: Message[] }, options?: Record<string, unknown>) => unknown;
}

export interface RunReviewerOptions {
	model: Model<Api>;
	effort: ReviewEffort;
	cwd: string;
	userText: string;
	access: ReviewerModelAccess;
	signal: AbortSignal;
	timeoutMs: number;
	/** Called with the number of tool calls so far, for a live status. */
	onProgress?: (toolCalls: number) => void;
	/** Tools override for tests. */
	tools?: AgentTool<any>[];
}

export interface ReviewerResult {
	text: string;
	ok: boolean;
	error?: string;
	toolCalls: number;
	costUsd: number;
	durationMs: number;
}

function textOf(message: AssistantMessage): string {
	return message.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("")
		.trim();
}

/** Never rejects; failures come back as ok: false. */
export async function runReviewer(options: RunReviewerOptions): Promise<ReviewerResult> {
	const started = Date.now();
	let toolCalls = 0;
	let costUsd = 0;
	let lastAssistant: AssistantMessage | undefined;

	const agent = new Agent({
		initialState: {
			systemPrompt: REVIEWER_SYSTEM_PROMPT,
			model: options.model,
			thinkingLevel: options.effort,
			tools: options.tools ?? (createReadOnlyTools(options.cwd) as AgentTool<any>[]),
		},
		streamFn: (model, context, streamOptions) =>
			options.access.streamSimple(model, context as unknown as { messages: Message[] }, streamOptions as Record<string, unknown>) as never,
		beforeToolCall: async () => {
			if (toolCalls >= TOOL_HARD_CAP) {
				return { block: true, reason: `Tool budget used up (${TOOL_HARD_CAP} calls). Answer now with the JSON verdict.` };
			}
			return undefined;
		},
		toolExecution: "parallel",
	});

	agent.subscribe((event) => {
		if (event.type === "tool_execution_start") {
			toolCalls += 1;
			options.onProgress?.(toolCalls);
			if (toolCalls === TOOL_SOFT_CAP) {
				agent.steer({
					role: "user",
					content: [{ type: "text", text: `You have used ${TOOL_SOFT_CAP} tool calls. Finish the review now and give the JSON verdict.` }],
					timestamp: Date.now(),
				} as AgentMessage);
			}
		}
		if (event.type === "message_end") {
			const message = event.message as AgentMessage & { role?: string };
			if (message.role === "assistant") {
				lastAssistant = message as AssistantMessage;
				costUsd += lastAssistant.usage?.cost?.total ?? 0;
			}
		}
	});

	const onAbort = () => agent.abort();
	options.signal.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => agent.abort(), options.timeoutMs);
	try {
		if (options.signal.aborted) throw new Error("aborted");
		await agent.prompt(options.userText);
	} catch (error) {
		return {
			text: "",
			ok: false,
			error: error instanceof Error ? error.message : String(error),
			toolCalls,
			costUsd,
			durationMs: Date.now() - started,
		};
	} finally {
		clearTimeout(timer);
		options.signal.removeEventListener("abort", onAbort);
	}

	const durationMs = Date.now() - started;
	if (!lastAssistant) return { text: "", ok: false, error: "the reviewer gave no answer", toolCalls, costUsd, durationMs };
	if (lastAssistant.stopReason === "aborted") {
		return { text: "", ok: false, error: options.signal.aborted ? "cancelled" : "timed out", toolCalls, costUsd, durationMs };
	}
	if (lastAssistant.stopReason === "error") {
		return { text: "", ok: false, error: lastAssistant.errorMessage ?? "reviewer error", toolCalls, costUsd, durationMs };
	}
	return { text: textOf(lastAssistant), ok: true, toolCalls, costUsd, durationMs };
}
