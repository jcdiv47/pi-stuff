import {
	formatFinalStatus,
	formatStreamingStatus,
	formatWaitingStatus,
	TurnMetrics,
	type AssistantMessageLike,
	type StreamContentKind,
} from "./metrics.ts";

const STATUS_KEY = "turn-performance";
const REFRESH_MS = 250;

interface ExtensionContextLike {
	ui: {
		setStatus(key: string, text: string | undefined): void;
		theme: { fg(color: string, text: string): string };
	};
}

interface ExtensionApiLike {
	on(event: string, handler: (event: any, ctx: ExtensionContextLike) => void | Promise<void>): void;
}

function now(): number {
	return performance.now();
}

function assistantMessage(value: unknown): AssistantMessageLike | undefined {
	if (!value || typeof value !== "object") return undefined;
	const message = value as AssistantMessageLike;
	return message.role === "assistant" ? message : undefined;
}

function streamDelta(event: unknown): { kind: StreamContentKind; delta: string } | undefined {
	if (!event || typeof event !== "object") return undefined;
	const update = event as { type?: unknown; delta?: unknown };
	if (typeof update.delta !== "string" || update.delta.length === 0) return undefined;
	switch (update.type) {
		case "text_delta":
			return { kind: "text", delta: update.delta };
		case "thinking_delta":
			return { kind: "thinking", delta: update.delta };
		case "toolcall_delta":
			return { kind: "tool", delta: update.delta };
		default:
			return undefined;
	}
}

function completionKind(event: unknown): StreamContentKind | undefined {
	if (!event || typeof event !== "object") return undefined;
	switch ((event as { type?: unknown }).type) {
		case "text_end":
			return "text";
		case "thinking_end":
			return "thinking";
		case "toolcall_end":
			return "tool";
		default:
			return undefined;
	}
}

export default function turnPerformanceExtension(pi: ExtensionApiLike): void {
	let active: TurnMetrics | undefined;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let lastRenderedAt = 0;

	function paint(ctx: ExtensionContextLike, text: string): void {
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", text));
	}

	function stopRefresh(): void {
		if (refreshTimer !== undefined) clearInterval(refreshTimer);
		refreshTimer = undefined;
	}

	function startRefresh(ctx: ExtensionContextLike): void {
		stopRefresh();
		refreshTimer = setInterval(() => {
			if (!active) return;
			const at = now();
			const snapshot = active.snapshot();
			paint(
				ctx,
				snapshot.firstActivityAt === undefined
					? formatWaitingStatus(at - snapshot.requestStartedAt)
					: formatStreamingStatus(snapshot, at),
			);
			lastRenderedAt = at;
		}, REFRESH_MS);
		refreshTimer.unref?.();
	}

	function finish(message: unknown, ctx: ExtensionContextLike): void {
		const assistant = assistantMessage(message);
		if (!active || !assistant) return;
		stopRefresh();
		paint(ctx, formatFinalStatus(active.finish(assistant, now())));
		active = undefined;
	}

	pi.on("session_start", (_event, ctx) => {
		stopRefresh();
		active = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("turn_start", (event, ctx) => {
		const startedAt = now();
		active = new TurnMetrics(typeof event.turnIndex === "number" ? event.turnIndex : 0, startedAt);
		lastRenderedAt = startedAt;
		paint(ctx, formatWaitingStatus(0));
		startRefresh(ctx);
	});

	pi.on("message_update", (event, ctx) => {
		if (!active || !assistantMessage(event.message)) return;
		const at = now();
		const delta = streamDelta(event.assistantMessageEvent);
		if (delta) active.recordActivity(delta.kind, delta.delta, at);
		else {
			const kind = completionKind(event.assistantMessageEvent);
			if (kind && active.snapshot().firstActivityAt === undefined) active.recordCompletionActivity(kind, at);
		}

		// Streaming events can arrive much faster than the TUI should redraw.
		if (at - lastRenderedAt >= REFRESH_MS) {
			paint(ctx, formatStreamingStatus(active.snapshot(), at));
			lastRenderedAt = at;
		}
	});

	pi.on("message_end", (event, ctx) => finish(event.message, ctx));
	// Defensive fallback for providers/runtimes that omit assistant message_end.
	pi.on("turn_end", (event, ctx) => finish(event.message, ctx));

	pi.on("session_shutdown", (_event, ctx) => {
		stopRefresh();
		active = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
