export type StreamContentKind = "text" | "thinking" | "tool";

export interface UsageLike {
	input?: number;
	cacheRead?: number;
	cacheWrite?: number;
	output?: number;
	reasoning?: number;
}

export interface AssistantMessageLike {
	role: string;
	content?: unknown;
	usage?: UsageLike;
	stopReason?: string;
}

export interface TurnSnapshot {
	turnIndex: number;
	requestStartedAt: number;
	firstActivityAt?: number;
	firstTextAt?: number;
	lastActivityAt?: number;
	estimatedStreamTokens: number;
	estimatedTokensAfterFirstChunk: number;
	ttftIsUpperBound: boolean;
	sawThinkingActivity: boolean;
}

export interface TurnResult extends TurnSnapshot {
	messageEndedAt: number;
	ttftMs?: number;
	timeToTextMs?: number;
	outputTokens: number;
	outputTokensEstimated: boolean;
	reasoningTokens?: number;
	reasoningTokensEstimated: boolean;
	tokensPerSecond?: number;
	inputTokensPerSecond?: number;
	stopReason?: string;
	/**
	 * Hidden reasoning has no observable first-token event. In that case the
	 * only provider-neutral rate is output tokens over the whole request.
	 */
	effectiveRate: boolean;
}

interface ContentCounts {
	textChars: number;
	thinkingChars: number;
	toolChars: number;
}

const CHARS_PER_ESTIMATED_TOKEN = 4;

function finiteNonNegative(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function safeJsonLength(value: unknown): number {
	try {
		return JSON.stringify(value)?.length ?? 0;
	} catch {
		return 0;
	}
}

function countMessageContent(content: unknown): ContentCounts {
	const counts: ContentCounts = { textChars: 0, thinkingChars: 0, toolChars: 0 };
	if (!Array.isArray(content)) return counts;

	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const item = block as Record<string, unknown>;
		switch (item.type) {
			case "text":
				if (typeof item.text === "string") counts.textChars += item.text.length;
				break;
			case "thinking":
				if (typeof item.thinking === "string") counts.thinkingChars += item.thinking.length;
				break;
			case "toolCall":
				if (typeof item.name === "string") counts.toolChars += item.name.length;
				counts.toolChars += safeJsonLength(item.arguments);
				break;
		}
	}

	return counts;
}

export function estimateTokensFromChars(chars: number): number {
	return chars > 0 ? Math.ceil(chars / CHARS_PER_ESTIMATED_TOKEN) : 0;
}

export class TurnMetrics {
	readonly turnIndex: number;
	private requestStartedAtValue: number;

	private firstActivityAtValue?: number;
	private firstTextAtValue?: number;
	private lastActivityAtValue?: number;
	private streamedChars = 0;
	private firstChunkChars = 0;
	private sawThinkingActivityValue = false;
	private firstActivityIsUpperBound = false;

	constructor(turnIndex: number, requestStartedAt: number) {
		this.turnIndex = turnIndex;
		this.requestStartedAtValue = requestStartedAt;
	}

	get requestStartedAt(): number {
		return this.requestStartedAtValue;
	}

	/** Prefer the provider boundary; retain turn_start for providers without it. */
	recordRequestStart(at: number): void {
		if (this.firstActivityAtValue === undefined) this.requestStartedAtValue = at;
	}

	recordActivity(kind: StreamContentKind, delta: string, at: number): void {
		if (!delta) return;
		if (this.streamedChars === 0) this.firstChunkChars = delta.length;
		this.firstActivityAtValue ??= at;
		this.lastActivityAtValue = at;
		this.streamedChars += delta.length;
		if (kind === "text") this.firstTextAtValue ??= at;
		if (kind === "thinking") this.sawThinkingActivityValue = true;
	}

	/** Record a non-delta completion event as a last-resort TTFT upper bound. */
	recordCompletionActivity(kind: StreamContentKind, at: number): void {
		if (this.firstActivityAtValue === undefined) {
			this.firstActivityAtValue = at;
			this.firstActivityIsUpperBound = true;
		}
		this.lastActivityAtValue ??= at;
		if (kind === "text") this.firstTextAtValue ??= at;
		if (kind === "thinking") this.sawThinkingActivityValue = true;
	}

