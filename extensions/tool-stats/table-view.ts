import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

import {
  COLUMN_GAP,
  type Column,
  headerCells,
  joinCells,
  maxCallCount,
  planColumns,
  rowCells,
  type TableRow,
  tableWidth,
  totalsRow,
} from "./table.ts";

/**
 * Structural stand-ins for the host types. The extension is loaded from source
 * without the pi packages installed next to it, so only runtime helpers are
 * imported; everything else is described here.
 */
export interface ThemeLike {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
}

export interface KeybindingsLike {
  matches(data: string, keybinding: string): boolean;
  getKeys(keybinding: string): string[];
}

interface TerminalLike {
  readonly rows: number;
}

export interface TuiLike {
  terminal: TerminalLike;
  requestRender(force?: boolean): void;
}

export interface ToolStatsViewOptions {
  /** Title segments, most important first; trailing ones drop on narrow terminals. */
  title: readonly string[];
  rows: readonly TableRow[];
  theme: ThemeLike;
  keybindings: KeybindingsLike;
  tui: TuiLike;
  onClose: () => void;
}

/**
 * The list viewport takes at most half the terminal, the same budget the
 * built-in `/tree` selector uses, so the transcript stays readable behind it.
 */
const MIN_BODY_ROWS = 5;

type Entry =
  | { kind: "tool"; row: TableRow }
  | { kind: "divider"; label: string };

export class ToolStatsView {
  private readonly options: ToolStatsViewOptions;
  private readonly used: readonly TableRow[];
  private readonly unused: readonly TableRow[];
  private readonly maxCalls: number;
  private readonly totals: TableRow;
  private entries: Entry[] = [];
  private showUnused: boolean;
  private selected = 0;
  /** Tallest frame rendered so far; the panel never gives those lines back. */
  private reservedLines = 0;
  private lastTerminalRows = 0;

  constructor(options: ToolStatsViewOptions) {
    this.options = options;
    this.used = options.rows.filter((row) => row.calls > 0);
    this.unused = options.rows.filter((row) => row.calls === 0);
    this.maxCalls = maxCallCount(options.rows);
    this.totals = totalsRow(options.rows);
    // Tools that were never called are noise by default, unless they are all
    // there is to show.
    this.showUnused = this.used.length === 0;
    this.rebuild();
  }

  private rebuild(): void {
    this.entries = this.used.map((row) => ({ kind: "tool", row }) as Entry);

    if (this.unused.length > 0 && this.used.length > 0) {
      const state = this.showUnused ? "" : " (hidden)";
      this.entries.push({
        kind: "divider",
        label: `${this.unused.length} unused${state}`,
      });
    }
    if (this.showUnused) {
      for (const row of this.unused) this.entries.push({ kind: "tool", row });
    }
  }

  private toggleUnused(): void {
    if (this.used.length === 0 || this.unused.length === 0) return;
    this.showUnused = !this.showUnused;
    this.rebuild();
    // The cursor may now point past the end, or at the divider itself.
    this.selected = Math.min(this.selected, this.entries.length - 1);
    this.move(-1, false);
  }

  /** The rows currently on screen, which is what the columns are sized for. */
  private visibleRows(): TableRow[] {
    return this.entries
      .filter((entry) => entry.kind === "tool")
      .map((entry) => (entry as { row: TableRow }).row);
  }

  invalidate(): void {
    // Nothing is cached: every render rebuilds from the current theme and width.
  }

  handleInput(data: string): void {
    const { keybindings, onClose, tui } = this.options;

    if (
      keybindings.matches(data, "tui.select.cancel") ||
      keybindings.matches(data, "tui.select.confirm") ||
      data === "q"
    ) {
      onClose();
      return;
    }

    if (data === "u") {
      this.toggleUnused();
    } else if (keybindings.matches(data, "tui.select.up") || data === "k") {
      this.move(-1);
    } else if (keybindings.matches(data, "tui.select.down") || data === "j") {
      this.move(1);
    } else if (matchesKey(data, Key.pageUp)) {
      this.move(-this.bodyRows());
    } else if (matchesKey(data, Key.pageDown)) {
      this.move(this.bodyRows());
    } else if (matchesKey(data, Key.home) || data === "g") {
      this.selected = 0;
      this.move(1, false);
    } else if (matchesKey(data, Key.end) || data === "G") {
      this.selected = this.entries.length - 1;
      this.move(-1, false);
    } else {
      return;
    }

    tui.requestRender();
  }

