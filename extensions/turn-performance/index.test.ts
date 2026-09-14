import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import turnPerformanceExtension from "./index.ts";

type Api = Parameters<typeof turnPerformanceExtension>[0];
type Handler = Parameters<Api["on"]>[1];

function harness(t: TestContext, hasUI = true, flags: Record<string, boolean> = {}) {
	let at = 0;
	t.mock.method(performance, "now", () => at);
	t.mock.timers.enable({ apis: ["setInterval"] });
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, Parameters<Api["registerCommand"]>[1]>();
	const statuses: (string | undefined)[] = [];
	const notifications: { message: string; type: string }[] = [];
	const ctx = {
		hasUI,
		ui: {
			setStatus: (_key: string, text: string | undefined) => { statuses.push(text); },
			notify: (message: string, type: "info") => { notifications.push({ message, type }); },
			theme: { fg: (_color: string, text: string) => text },
		},
	};
	turnPerformanceExtension({
		on: (name, handler) => { handlers.set(name, handler); },
		registerFlag: () => {},
		getFlag: (name) => flags[name],
		registerCommand: (name, command) => { commands.set(name, command); },
	});
	const emit = (name: string, event: unknown = {}, time = at) => {
		at = time;
		return handlers.get(name)?.(event, ctx);
	};
	emit("session_start");
	t.after(() => emit("session_shutdown"));
	return {
		emit,
		statuses,
		notifications,
		status: () => statuses.at(-1),
		command: (name: string) => commands.get(name)!.handler("", ctx),
		tick: (ms: number) => { at += ms; t.mock.timers.tick(ms); },
		delta: (type: string, delta: string, time: number) => emit("message_update", {
			message: { role: "assistant" }, assistantMessageEvent: { type, delta },
		}, time),
	};
}

const message = {
	role: "assistant", content: [{ type: "text", text: "hello world" }], usage: { output: 51 },
};

test("request hook is observational and results survive tools and agent_end", (t) => {
	const h = harness(t);
	h.emit("turn_start", { turnIndex: 0 }, 0);
	const payload = { model: "example" };
	assert.equal(h.emit("before_provider_request", { payload }, 200), undefined);
	assert.deepEqual(payload, { model: "example" });
	h.emit("message_start", { message: { role: "assistant" } }, 300);
	h.delta("text_delta", "hello", 500);
	h.delta("text_delta", " world", 1_500);
	h.emit("message_end", { message }, 3_000);
	assert.equal(h.status(), "TTFT 300ms · 50.0 tok/s · 51 tok");
	const count = h.statuses.length;
	h.emit("message_end", { message: { role: "toolResult" } }, 10_000);
	h.emit("turn_end", { message }, 20_000);
	h.emit("agent_end");
	h.tick(1_000);
	assert.equal(h.statuses.length, count);
});

test("each tool-loop turn gets a fresh request boundary, including no-hook providers", (t) => {
	const h = harness(t);
	for (let i = 0; i < 2; i++) {
		const start = i * 10_000;
		h.emit("turn_start", { turnIndex: i }, start);
		if (i === 0) h.emit("before_provider_request", {}, start + 100);
		h.delta("toolcall_delta", "{", start + 500);
		h.delta("toolcall_delta", "}", start + 1_500);
		h.emit("turn_end", { message }, start + 2_000); // message_end fallback
		assert.match(h.status()!, new RegExp(`TTFT ${i === 0 ? 400 : 500}ms`));
	}
});

test("empty stream metadata is not a token or completion", (t) => {
	const h = harness(t);
	h.emit("turn_start", {}, 0);
	h.delta("text_delta", "", 100);
	h.delta("text_start", "ignored", 200);
	h.emit("message_update", {
		message: { role: "assistant" }, assistantMessageEvent: { type: "text_end", content: "" },
	}, 300);
	h.delta("thinking_delta", "thinking", 500);
	h.delta("text_delta", "answer", 1_500);
	h.emit("message_end", { message }, 2_000);
	assert.match(h.status()!, /^TTFT 500ms · answer 1\.50s/);
});

test("nonempty completion without deltas gives an upper bound", (t) => {
	const h = harness(t);
	h.emit("turn_start", {}, 0);
	h.emit("message_update", {
		message: { role: "assistant" }, assistantMessageEvent: { type: "text_end", content: "hello world" },
	}, 500);
	assert.equal(h.status(), "TTFT ≤500ms");
	h.emit("message_end", { message }, 1_000);
	assert.match(h.status()!, /^TTFT ≤500ms · eff ~51\.0 tok\/s/);
});

for (const event of ["agent_end", "turn_end", "session_shutdown", "session_start", "session_tree"]) {
	test(`${event} cleans up an unfinished waiting timer`, (t) => {
		const h = harness(t);
		h.emit("turn_start", {}, 0);
		h.tick(500);
		assert.equal(h.status(), "TTFT 500ms…");
		h.emit(event);
		assert.equal(h.status(), undefined);
		const count = h.statuses.length;
		h.tick(1_000);
		assert.equal(h.statuses.length, count);
	});
}

test("idle model changes clear old results but in-flight changes preserve timing", (t) => {
	const h = harness(t);
	h.emit("turn_start", {}, 0);
	h.delta("text_delta", "hello", 100);
	h.emit("model_select", {}, 200);
	h.delta("text_delta", " world", 1_100);
	h.emit("message_end", { message }, 2_000);
	assert.match(h.status()!, /^TTFT 100ms/);
	h.emit("model_select");
	assert.equal(h.status(), undefined);
});

test("compact flag and command reformat a finished result without losing measurements", async (t) => {
	const h = harness(t, true, { "turn-performance-compact": true });
	h.emit("turn_start", {}, 0);
	h.delta("text_delta", "hello", 100);
	h.delta("text_delta", " world", 1_100);
	h.emit("message_end", { message }, 2_000);
	assert.equal(h.status(), "TTFT 100ms · 50.0 tok/s");
	await h.command("turn-performance-compact");
	assert.equal(h.status(), "TTFT 100ms · 50.0 tok/s · 51 tok");
});

test("compact toggle notifies both states even before any turn", async (t) => {
	const h = harness(t);
	assert.deepEqual(h.notifications, []);
	await h.command("turn-performance-compact");
	await h.command("turn-performance-compact");
	assert.deepEqual(h.notifications, [
		{ message: "Turn performance: compact mode on", type: "info" },
		{ message: "Turn performance: compact mode off", type: "info" },
	]);
});

test("headless runs do not paint, notify or start refresh timers", async (t) => {
	const h = harness(t, false);
	const interval = t.mock.method(globalThis, "setInterval");
	h.emit("turn_start", {}, 0);
	h.tick(1_000);
	h.emit("message_end", { message }, 2_000);
	await h.command("turn-performance-compact");
	assert.equal(h.statuses.length, 0);
	assert.equal(h.notifications.length, 0);
	assert.equal(interval.mock.callCount(), 0);
});
