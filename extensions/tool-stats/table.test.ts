import assert from "node:assert/strict";
import test from "node:test";

import {
  COLUMN_GAP,
  EMPTY_CELL,
  type TableRow,
  cellText,
  fitCell,
  headerCells,
  joinCells,
  maxCallCount,
  planColumns,
  rowCells,
  tableWidth,
  totalsRow,
} from "./table.ts";

function row(overrides: Partial<TableRow> & { name: string }): TableRow {
  return {
    calls: 0,
    ok: 0,
    errors: 0,
    pending: 0,
    source: "builtin",
    inactive: false,
    ...overrides,
  };
}

const rows: TableRow[] = [
  row({ name: "bash", calls: 22, ok: 21, errors: 1 }),
  row({ name: "read", calls: 15, ok: 15 }),
  row({ name: "edit", calls: 8, ok: 6, errors: 2 }),
  row({ name: "ffgrep", calls: 7, ok: 7, source: "extension" }),
  row({ name: "subagent_spawn", source: "extension" }),
  row({ name: "powershell", inactive: true }),
];

function line(tableRow: TableRow, columns: ReturnType<typeof planColumns>) {
  return "  " + joinCells(rowCells(tableRow, columns, maxCallCount(rows)));
}

test("columns are sized to their content and the widest tool name", () => {
  const columns = planColumns(rows, 120);
  const byKey = new Map(columns.map((column) => [column.key, column]));

  assert.deepEqual(
    columns.map((column) => column.key),
    ["name", "calls", "bar", "ok", "err", "source", "status"],
  );
  assert.equal(byKey.get("name")?.width, "subagent_spawn".length);
  assert.equal(byKey.get("calls")?.width, "CALLS".length);
  assert.equal(byKey.get("source")?.width, "extension".length);
});

test("omits columns that would be empty for every row", () => {
  const clean = rows.map((entry) => ({
    ...entry,
    errors: 0,
    pending: 0,
    inactive: false,
  }));
  const keys = planColumns(clean, 120).map((column) => column.key);

  assert.ok(!keys.includes("err"));
  assert.ok(!keys.includes("pend"));
  assert.ok(!keys.includes("status"));
});

test("shows the pending column only while calls are in flight", () => {
  const pending = rows.map((entry, index) =>
    index === 0 ? { ...entry, pending: 2 } : entry,
  );
  assert.ok(planColumns(pending, 120).some((column) => column.key === "pend"));
});

test("every row lines up on the same column boundaries", () => {
  const columns = planColumns(rows, 120);
  const width = tableWidth(columns);
  // Trailing blanks are trimmed off each line, so compare on a padded copy.
  const header = ("  " + joinCells(headerCells(columns))).padEnd(width);

  let offset = 2;
  for (const column of columns) {
    for (const entry of rows) {
      const cell = line(entry, columns).padEnd(width).slice(offset, offset + column.width);
      const expected = cellText(column.key, entry, maxCallCount(rows), column.width);
      assert.equal(cell.trim(), expected, `row "${entry.name}" at ${column.key}`);
    }
    assert.equal(header.slice(offset, offset + column.width).trim(), column.header);
    offset += column.width + COLUMN_GAP;
  }
  assert.equal(offset - COLUMN_GAP, width);
});

test("drops columns as the terminal narrows and never overflows", () => {
  let previous = Number.POSITIVE_INFINITY;

  for (const width of [200, 120, 80, 60, 44, 32, 24, 16, 10]) {
    const columns = planColumns(rows, width);
    assert.ok(columns.some((column) => column.key === "name"));
    assert.ok(columns.some((column) => column.key === "calls"));
    assert.ok(
      tableWidth(columns) <= Math.max(width - 2, 8),
      `layout for width ${width} needs ${tableWidth(columns)} columns`,
    );
    assert.ok(columns.length <= previous, "narrower terminals gained a column");
    previous = columns.length;

    for (const entry of [...rows, totalsRow(rows)]) {
      assert.ok(line(entry, columns).length <= width);
    }
  }
});

test("keeps names readable at the narrowest layout", () => {
  const wide = planColumns(rows, 52);
  assert.deepEqual(
    wide.map((column) => column.key),
    ["name", "calls", "ok", "err", "status"],
    "the name column outranks source before it starts eliding",
  );
  assert.equal(
    wide.find((column) => column.key === "name")?.width,
    "subagent_spawn".length,
  );

  const narrow = planColumns(rows, 24);
  assert.deepEqual(
    narrow.map((column) => column.key),
    ["name", "calls"],
  );
  assert.ok(line(rows[4]!, narrow).includes("…"), "long names are elided");
});

test("renders zeros as a placeholder and scales the bar to the busiest tool", () => {
  const max = maxCallCount(rows);
  assert.equal(cellText("calls", rows[4]!, max), EMPTY_CELL);
  assert.equal(cellText("err", rows[1]!, max), EMPTY_CELL);
  assert.equal(cellText("status", rows[5]!, max), "inactive");

  const busiest = cellText("bar", rows[0]!, max, 10);
  assert.equal(busiest, "▇".repeat(10));
  assert.equal(cellText("bar", rows[3]!, max, 10).replace(/·/g, "").length, 3);
  assert.equal(cellText("bar", rows[4]!, max, 10), "");
});

test("measured rows widen columns without adding one", () => {
  const busy = rows.map((entry) => ({ ...entry, calls: entry.calls * 20 }));
  const totals = totalsRow(busy);
  const columns = planColumns(busy, 120, { measure: [totals] });
  const byKey = new Map(columns.map((column) => [column.key, column]));

  // "OK" is a two-character header, so only the totals can widen it.
  assert.equal(byKey.get("ok")?.width, String(totals.ok).length);
  assert.ok(
    !fitCell(cellText("ok", totals, maxCallCount(busy)), byKey.get("ok")!).includes("…"),
    "the totals row fits without eliding",
  );

  // A measured row must not introduce a column the visible rows do not need.
  const clean = rows.map((entry) => ({ ...entry, errors: 0 }));
  const keys = planColumns(clean, 120, {
    measure: [{ ...totalsRow(clean), errors: 4 }],
  }).map((column) => column.key);
  assert.ok(!keys.includes("err"));
});

test("totals sum every row", () => {
  const totals = totalsRow(rows);
  assert.equal(totals.calls, 52);
  assert.equal(totals.ok, 49);
  assert.equal(totals.errors, 3);
  assert.equal(totals.name, "total");
});