	snapshot(): TurnSnapshot {
		return {
			turnIndex: this.turnIndex,
			requestStartedAt: this.requestStartedAt,
			firstActivityAt: this.firstActivityAtValue,
			firstTextAt: this.firstTextAtValue,
			lastActivityAt: this.lastActivityAtValue,
			estimatedStreamTokens: estimateTokensFromChars(this.streamedChars),
			estimatedTokensAfterFirstChunk: (this.streamedChars - this.firstChunkChars) / CHARS_PER_ESTIMATED_TOKEN,
			ttftIsUpperBound: this.firstActivityIsUpperBound,
			sawThinkingActivity: this.sawThinkingActivityValue,
		};
	}

	finish(message: AssistantMessageLike, messageEndedAt: number): TurnResult {
		const counts = countMessageContent(message.content);
		const estimatedOutput = estimateTokensFromChars(
			Math.max(this.streamedChars, counts.textChars + counts.thinkingChars + counts.toolChars),
		);
		const estimatedReasoning = estimateTokensFromChars(counts.thinkingChars);
		const reportedOutput = finiteNonNegative(message.usage?.output);
		const reportedReasoning = finiteNonNegative(message.usage?.reasoning);

		// A number of OpenAI-compatible local servers return a zero-filled usage
		// object. Prefer observed content in that case instead of reporting 0 tok/s.
		const outputIsUsable = reportedOutput !== undefined && (reportedOutput > 0 || estimatedOutput === 0);
		const outputTokens = outputIsUsable ? reportedOutput : estimatedOutput;
		const reasoningIsUsable =
			reportedReasoning !== undefined && (reportedReasoning > 0 || estimatedReasoning === 0);
		const reasoningTokens = reasoningIsUsable
			? reportedReasoning
			: estimatedReasoning > 0
				? estimatedReasoning
				: undefined;

		let firstActivityAt = this.firstActivityAtValue;
		let firstTextAt = this.firstTextAtValue;
		let ttftIsUpperBound = this.firstActivityIsUpperBound;
		if (firstActivityAt === undefined && estimatedOutput > 0) {
			// Non-streaming providers only reveal that output existed at completion.
			firstActivityAt = messageEndedAt;
			if (counts.textChars > 0) firstTextAt = messageEndedAt;
			ttftIsUpperBound = true;
		}

		const ttftMs = firstActivityAt === undefined ? undefined : Math.max(0, firstActivityAt - this.requestStartedAt);
		const timeToTextMs = firstTextAt === undefined ? undefined : Math.max(0, firstTextAt - this.requestStartedAt);
		const hiddenReasoning = (reportedReasoning ?? 0) > 0 && !this.sawThinkingActivityValue;
		const effectiveRate = hiddenReasoning || ttftIsUpperBound || firstActivityAt === undefined;
		const rateStartedAt = !effectiveRate && firstActivityAt !== undefined ? firstActivityAt : this.requestStartedAt;
		// Usage-only trailers and stream teardown are not decode time. Hidden or
		// unobservable generation still needs the whole-request effective rate.
		const rateEndedAt = effectiveRate ? messageEndedAt : (this.lastActivityAtValue ?? messageEndedAt);
		const rateDurationMs = Math.max(0, rateEndedAt - rateStartedAt);
		// Reported usage uses the conventional N-1 token interval. A delta may
		// contain multiple tokens, so this remains client-observed, not GPU TPS.
		// With estimated usage we can instead exclude the entire first chunk.
		const rateTokens = effectiveRate
			? outputTokens
			: outputIsUsable
				? Math.max(0, outputTokens - 1)
				: this.snapshot().estimatedTokensAfterFirstChunk;
		const tokensPerSecond =
			rateTokens > 0 && rateDurationMs >= 10 ? rateTokens / (rateDurationMs / 1000) : undefined;
		const processedInput =
			(finiteNonNegative(message.usage?.input) ?? 0) + (finiteNonNegative(message.usage?.cacheWrite) ?? 0);
		const inputTokensPerSecond =
			processedInput > 0 && ttftMs !== undefined && ttftMs > 0 && !ttftIsUpperBound
				? processedInput / (ttftMs / 1000)
				: undefined;

		return {
			...this.snapshot(),
			firstActivityAt,
			firstTextAt,
			messageEndedAt,
			ttftMs,
			ttftIsUpperBound,
			timeToTextMs,
			outputTokens,
			outputTokensEstimated: !outputIsUsable,
			reasoningTokens,
			reasoningTokensEstimated: reasoningTokens !== undefined && !reasoningIsUsable,
			tokensPerSecond,
			inputTokensPerSecond,
			stopReason: message.stopReason,
			effectiveRate,
		};
	}
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 10_000) return `${(ms / 1000).toFixed(2)}s`;
	return `${(ms / 1000).toFixed(1)}s`;
}

