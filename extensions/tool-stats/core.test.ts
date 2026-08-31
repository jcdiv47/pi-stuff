import assert from "node:assert/strict";
import test from "node:test";

import {
  ToolStats,
  extractToolInvocations,
  formatFooter,
  formatToolRows,
} from "./core.ts";

function assistant(...calls: Array<{ id: string; name: string }>) {
  return {
    role: "assistant",
    timestamp: 100,
    content: calls.map((call) => ({
      type: "toolCall",
      id: call.id,
      name: call.name,
      arguments: {},
    })),
  };
}

function result(id: string, name: string, isError = false) {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [],
    isError,
    timestamp: 101,
  };
}

test("extracts built-in and extension tool calls", () => {
  assert.deepEqual(
    extractToolInvocations(
      assistant(
        { id: "call-1", name: "read" },
        { id: "call-2", name: "custom_search" },
      ),
    ),
    [
      { id: "call-1", name: "read" },
      { id: "call-2", name: "custom_search" },
    ],
  );
});

test("rebuilds calls and outcomes from a session branch", () => {
  const stats = new ToolStats();
  stats.rebuild([
    { type: "message", id: "a", message: assistant({ id: "1", name: "read" }) },
    { type: "message", id: "b", message: result("1", "read") },
    {
      type: "message",
      id: "c",
      message: assistant(
        { id: "2", name: "bash" },
        { id: "3", name: "custom_search" },
      ),
    },
    { type: "message", id: "d", message: result("2", "bash", true) },
  ]);

  assert.deepEqual(stats.snapshot(), [
    {
      name: "bash",
      calls: 1,
      completed: 1,
      errors: 1,
      pending: 0,
      active: undefined,
      source: "historical",
    },
    {
      name: "custom_search",
      calls: 1,
      completed: 0,
      errors: 0,
      pending: 1,
      active: undefined,
      source: "historical",
    },
    {
      name: "read",
      calls: 1,
      completed: 1,
      errors: 0,
      pending: 0,
      active: undefined,
      source: "historical",
    },
  ]);
});

test("deduplicates lifecycle and persisted completion events", () => {
  const stats = new ToolStats();
  stats.ingestMessage(assistant({ id: "1", name: "read" }));
  stats.ingestMessage(assistant({ id: "1", name: "read" }));
  stats.recordCompletion("1", "read", false);
  stats.ingestMessage(result("1", "read"));

  assert.equal(stats.totalCalls(), 1);
  assert.equal(stats.snapshot()[0].completed, 1);
});

test("includes zero-call configured tools and classifies their source", () => {
  const stats = new ToolStats();
  stats.recordRequest("1", "read");

  assert.deepEqual(stats.snapshot([
    {
      name: "read",
      active: true,
      sourceInfo: { source: "builtin", scope: "temporary" },
    },
    {
      name: "ask_user",
      active: false,
      sourceInfo: { source: "local", scope: "user" },
    },
  ]), [
    {
      name: "read",
      calls: 1,
      completed: 0,
      errors: 0,
      pending: 1,
      active: true,
      source: "builtin",
    },
    {
      name: "ask_user",
      calls: 0,
      completed: 0,
      errors: 0,
      pending: 0,
      active: false,
      source: "extension",
    },
  ]);
});

test("formats a compact bounded footer and detailed rows", () => {
  const stats = new ToolStats();
  assert.equal(formatFooter(stats.snapshot()), undefined);

  stats.recordRequest("1", "read");
  stats.recordRequest("2", "read");
  stats.recordRequest("3", "bash");
  stats.recordCompletion("1", "read", false);
  stats.recordCompletion("3", "bash", true);
  const snapshot = stats.snapshot();

  assert.equal(formatFooter(snapshot), "read×2 · bash×1");
  assert.ok(formatFooter(snapshot, 17)!.length <= 17);
  assert.deepEqual(formatToolRows(snapshot), [
    "read  ·  2 calls · 1 ok · 1 pending · historical",
    "bash  ·  1 call · 0 ok · 1 error · historical",
  ]);
});
