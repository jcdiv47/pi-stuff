/**
 * Column math for the /tool-stats table.
 *
 * This module stays free of TUI imports so the layout can be unit-tested and so
 * the extension entry point never pulls the TUI packages in print/RPC mode.
 * Everything here works on plain (unstyled) text: colors are applied by the
 * renderer *after* padding, which keeps the columns aligned.
 */

export interface TableRow {
  name: string;
  calls: number;
  ok: number;
  errors: number;
  pending: number;
  source: string;
  inactive: boolean;
}

export type ColumnKey =
  | "name"
  | "calls"
  | "bar"
  | "ok"
  | "err"
  | "pend"
  | "source"
  | "status";

export interface Column {
  key: ColumnKey;
  header: string;
  align: "left" | "right";
  width: number;
}

export const COLUMN_GAP = 2;
/** Width of the "→ " / "  " selection marker in front of every row. */
export const ROW_PREFIX_WIDTH = 2;
/** Left pad + selection marker + one column of breathing room on the right. */
export const DEFAULT_RESERVED_WIDTH = 4;

export const EMPTY_CELL = "–";
const ELLIPSIS = "…";
/** Below this tool names get unreadable, so other columns give way first. */
const MIN_NAME_WIDTH = 12;
const BAR_WIDTH = 10;
const BAR_FULL = "▇";

const LEFT_TO_RIGHT: readonly ColumnKey[] = [
  "name",
  "calls",
  "bar",
  "ok",
  "err",
  "pend",
  "source",
  "status",
];

/** Columns give up their space in this order when the terminal gets narrow. */
const DROP_ORDER: readonly ColumnKey[] = [
  "bar",
  "pend",
  "source",
  "status",
  "ok",
  "err",
];

const HEADERS: Record<ColumnKey, string> = {
  name: "TOOL",
  calls: "CALLS",
  bar: "",
  ok: "OK",
  err: "ERR",
  pend: "PEND",
  source: "SOURCE",
  status: "STATUS",
};

const ALIGNMENT: Record<ColumnKey, "left" | "right"> = {
  name: "left",
  calls: "right",
  bar: "left",
  ok: "right",
  err: "right",
  pend: "right",
  source: "left",
  status: "left",
};

function count(value: number): string {
  return value > 0 ? String(value) : EMPTY_CELL;
}

function bar(row: TableRow, maxCalls: number, width: number): string {
  if (row.calls <= 0 || maxCalls <= 0) return "";
  const filled = Math.max(1, Math.round((row.calls / maxCalls) * width));
  return BAR_FULL.repeat(Math.min(width, filled));
}

/** Unpadded text for one cell. */
export function cellText(
  key: ColumnKey,
  row: TableRow,
  maxCalls: number,
  barWidth = BAR_WIDTH,
): string {
  switch (key) {
    case "name":
      return row.name;
    case "calls":
      return count(row.calls);
    case "bar":
      return bar(row, maxCalls, barWidth);
    case "ok":
      return count(row.ok);
    case "err":
      return count(row.errors);
    case "pend":
      return count(row.pending);
    case "source":
      return row.source;
    case "status":
      return row.inactive ? "inactive" : "";
  }
}

function includeColumn(key: ColumnKey, rows: readonly TableRow[]): boolean {
  switch (key) {
    // Columns that are all zeros/blank carry no information, so they never
    // take space away from the tool names.
    case "err":
      return rows.some((row) => row.errors > 0);
    case "pend":
      return rows.some((row) => row.pending > 0);
    case "status":
      return rows.some((row) => row.inactive);
    case "source":
      return rows.some((row) => row.source);
    case "bar":
      return rows.some((row) => row.calls > 0);
    default:
      return true;
  }
}

function naturalWidth(
  key: ColumnKey,
  rows: readonly TableRow[],
  maxCalls: number,
  withHeader = true,
): number {
  if (key === "bar") return BAR_WIDTH;
  let width = withHeader ? HEADERS[key].length : 1;
  for (const row of rows) {
    width = Math.max(width, cellText(key, row, maxCalls).length);
  }
  return width;
}