  /** Move the cursor by `delta`, skipping dividers and clamping at the ends. */
  private move(delta: number, step = true): void {
    const limit = this.entries.length - 1;
    const clamp = (value: number) => Math.max(0, Math.min(limit, value));
    const direction = delta >= 0 ? 1 : -1;
    let next = clamp(this.selected + (step ? delta : 0));

    for (let guard = 0; guard <= limit; guard += 1) {
      if (this.entries[next]?.kind !== "divider") break;
      const candidate = next + direction;
      // Walk back the other way rather than resting on a divider.
      next = clamp(candidate < 0 || candidate > limit ? next - direction : candidate);
    }
    this.selected = next;
  }

  /** Body lines the terminal can host, ignoring how many are currently filled. */
  private availableRows(): number {
    return Math.max(MIN_BODY_ROWS, Math.floor(this.options.tui.terminal.rows / 2));
  }

  private bodyRows(): number {
    return Math.min(this.entries.length, this.availableRows());
  }

  /** Keep the cursor centred in the viewport, as `/tree` does. */
  private scrollStart(visible: number): number {
    const last = Math.max(0, this.entries.length - visible);
    return Math.max(0, Math.min(this.selected - Math.floor(visible / 2), last));
  }

  private line(text: string, width: number): string {
    return truncateToWidth(` ${text}`, width, "");
  }

  private renderRow(
    row: TableRow,
    columns: readonly Column[],
    selected: boolean,
    width: number,
    subdued = false,
  ): string {
    const { theme } = this.options;
    const cells = rowCells(row, columns, this.maxCalls);

    // Drop trailing blank cells so an unselected row carries no invisible
    // padding; a selected row keeps them so its highlight is a solid band.
    let last = cells.length - 1;
    while (!selected && last > 0 && cells[last]!.trim() === "") last -= 1;

    const painted = cells.slice(0, last + 1).map((cell, index) => {
      const column = columns[index]!;
      if (!subdued) return this.paint(column, row, cell);
      // The totals row has no meaningful share of the busiest tool.
      if (column.key === "bar") return " ".repeat(column.width);
      const color = column.key === "err" && row.errors > 0 ? "error" : "muted";
      return theme.fg(color, cell);
    });

    if (!selected) return this.line("  " + joinCells(painted), width);

    // `/tree` marks the cursor with a background band, which keeps the per-cell
    // colors readable instead of flattening the row to one accent color.
    const body = painted.join(" ".repeat(COLUMN_GAP));
    return this.line(theme.bg("selectedBg", theme.fg("accent", "→ ") + body), width);
  }

  private paint(column: Column, row: TableRow, cell: string): string {
    const { theme } = this.options;
    const dim = (text: string) => theme.fg("dim", text);
    const unused = row.calls === 0;

    switch (column.key) {
      case "name":
        return unused ? theme.fg("muted", cell) : theme.fg("text", cell);
      case "calls":
        return unused ? dim(cell) : theme.fg("accent", cell);
      case "bar":
        return theme.fg(unused ? "dim" : "borderAccent", cell);
      case "ok":
        return row.ok > 0 ? theme.fg("success", cell) : dim(cell);
      case "err":
        return row.errors > 0 ? theme.fg("error", cell) : dim(cell);
      case "pend":
        return row.pending > 0 ? theme.fg("warning", cell) : dim(cell);
      case "source":
        return theme.fg("muted", cell);
      case "status":
        return row.inactive ? theme.fg("warning", cell) : dim(cell);
    }
  }

  private rule(columns: readonly Column[], width: number): string {
    const span = Math.min(tableWidth(columns), Math.max(1, width - 2));
    return this.line(this.options.theme.fg("borderMuted", "─".repeat(span)), width);
  }