function formatRate(rate: number): string {
	return rate < 100 ? rate.toFixed(1) : Math.round(rate).toString();
}

function formatTokens(tokens: number): string {
	if (tokens < 1000) return Math.round(tokens).toString();
	return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
}

export function formatWaitingStatus(elapsedMs: number): string {
	return `TTFT ${formatDuration(Math.max(0, elapsedMs))}\u2026`;
}

export interface DisplayOptions {
	compact?: boolean;
	showInputRate?: boolean;
}

export function formatStreamingStatus(snapshot: TurnSnapshot, now: number, options: DisplayOptions = {}): string {
	if (snapshot.firstActivityAt === undefined) return formatWaitingStatus(now - snapshot.requestStartedAt);
	const ttft = formatDuration(snapshot.firstActivityAt - snapshot.requestStartedAt);
	const parts = [`TTFT ${snapshot.ttftIsUpperBound ? "\u2264" : ""}${ttft}`];
	const durationMs = (snapshot.lastActivityAt ?? snapshot.firstActivityAt) - snapshot.firstActivityAt;
	if (!snapshot.ttftIsUpperBound && snapshot.estimatedTokensAfterFirstChunk > 0 && durationMs >= 10) {
		parts.push(`~${formatRate(snapshot.estimatedTokensAfterFirstChunk / (durationMs / 1000))} tok/s`);
	}
	if (!options.compact && snapshot.sawThinkingActivity && snapshot.firstTextAt === undefined) parts.push("thinking");
	return parts.join(" \u00b7 ");
}

export function formatFinalStatus(result: TurnResult, options: DisplayOptions = {}): string {
	const parts: string[] = [];
	if (result.ttftMs !== undefined) {
		parts.push(`TTFT ${result.ttftIsUpperBound ? "\u2264" : ""}${formatDuration(result.ttftMs)}`);
	} else {
		parts.push("TTFT \u2014");
	}

	if (
		!options.compact &&
		result.timeToTextMs !== undefined &&
		result.ttftMs !== undefined &&
		result.timeToTextMs - result.ttftMs >= 50
	) {
		parts.push(`answer ${formatDuration(result.timeToTextMs)}`);
	}

	if (!options.compact && options.showInputRate && result.inputTokensPerSecond !== undefined) {
		parts.push(`Input/TTFT ~${formatRate(result.inputTokensPerSecond)} tok/s`);
	}
	if (result.tokensPerSecond !== undefined) {
		const prefix = result.effectiveRate ? "eff ~" : result.outputTokensEstimated ? "~" : "";
		parts.push(`${prefix}${formatRate(result.tokensPerSecond)} tok/s`);
	} else {
		parts.push("tok/s \u2014");
	}
	if (result.stopReason === "aborted" || result.stopReason === "error") parts.push(result.stopReason);
	if (options.compact) return parts.join(" \u00b7 ");

	const outputPrefix = result.outputTokensEstimated ? "~" : "";
	let tokens = `${outputPrefix}${formatTokens(result.outputTokens)} tok`;
	if (result.reasoningTokens !== undefined && result.reasoningTokens > 0) {
		const reasoningPrefix = result.reasoningTokensEstimated ? "~" : "";
		tokens += ` (r ${reasoningPrefix}${formatTokens(result.reasoningTokens)})`;
	}
	parts.push(tokens);
	return parts.join(" \u00b7 ");
}
