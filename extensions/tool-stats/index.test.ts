import assert from "node:assert/strict";
import test from "node:test";

import toolStatsExtension from "./index.ts";

type Handler = (event: Record<string, unknown>, ctx: ReturnType<typeof makeContext>) => unknown;

function assistant(id: string, name: string) {
  return {
    role: "assistant",
    timestamp: 100,
    content: [{ type: "toolCall", id, name, arguments: {} }],
  };
}

function makeContext() {
  const statuses: Array<string | undefined> = [];
  const selections: Array<{ title: string; options: string[] }> = [];
  let branch: unknown[] = [];

  return {
    hasUI: true,
    sessionManager: {
      getBranch: () => branch,
    },
    ui: {
      setStatus: (_key: string, value: string | undefined) => statuses.push(value),
      select: async (title: string, options: string[]) => {
        selections.push({ title, options });
        return undefined;
      },
      notify: () => {},
    },
    setBranch(value: unknown[]) {
      branch = value;
    },
    statuses,
    selections,
  };
}

test("wires lifecycle events, rebuilds branches, and exposes /tool-stats", async () => {
  const handlers = new Map<string, Handler>();
  let command:
    | { handler: (args: string, ctx: ReturnType<typeof makeContext>) => unknown }
    | undefined;

  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerCommand(_name: string, options: typeof command) {
      command = options;
    },
    getActiveTools: () => ["read", "custom_search"],
    getAllTools: () => [
      { name: "read", sourceInfo: { source: "builtin" } },
      { name: "bash", sourceInfo: { source: "builtin" } },
      { name: "custom_search", sourceInfo: { source: "local" } },
    ],
  };

  toolStatsExtension(pi);
  const ctx = makeContext();

  await handlers.get("session_start")?.({}, ctx);
  assert.equal(ctx.statuses.at(-1), undefined);

  ctx.setBranch([
    { type: "message", id: "a", message: assistant("1", "read") },
  ]);
  await handlers.get("session_tree")?.({}, ctx);
  assert.equal(ctx.statuses.at(-1), "read×1");

  await handlers.get("message_end")?.(
    { message: assistant("2", "custom_search") },
    ctx,
  );
  assert.equal(ctx.statuses.at(-1), "custom_search×1 · read×1");

  await handlers.get("tool_execution_end")?.(
    { toolCallId: "2", toolName: "custom_search", isError: true },
    ctx,
  );

  assert.ok(command);
  await command!.handler("", ctx);
  assert.match(ctx.selections[0].title, /2 total/);
  assert.match(ctx.selections[0].options[0], /custom_search/);
  assert.match(ctx.selections[0].options[0], /1 error/);
  assert.match(ctx.selections[0].options[2], /bash/);
  assert.match(ctx.selections[0].options[2], /0 calls/);

  ctx.setBranch([
    { type: "message", id: "b", message: assistant("3", "bash") },
  ]);
  await handlers.get("session_tree")?.({}, ctx);
  assert.equal(ctx.statuses.at(-1), "bash×1");
});
