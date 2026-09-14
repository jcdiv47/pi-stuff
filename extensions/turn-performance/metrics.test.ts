import assert from "node:assert/strict";
import test from "node:test";

import { formatFinalStatus, formatStreamingStatus, TurnMetrics } from "./metrics.ts";

const textMessage = (text: string, usage?: { output?: number; reasoning?: number }) => ({
	role: "assistant",
	content: [{ type: "text", text }],
	usage,
});

test("uses reported output tokens for normal streamed responses", () => {
	const turn = new TurnMetrics(1, 1_000);
	turn.recordActivity("text", "hello", 1_250);
	turn.recordActivity("text", " world", 2_250);
	const result = turn.finish(textMessage("hello world", { output: 51 }), 2_500);

	assert.equal(result.ttftMs, 250);
	assert.equal(result.outputTokens, 51);
	assert.equal(result.outputTokensEstimated, false);
	assert.equal(result.effectiveRate, false);
	assert.equal(result.tokensPerSecond, 50);
	assert.match(formatFinalStatus(result), /TTFT 250ms/);
	assert.match(formatFinalStatus(result), /50\.0 tok\/s/);
});

test("tracks visible thinking separately from time to answer", () => {
	const turn = new TurnMetrics(2, 10_000);
	turn.recordActivity("thinking", "considering", 10_400);
	turn.recordActivity("text", "answer", 12_000);
	const result = turn.finish(
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "considering" },
				{ type: "text", text: "answer" },
			],
			usage: { output: 80, reasoning: 55 },
		},
		12_400,
	);

	assert.equal(result.ttftMs, 400);
	assert.equal(result.timeToTextMs, 2_000);
	assert.equal(result.reasoningTokens, 55);
	assert.equal(result.effectiveRate, false);
	assert.match(formatFinalStatus(result), /answer 2\.00s/);
	assert.match(formatFinalStatus(result), /\(r 55\)/);
});

test("uses whole-request effective rate when reasoning tokens are hidden", () => {
	const turn = new TurnMetrics(3, 5_000);
	turn.recordActivity("text", "answer", 9_000);
	const result = turn.finish(textMessage("answer", { output: 100, reasoning: 80 }), 10_000);

	assert.equal(result.ttftMs, 4_000);
	assert.equal(result.effectiveRate, true);
	assert.equal(result.tokensPerSecond, 20);
	assert.match(formatFinalStatus(result), /eff ~20\.0 tok\/s/);
});

test("falls back to Pi's chars-over-four estimate for zero-filled local usage", () => {
	const turn = new TurnMetrics(4, 0);
	turn.recordActivity("thinking", "12345678", 100);
	turn.recordActivity("text", "12345678", 200);
	const result = turn.finish(
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "12345678" },
				{ type: "text", text: "12345678" },
			],
			usage: { output: 0, reasoning: 0 },
		},
		300,
	);

	assert.equal(result.outputTokens, 4);
	assert.equal(result.outputTokensEstimated, true);
	assert.equal(result.reasoningTokens, 2);
	assert.equal(result.reasoningTokensEstimated, true);
	assert.match(formatFinalStatus(result), /~4 tok \(r ~2\)/);
});

test("marks TTFT as an upper bound for a non-streaming provider", () => {
	const turn = new TurnMetrics(5, 1_000);
	const result = turn.finish(textMessage("12345678", { output: 2 }), 2_000);

	assert.equal(result.ttftMs, 1_000);
	assert.equal(result.ttftIsUpperBound, true);
	assert.equal(result.effectiveRate, true);
	assert.match(formatFinalStatus(result), /TTFT \u22641\.00s/);
});

test("marks a delta-less content-end TTFT as an upper bound", () => {
	const turn = new TurnMetrics(6, 1_000);
	turn.recordCompletionActivity("text", 1_800);
	const result = turn.finish(textMessage("done", { output: 1 }), 2_000);

	assert.equal(result.ttftMs, 800);
	assert.equal(result.ttftIsUpperBound, true);
	assert.equal(result.effectiveRate, true);
	assert.match(formatFinalStatus(result), /TTFT \u2264800ms/);
});

test("provider boundary excludes turn preparation, with turn_start fallback", () => {
	const turn = new TurnMetrics(0, 0);
	turn.recordRequestStart(200);
	turn.recordActivity("text", "hello", 500);
	turn.recordRequestStart(600); // Never move the boundary after output started.
	assert.equal(turn.finish(textMessage("hello"), 1_000).ttftMs, 300);
});

