import {
	formatFinalStatus,
	formatStreamingStatus,
	formatWaitingStatus,
	TurnMetrics,
	type AssistantMessageLike,
	type StreamContentKind,
	type TurnResult,
	type DisplayOptions,
} from "./metrics.ts";

const STATUS_KEY = "turn-performance";
const REFRESH_MS = 250;

interface ExtensionContextLike {
	hasUI: boolean;
	ui: {
		setStatus(key: string, text: string | undefined): void;
		notify(message: string, type: "info"): void;
		theme: { fg(color: string, text: string): string };
	};
}

interface ExtensionApiLike {
	on(event: string, handler: (event: any, ctx: ExtensionContextLike) => void | Promise<void>): void;
	registerFlag(name: string, options: { description: string; type: "boolean"; default: boolean }): void;
	getFlag(name: string): string | boolean | undefined;
	registerCommand(name: string, options: {
		description: string;
		handler: (args: string, ctx: ExtensionContextLike) => Promise<void>;
	}): void;
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
	const update = event as { type?: unknown; content?: unknown; toolCall?: unknown };
	switch (update.type) {
		case "text_end":
			return typeof update.content === "string" && update.content.length > 0 ? "text" : undefined;
		case "thinking_end":
			return typeof update.content === "string" && update.content.length > 0 ? "thinking" : undefined;
		case "toolcall_end":
			return update.toolCall ? "tool" : undefined;
		default:
			return undefined;
	}
}

export default function turnPerformanceExtension(pi: ExtensionApiLike): void {
	let active: TurnMetrics | undefined;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let lastRenderedAt = 0;
	let lastResult: TurnResult | undefined;
	const display: DisplayOptions = {};

	pi.registerFlag("turn-performance-compact", {
		description: "Show only TTFT and throughput in the performance status",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("turn-performance-input-rate", {
		description: "Show approximate Input/TTFT (not server prefill throughput)",
		type: "boolean",
		default: false,
	});
	pi.registerCommand("turn-performance-compact", {
		description: "Toggle compact TTFT and throughput status",
		handler: async (_args, ctx) => {
			display.compact = !display.compact;
			if (ctx.hasUI) {
				ctx.ui.notify(`Turn performance: compact mode ${display.compact ? "on" : "off"}`, "info");
			}
			if (active) paint(ctx, formatStreamingStatus(active.snapshot(), now(), display));
			else if (lastResult) paint(ctx, formatFinalStatus(lastResult, display));
		},
	});

	function paint(ctx: ExtensionContextLike, text: string): void {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", text));
	}

	function stopRefresh(): void {
		if (refreshTimer !== undefined) clearInterval(refreshTimer);
		refreshTimer = undefined;
	}

	function startRefresh(ctx: ExtensionContextLike): void {
		stopRefresh();
		if (!ctx.hasUI) return;
		refreshTimer = setInterval(() => {
			if (!active) return;
			const at = now();
			const snapshot = active.snapshot();
			paint(
				ctx,
				snapshot.firstActivityAt === undefined
					? formatWaitingStatus(at - snapshot.requestStartedAt)
					: formatStreamingStatus(snapshot, at, display),
			);
			lastRenderedAt = at;
		}, REFRESH_MS);
		refreshTimer.unref?.();
	}

	function finish(message: unknown, ctx: ExtensionContextLike): void {
		const assistant = assistantMessage(message);
		if (!active || !assistant) return;
		stopRefresh();
		lastResult = active.finish(assistant, now());
		paint(ctx, formatFinalStatus(lastResult, display));
		active = undefined;
	}

	function reset(ctx: ExtensionContextLike): void {
		stopRefresh();
		active = undefined;
		lastResult = undefined;
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	}

	pi.on("session_start", (_event, ctx) => {
		reset(ctx);
		display.compact = pi.getFlag("turn-performance-compact") === true;
		display.showInputRate = pi.getFlag("turn-performance-input-rate") === true;
	});
	pi.on("session_tree", (_event, ctx) => reset(ctx));
	pi.on("model_select", (_event, ctx) => {
		// An in-flight result still belongs to the old model; don't lose timing.
		if (!active) reset(ctx);
	});

	pi.on("turn_start", (event, ctx) => {
		const startedAt = now();
		lastResult = undefined;
		active = new TurnMetrics(typeof event.turnIndex === "number" ? event.turnIndex : 0, startedAt);
		lastRenderedAt = startedAt;
		paint(ctx, formatWaitingStatus(0));
		startRefresh(ctx);
	});

	pi.on("before_provider_request", () => {
		// Observe only: returning anything would replace the provider payload.
		active?.recordRequestStart(now());
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
			paint(ctx, formatStreamingStatus(active.snapshot(), at, display));
			lastRenderedAt = at;
		}
	});

	pi.on("message_end", (event, ctx) => finish(event.message, ctx));
	// Defensive fallback for providers/runtimes that omit assistant message_end.
	pi.on("turn_end", (event, ctx) => {
		finish(event.message, ctx);
		if (active) reset(ctx);
	});
	pi.on("agent_end", (_event, ctx) => {
		// Abort/failure before message_end must not leave a ticking waiting label.
		if (active) reset(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => reset(ctx));
}
