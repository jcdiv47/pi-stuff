import {
  ToolStats,
  formatFooter,
  formatToolRows,
  toTableRows,
  type ToolCountSnapshot,
  type ToolDescriptor,
} from "./core.ts";
import type {
  KeybindingsLike,
  ThemeLike,
  TuiLike,
} from "./table-view.ts";

const STATUS_KEY = "tool-stats";

interface SessionManagerLike {
  getBranch(): unknown[];
}

interface UIContextLike {
  setStatus(key: string, text: string | undefined): void;
  select(title: string, options: string[]): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  custom?<T>(
    factory: (
      tui: TuiLike,
      theme: ThemeLike,
      keybindings: KeybindingsLike,
      done: (result: T) => void,
    ) => unknown,
  ): Promise<T>;
}

interface ContextLike {
  hasUI: boolean;
  mode?: string;
  sessionManager: SessionManagerLike;
  ui: UIContextLike;
}

interface ToolInfoLike {
  name: string;
  sourceInfo?: {
    source?: string;
    scope?: string;
  };
}

type EventHandler = (
  event: Record<string, unknown>,
  ctx: ContextLike,
) => void | Promise<void>;

interface ExtensionApiLike {
  on(event: string, handler: EventHandler): void;
  registerCommand(
    name: string,
    options: {
      description: string;
      handler: (args: string, ctx: ContextLike) => void | Promise<void>;
    },
  ): void;
  getAllTools(): ToolInfoLike[];
  getActiveTools(): string[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

export default function toolStatsExtension(pi: ExtensionApiLike): void {
  const stats = new ToolStats();

  const getCatalog = (): ToolDescriptor[] => {
    try {
      const active = new Set(pi.getActiveTools());
      return pi.getAllTools().map((tool) => ({
        name: tool.name,
        active: active.has(tool.name),
        sourceInfo: tool.sourceInfo,
      }));
    } catch {
      // A stale extension instance can briefly lose access during teardown.
      return [];
    }
  };

  const updateFooter = (ctx: ContextLike): void => {
    try {
      ctx.ui.setStatus(STATUS_KEY, formatFooter(stats.snapshot(getCatalog())));
    } catch {
      // Status UI is best-effort in print/RPC modes and during teardown.
    }
  };

  const rebuild = (ctx: ContextLike): void => {
    stats.rebuild(ctx.sessionManager.getBranch());
    updateFooter(ctx);
  };

  pi.on("session_start", (_event, ctx) => {
    rebuild(ctx);
  });

  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    const messageRecord = asRecord(message);
    const timestamp = messageRecord?.timestamp;
    const fallbackKey =
      typeof timestamp === "string" || typeof timestamp === "number"
        ? `live:${timestamp}`
        : "live-message";
    if (stats.ingestMessage(message, fallbackKey)) updateFooter(ctx);
  });

  // This arrives before the persisted toolResult message, which lets the
  // footer show failures/pending counts without waiting for message draining.
  pi.on("tool_execution_end", (event, ctx) => {
    const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
    const name = typeof event.toolName === "string" ? event.toolName : "";
    if (stats.recordCompletion(id, name, event.isError === true)) {
      updateFooter(ctx);
    }
  });

  // /tree changes the active path inside the same append-only session file.
  pi.on("session_tree", (_event, ctx) => {
    rebuild(ctx);
  });

  // Refresh configured/active tool metadata in case another extension added a
  // tool dynamically after session_start.
  pi.on("before_agent_start", (_event, ctx) => {
    updateFooter(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    try {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    } catch {
      // UI may already be unavailable.
    }
  });

  // The table view pulls in the TUI packages, so it is only loaded when a real
  // terminal is attached. Print/JSON/RPC hosts keep the plain list.
  const showTable = async (
    ctx: ContextLike,
    title: readonly string[],
    snapshot: readonly ToolCountSnapshot[],
  ): Promise<boolean> => {
    if (ctx.mode !== "tui" || typeof ctx.ui.custom !== "function") return false;
    try {
      const { ToolStatsView } = await import("./table-view.ts");
      await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
        const view = new ToolStatsView({
          title,
          rows: toTableRows(snapshot),
          theme,
          keybindings,
          tui,
          onClose: () => done(undefined),
        });
        return {
          render: (width: number) => view.render(width),
          handleInput: (data: string) => view.handleInput(data),
          invalidate: () => view.invalidate(),
        };
      });
      return true;
    } catch {
      // Fall through to the list rendering below.
      return false;
    }
  };

  pi.registerCommand("tool-stats", {
    description: "Show tool-call counts for the current session branch",
    handler: async (_args, ctx) => {
      const snapshot = stats.snapshot(getCatalog());
      const total = snapshot.reduce((sum, tool) => sum + tool.calls, 0);
      const used = snapshot.filter((tool) => tool.calls > 0).length;
      const title = [
        "Tool calls",
        `${total} total`,
        `${used} used`,
        "current branch",
      ];

      if (!ctx.hasUI) return;
      if (await showTable(ctx, title, snapshot)) return;

      const heading = title.join(" · ");
      const rows = formatToolRows(snapshot);
      try {
        await ctx.ui.select(heading, rows);
      } catch {
        // A plain notification is a useful fallback for limited RPC hosts.
        ctx.ui.notify(`${heading}\n\n${rows.join("\n")}`, "info");
      }
    },
  });
}