test("live estimates exclude the first chunk and freeze during usage trailers", () => {
	const turn = new TurnMetrics(0, 0);
	turn.recordActivity("text", "x".repeat(400), 100);
	assert.equal(formatStreamingStatus(turn.snapshot(), 900), "TTFT 100ms");
	turn.recordActivity("text", "y".repeat(40), 1_100);
	assert.equal(turn.snapshot().estimatedStreamTokens, 110);
	assert.equal(formatStreamingStatus(turn.snapshot(), 1_100), "TTFT 100ms · ~10.0 tok/s");
	assert.equal(formatStreamingStatus(turn.snapshot(), 10_000), "TTFT 100ms · ~10.0 tok/s");
	const result = turn.finish(textMessage("x".repeat(440)), 10_000);
	assert.equal(result.tokensPerSecond, 10);
	assert.match(formatFinalStatus(result), /~10\.0 tok\/s/);
});

test("final usage arriving late does not dilute decode throughput", () => {
	const turn = new TurnMetrics(0, 0);
	turn.recordActivity("text", "a", 100);
	turn.recordActivity("text", "b", 1_100);
	const message = textMessage("ab", { output: 101 });
	assert.equal(turn.finish(message, 1_100).tokensPerSecond, 100);
	assert.equal(turn.finish(message, 30_000).tokensPerSecond, 100);
});

test("single chunks, single tokens and near-zero spans have no decode rate", () => {
	for (const output of [1, 100]) {
		const turn = new TurnMetrics(0, 0);
		turn.recordActivity("text", "buffered", 100);
		assert.equal(turn.finish(textMessage("buffered", { output }), 1_000).tokensPerSecond, undefined);
		turn.recordActivity("text", "!", 101);
		assert.equal(turn.finish(textMessage("buffered!", { output }), 1_000).tokensPerSecond, undefined);
	}
});

test("zero-filled and invalid usage are visibly estimated, including tool output", () => {
	for (const output of [0, -1, NaN, Infinity, undefined]) {
		const turn = new TurnMetrics(0, 0);
		turn.recordActivity("tool", "12345678", 100);
		turn.recordActivity("tool", "12345678", 1_100);
		const result = turn.finish({ role: "assistant", usage: { output } }, 5_000);
		assert.equal(result.outputTokens, 4);
		assert.equal(result.tokensPerSecond, 2);
		assert.match(formatFinalStatus(result), /~2\.0 tok\/s.*~4 tok/);
	}
});

test("completion-only upper bounds remain marked in the live status", () => {
	const turn = new TurnMetrics(0, 0);
	turn.recordCompletionActivity("text", 100);
	turn.recordActivity("text", "later", 200);
	assert.equal(formatStreamingStatus(turn.snapshot(), 1_000), "TTFT ≤100ms");
	assert.equal(turn.finish(textMessage("later"), 1_000).effectiveRate, true);
});

test("Input/TTFT counts uncached input plus cache writes and is opt-in", () => {
	const turn = new TurnMetrics(0, 0);
	turn.recordActivity("text", "answer", 500);
	const result = turn.finish({
		...textMessage("answer"),
		usage: { input: 100, cacheWrite: 50, cacheRead: 10_000, output: 10 },
	}, 1_000);
	assert.equal(result.inputTokensPerSecond, 300);
	assert.doesNotMatch(formatFinalStatus(result), /Input\/TTFT/);
	assert.match(formatFinalStatus(result, { showInputRate: true }), /Input\/TTFT ~300 tok\/s/);
	const buffered = new TurnMetrics(0, 0).finish({ ...textMessage("answer"), usage: { input: 100 } }, 1_000);
	assert.equal(buffered.inputTokensPerSecond, undefined);
});

test("compact output keeps uncertainty and abort markers but omits details", () => {
	const turn = new TurnMetrics(0, 0);
	turn.recordActivity("text", "answer", 500);
	const result = turn.finish({
		...textMessage("answer", { output: 100, reasoning: 80 }),
		stopReason: "aborted",
	}, 1_000);
	assert.equal(formatFinalStatus(result, { compact: true }), "TTFT 500ms · eff ~100 tok/s · aborted");
});

test("empty failures never invent a TTFT or a rate", () => {
	const turn = new TurnMetrics(0, 0);
	turn.recordActivity("text", "", 100);
	const result = turn.finish({ ...textMessage("", { output: 0 }), stopReason: "error" }, 1_000);
	assert.equal(formatFinalStatus(result), "TTFT — · tok/s — · error · 0 tok");
});
