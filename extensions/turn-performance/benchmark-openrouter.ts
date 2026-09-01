import { execFileSync } from "node:child_process";

import { formatFinalStatus, TurnMetrics } from "./metrics.ts";

const MODELS = [
	"deepseek/deepseek-v4-flash",
	"openai/gpt-oss-120b",
	"z-ai/glm-5.3-flash",
] as const;
const TRIALS = Math.max(1, Number.parseInt(process.env.OPENROUTER_BENCHMARK_TRIALS ?? "2", 10) || 2);

const PROMPT =
	"Compute 17 * 23, then explain in two concise sentences why the multiplication is correct. " +
	"Do not use tools. Keep the final answer under 80 words.";

interface StreamUsage {
	completion_tokens?: number;
	completion_tokens_details?: { reasoning_tokens?: number };
	cost?: number;
}

interface GenerationData {
	provider_name?: string;
	latency?: number;
	generation_time?: number;
	native_tokens_completion?: number;
	native_tokens_reasoning?: number;
	total_cost?: number;
}

interface BenchmarkResult {
	model: string;
	trial: number;
	provider?: string;
	status: string;
	client: {
		ttftMs?: number;
		timeToTextMs?: number;
		totalMs: number;
		tokensPerSecond?: number;
		effectiveRate: boolean;
		outputTokens: number;
		reasoningTokens?: number;
	};
	openrouter: {
		latencyMs?: number;
		generationTimeMs?: number;
		tokensPerSecond?: number;
		completionTokens?: number;
		reasoningTokens?: number;
		cost?: number;
	};
}

function getApiKey(): string {
	try {
		const key = execFileSync("pi", ["auth", "print-api-key", "--provider", "openrouter"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
		if (key) return key;
	} catch {
		// Keep credential-command output private, including on failure.
	}
	throw new Error("Pi has no usable OpenRouter API key");
}

function reasoningText(delta: Record<string, unknown>): string {
	if (typeof delta.reasoning === "string") return delta.reasoning;
	if (!Array.isArray(delta.reasoning_details)) return "";
	let text = "";
	for (const detail of delta.reasoning_details) {
		if (!detail || typeof detail !== "object") continue;
		const item = detail as Record<string, unknown>;
		if (typeof item.text === "string") text += item.text;
		else if (typeof item.summary === "string") text += item.summary;
	}
	return text;
}

async function generationMetadata(apiKey: string, id: string): Promise<GenerationData | undefined> {
	for (let attempt = 0; attempt < 16; attempt++) {
		if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1000));
		const url = new URL("https://openrouter.ai/api/v1/generation");
		url.searchParams.set("id", id);
		const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
		if (response.ok) {
			const body = (await response.json()) as { data?: GenerationData };
			return body.data;
		}
		if (response.status !== 404) return undefined;
	}
	return undefined;
}

async function runTrial(apiKey: string, model: string, trial: number): Promise<BenchmarkResult> {
	const startedAt = performance.now();
	const turn = new TurnMetrics(trial, startedAt);
	const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
			"HTTP-Referer": "https://pi.dev/turn-performance-benchmark",
			"X-Title": "Pi turn performance benchmark",
		},
		body: JSON.stringify({
			model,
			messages: [{ role: "user", content: PROMPT }],
			stream: true,
			max_tokens: 2048,
			temperature: 0,
			reasoning: { effort: "low", exclude: false },
		}),
	});

	if (!response.ok || !response.body) {
		throw new Error(`${model}: OpenRouter returned HTTP ${response.status}`);
	}

	let generationId = "";
	let text = "";
	let thinking = "";
	let toolText = "";
	let usage: StreamUsage | undefined;
	let buffer = "";
	const decoder = new TextDecoder();

	for await (const chunk of response.body) {
		buffer += decoder.decode(chunk, { stream: true });
		for (;;) {
			const boundary = buffer.indexOf("\n\n");
			if (boundary < 0) break;
			const event = buffer.slice(0, boundary);
			buffer = buffer.slice(boundary + 2);

			for (const line of event.split("\n")) {
				if (!line.startsWith("data:")) continue;
				const data = line.slice(5).trim();
				if (!data || data === "[DONE]") continue;
				const payload = JSON.parse(data) as Record<string, unknown>;
				if (typeof payload.id === "string") generationId ||= payload.id;
				if (payload.usage && typeof payload.usage === "object") usage = payload.usage as StreamUsage;

				const choices = Array.isArray(payload.choices) ? payload.choices : [];
				for (const choice of choices) {
					if (!choice || typeof choice !== "object") continue;
					const deltaValue = (choice as Record<string, unknown>).delta;
					if (!deltaValue || typeof deltaValue !== "object") continue;
					const delta = deltaValue as Record<string, unknown>;
					const at = performance.now();

					const reasoning = reasoningText(delta);
					if (reasoning) {
						thinking += reasoning;
						turn.recordActivity("thinking", reasoning, at);
					}
					if (typeof delta.content === "string" && delta.content) {
						text += delta.content;
						turn.recordActivity("text", delta.content, at);
					}
					if (Array.isArray(delta.tool_calls)) {
						const serialized = JSON.stringify(delta.tool_calls);
						toolText += serialized;
						turn.recordActivity("tool", serialized, at);
					}
				}
			}
		}
	}

	const endedAt = performance.now();
	const reportedReasoning = usage?.completion_tokens_details?.reasoning_tokens;
	const result = turn.finish(
		{
			role: "assistant",
			content: [
				...(thinking ? [{ type: "thinking", thinking }] : []),
				...(text ? [{ type: "text", text }] : []),
				...(toolText ? [{ type: "text", text: toolText }] : []),
			],
			usage: { output: usage?.completion_tokens, reasoning: reportedReasoning },
		},
		endedAt,
	);
	const metadata = generationId ? await generationMetadata(apiKey, generationId) : undefined;
	const serverCompletionTokens = metadata?.native_tokens_completion ?? usage?.completion_tokens;
	const generationTimeMs = metadata?.generation_time;
	const serverRate =
		serverCompletionTokens !== undefined && generationTimeMs !== undefined && generationTimeMs > 0
			? serverCompletionTokens / (generationTimeMs / 1000)
			: undefined;

	return {
		model,
		trial,
		provider: metadata?.provider_name,
		status: formatFinalStatus(result),
		client: {
			ttftMs: result.ttftMs,
			timeToTextMs: result.timeToTextMs,
			totalMs: endedAt - startedAt,
			tokensPerSecond: result.tokensPerSecond,
			effectiveRate: result.effectiveRate,
			outputTokens: result.outputTokens,
			reasoningTokens: result.reasoningTokens,
		},
		openrouter: {
			latencyMs: metadata?.latency,
			generationTimeMs,
			tokensPerSecond: serverRate,
			completionTokens: serverCompletionTokens,
			reasoningTokens: metadata?.native_tokens_reasoning ?? reportedReasoning,
			cost: metadata?.total_cost ?? usage?.cost,
		},
	};
}

const apiKey = getApiKey();
const results: BenchmarkResult[] = [];
for (const model of MODELS) {
	for (let trial = 1; trial <= TRIALS; trial++) {
		process.stderr.write(`Running ${model} (${trial}/${TRIALS})...\n`);
		try {
			results.push(await runTrial(apiKey, model, trial));
		} catch (error) {
			process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		}
	}
}

console.log(JSON.stringify(results, null, 2));