  private hints(width: number): string {
    const { keybindings, theme } = this.options;
    const key = (id: string, fallback: string) =>
      keybindings.getKeys(id)[0] ?? fallback;

    const parts: Array<[string, string]> = [["↑↓", "navigate"]];
    if (this.unused.length > 0 && this.used.length > 0) {
      parts.push(["u", this.showUnused ? "hide unused" : "show unused"]);
    }
    parts.push([key("tui.select.cancel", "escape"), "close"]);
    return this.line(
      parts
        .map(([keys, label]) => theme.fg("dim", keys) + theme.fg("muted", ` ${label}`))
        .join("   "),
      width,
    );
  }

  /** Keep as many title segments as fit, dropping the least important first. */
  private title(width: number): string {
    const segments = [...this.options.title];
    while (segments.length > 1 && segments.join(" · ").length > width - 2) {
      segments.pop();
    }
    return segments.join(" · ");
  }

  render(width: number): string[] {
    const { theme } = this.options;
    const rows = this.options.rows;
    const lines: string[] = [];

    lines.push(theme.fg("border", "─".repeat(Math.max(1, width))));
    lines.push("");
    lines.push(this.line(theme.fg("accent", theme.bold(this.title(width))), width));
    lines.push("");

    if (rows.length === 0) {
      lines.push(this.line(theme.fg("muted", "No tools configured or recorded"), width));
    } else {
      lines.push(...this.renderTable(width));
    }

    lines.push("");
    lines.push(this.hints(width));
    lines.push("");
    lines.push(theme.fg("border", "─".repeat(Math.max(1, width))));

    // Hiding the unused rows must not make the frame shorter than it has
    // already been: the host repaints the whole screen when content shrinks,
    // which wipes whatever sat above and below us. Keep the panel tight and
    // give the freed lines back as blank space above it, so the panel stays
    // anchored exactly where it was.
    // A resize repaints the screen anyway, so the reservation starts over then
    // instead of dragging a stale height across terminal sizes.
    const terminalRows = this.options.tui.terminal.rows;
    if (this.lastTerminalRows !== terminalRows) {
      this.lastTerminalRows = terminalRows;
      this.reservedLines = 0;
    }
    this.reservedLines = Math.max(this.reservedLines, lines.length);
    const filler = Math.max(0, this.reservedLines - lines.length);
    return filler > 0 ? [...Array<string>(filler).fill(""), ...lines] : lines;
  }

  private renderTable(width: number): string[] {
    const { theme } = this.options;
    const columns = planColumns(this.visibleRows(), width, {
      measure: [this.totals],
    });
    const lines: string[] = [];

    lines.push(
      this.line(
        theme.fg("dim", "  " + joinCells(headerCells(columns))),
        width,
      ),
    );

    const visible = this.bodyRows();
    const start = this.scrollStart(visible);
    const body: string[] = [];

    for (const [offset, entry] of this.entries.slice(start, start + visible).entries()) {
      const index = start + offset;
      if (entry.kind === "divider") {
        body.push(this.divider(entry.label, columns, width));
      } else {
        body.push(this.renderRow(entry.row, columns, index === this.selected, width));
      }
    }

    // Count tools rather than entries so the divider does not shift the index,
    // and render the counter unconditionally so the panel keeps its height.
    const before = this.entries
      .slice(0, this.selected + 1)
      .filter((entry) => entry.kind === "tool").length;
    const shown = this.entries.filter((entry) => entry.kind === "tool").length;
    body.push(this.line(theme.fg("muted", `  (${before}/${shown})`), width));

    lines.push(...body);
    lines.push(this.rule(columns, width));
    lines.push(this.renderRow(this.totals, columns, false, width, true));
    return lines;
  }

  private divider(label: string, columns: readonly Column[], width: number): string {
    const span = Math.min(tableWidth(columns), Math.max(1, width - 2));
    const text = ` ${label} `;
    const dashes = Math.max(0, span - text.length - COLUMN_GAP);
    const left = "─".repeat(Math.min(COLUMN_GAP, span));
    return this.line(
      this.options.theme.fg("dim", left + text + "─".repeat(dashes)),
      width,
    );
  }
}
