import assert from "node:assert/strict";
import test from "node:test";

import { formatFinalStatus, TurnMetrics } from "./metrics.ts";

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
	assert.equal(result.tokensPerSecond, 40.8);
	assert.match(formatFinalStatus(result), /TTFT 250ms/);
	assert.match(formatFinalStatus(result), /40\.8 tok\/s/);
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