export function maxCallCount(rows: readonly TableRow[]): number {
  return rows.reduce((max, row) => Math.max(max, row.calls), 0);
}

export interface PlanColumnsOptions {
  /** Columns of chrome the table cannot use (marker, padding). */
  reserved?: number;
  /** Rows that must fit the columns without ever adding one, e.g. the totals. */
  measure?: readonly TableRow[];
}

/**
 * Pick the columns that fit into `width` and size them to their content.
 *
 * The name column absorbs whatever is left over, capped at the longest tool
 * name so the numbers never drift off to the far right of a wide terminal.
 */
export function planColumns(
  rows: readonly TableRow[],
  width: number,
  options: PlanColumnsOptions = {},
): Column[] {
  const { reserved = DEFAULT_RESERVED_WIDTH, measure = [] } = options;
  // Extra rows widen columns but never add one, so a wide total never elides.
  const sized = [...rows, ...measure];
  const maxCalls = maxCallCount(rows);
  const present = LEFT_TO_RIGHT.filter((key) => includeColumn(key, rows));
  const widths = new Map<ColumnKey, number>(
    present.map((key) => [key, naturalWidth(key, sized, maxCalls)]),
  );

  const keys = new Set(present);
  const nameWidth = () => {
    let fixed = reserved + COLUMN_GAP * (keys.size - 1);
    for (const key of keys) {
      if (key !== "name") fixed += widths.get(key) ?? 0;
    }
    return width - fixed;
  };

  for (const key of DROP_ORDER) {
    if (nameWidth() >= MIN_NAME_WIDTH) break;
    keys.delete(key);
  }

  if (nameWidth() < MIN_NAME_WIDTH) {
    // Last resort on a very narrow terminal: let the remaining columns shrink
    // to their values and clip the headers instead of running off the edge.
    for (const key of keys) {
      if (key === "name") continue;
      widths.set(key, naturalWidth(key, sized, maxCalls, false));
    }
  }

  const available = Math.max(1, nameWidth());
  widths.set("name", Math.min(widths.get("name") ?? 0, available));

  return LEFT_TO_RIGHT.filter((key) => keys.has(key)).map((key) => ({
    key,
    header: HEADERS[key],
    align: ALIGNMENT[key],
    width: Math.max(1, widths.get(key) ?? 0),
  }));
}

export function fitCell(text: string, column: Column): string {
  const truncated =
    text.length > column.width
      ? text.slice(0, Math.max(0, column.width - 1)) + ELLIPSIS
      : text;
  const padding = " ".repeat(Math.max(0, column.width - truncated.length));
  return column.align === "right" ? padding + truncated : truncated + padding;
}

/** Padded (still unstyled) cells for one row, in display order. */
export function rowCells(
  row: TableRow,
  columns: readonly Column[],
  maxCalls: number,
): string[] {
  return columns.map((column) =>
    fitCell(cellText(column.key, row, maxCalls, column.width), column),
  );
}

export function headerCells(columns: readonly Column[]): string[] {
  return columns.map((column) => fitCell(column.header, column));
}

export function joinCells(cells: readonly string[]): string {
  return cells.join(" ".repeat(COLUMN_GAP)).trimEnd();
}

/** Total width a laid-out row occupies, marker included. */
export function tableWidth(columns: readonly Column[]): number {
  const cells = columns.reduce((sum, column) => sum + column.width, 0);
  return ROW_PREFIX_WIDTH + cells + COLUMN_GAP * Math.max(0, columns.length - 1);
}

export function totalsRow(rows: readonly TableRow[]): TableRow {
  return rows.reduce<TableRow>(
    (total, row) => ({
      ...total,
      calls: total.calls + row.calls,
      ok: total.ok + row.ok,
      errors: total.errors + row.errors,
      pending: total.pending + row.pending,
    }),
    {
      name: "total",
      calls: 0,
      ok: 0,
      errors: 0,
      pending: 0,
      source: "",
      inactive: false,
    },
  );
}
