import type { TableRow } from "./table.ts";

export interface ToolSourceInfo {
  source?: string;
  scope?: string;
}

export interface ToolDescriptor {
  name: string;
  active?: boolean;
  sourceInfo?: ToolSourceInfo;
}

export interface ToolCountSnapshot {
  name: string;
  calls: number;
  completed: number;
  errors: number;
  pending: number;
  active: boolean | undefined;
  source: "builtin" | "extension" | "sdk" | "historical";
}

export interface ToolInvocation {
  id: string;
  name: string;
}

interface MutableToolCount {
  calls: number;
  completed: number;
  errors: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function messageIdentity(message: Record<string, unknown>, fallback: string): string {
  const timestamp = message.timestamp;
  if (typeof timestamp === "string" || typeof timestamp === "number") {
    return `${fallback}:${timestamp}`;
  }
  return fallback;
}

/** Extract finalized LLM tool requests from an assistant message. */
export function extractToolInvocations(
  messageValue: unknown,
  fallbackKey = "message",
): ToolInvocation[] {
  const message = asRecord(messageValue);
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) {
    return [];
  }

  const prefix = messageIdentity(message, fallbackKey);
  const calls: ToolInvocation[] = [];

  for (let index = 0; index < message.content.length; index += 1) {
    const part = asRecord(message.content[index]);
    if (!part) continue;

    // toolCall is Pi's persisted format. The other spellings make the
    // scanner tolerant of older/foreign transcripts imported into Pi.
    if (!["toolCall", "tool_call", "tool_use"].includes(String(part.type))) {
      continue;
    }

    const name = nonEmptyString(part.name) ?? nonEmptyString(part.toolName);
    if (!name) continue;

    const id =
      nonEmptyString(part.id) ??
      nonEmptyString(part.toolCallId) ??
      nonEmptyString(part.tool_call_id) ??
      `${prefix}:tool:${index}:${name}`;

    calls.push({ id, name });
  }

  return calls;
}

interface ToolCompletion extends ToolInvocation {
  isError: boolean;
}

/** Extract a persisted tool completion from a toolResult message. */
export function extractToolCompletion(
  messageValue: unknown,
  fallbackKey = "message",
): ToolCompletion | undefined {
  const message = asRecord(messageValue);
  if (!message || !["toolResult", "tool_result"].includes(String(message.role))) {
    return undefined;
  }

  const name = nonEmptyString(message.toolName) ?? nonEmptyString(message.name);
  if (!name) return undefined;

  const id =
    nonEmptyString(message.toolCallId) ??
    nonEmptyString(message.tool_call_id) ??
    `${messageIdentity(message, fallbackKey)}:result:${name}`;

  return { id, name, isError: message.isError === true };
}

function sourceKind(
  descriptor: ToolDescriptor | undefined,
): ToolCountSnapshot["source"] {
  if (!descriptor) return "historical";
  if (descriptor.sourceInfo?.source === "builtin") return "builtin";
  if (descriptor.sourceInfo?.source === "sdk") return "sdk";
  return "extension";
}

export class ToolStats {
  private readonly counts = new Map<string, MutableToolCount>();
  private readonly requestIds = new Set<string>();
  private readonly completionIds = new Set<string>();

  clear(): void {
    this.counts.clear();
    this.requestIds.clear();
    this.completionIds.clear();
  }

  recordRequest(id: string, name: string): boolean {
    if (!id || !name || this.requestIds.has(id)) return false;
    this.requestIds.add(id);

    const count = this.counts.get(name) ?? {
      calls: 0,
      completed: 0,
      errors: 0,
    };
    count.calls += 1;
    this.counts.set(name, count);
    return true;
  }

  recordCompletion(id: string, name: string, isError: boolean): boolean {
    if (!id || !name || this.completionIds.has(id)) return false;

    // A completion normally follows an assistant toolCall. Treat an orphaned
    // result as one call so migrated or partially recovered sessions remain
    // internally consistent.
    this.recordRequest(id, name);
    this.completionIds.add(id);

    const count = this.counts.get(name)!;
    count.completed += 1;
    if (isError) count.errors += 1;
    return true;
  }

  ingestMessage(message: unknown, fallbackKey = "message"): boolean {
    let changed = false;
    for (const call of extractToolInvocations(message, fallbackKey)) {
      changed = this.recordRequest(call.id, call.name) || changed;
    }

    const completion = extractToolCompletion(message, fallbackKey);
    if (completion) {
      changed =
        this.recordCompletion(
          completion.id,
          completion.name,
          completion.isError,
        ) || changed;
    }
    return changed;
  }

  rebuild(entriesValue: unknown): void {
    this.clear();
    if (!Array.isArray(entriesValue)) return;

    for (let index = 0; index < entriesValue.length; index += 1) {
      const entry = asRecord(entriesValue[index]);
      if (!entry || entry.type !== "message") continue;
      const entryId = nonEmptyString(entry.id) ?? `entry:${index}`;
      this.ingestMessage(entry.message, entryId);
    }
  }

  totalCalls(): number {
    let total = 0;
    for (const count of this.counts.values()) total += count.calls;
    return total;
  }

  snapshot(catalog: readonly ToolDescriptor[] = []): ToolCountSnapshot[] {
    const descriptors = new Map<string, ToolDescriptor>();
    for (const tool of catalog) {
      if (tool?.name) descriptors.set(tool.name, tool);
    }

    const names = new Set([...descriptors.keys(), ...this.counts.keys()]);
    return [...names]
      .map((name) => {
        const count = this.counts.get(name) ?? {
          calls: 0,
          completed: 0,
          errors: 0,
        };
        const descriptor = descriptors.get(name);
        return {
          name,
          calls: count.calls,
          completed: count.completed,
          errors: count.errors,
          pending: Math.max(0, count.calls - count.completed),
          active: descriptor?.active,
          source: sourceKind(descriptor),
        };
      })
      .sort((left, right) =>
        right.calls - left.calls || left.name.localeCompare(right.name),
      );
  }
}

export function formatFooter(
  snapshot: readonly ToolCountSnapshot[],
  maxLength = 64,
): string | undefined {
  const used = snapshot.filter((tool) => tool.calls > 0);
  if (used.length === 0) return undefined;

  let text = "";
  let shown = 0;

  for (const tool of used) {
    const segment = `${shown > 0 ? " · " : ""}${tool.name}×${tool.calls}`;
    if (text.length + segment.length > maxLength) break;
    text += segment;
    shown += 1;
  }

  const omitted = used.length - shown;
  if (omitted > 0) {
    const suffix = `${shown > 0 ? " · " : ""}+${omitted}`;
    if (text.length + suffix.length <= maxLength) text += suffix;
  }
  return text || undefined;
}

/** Project a snapshot onto the plain shape the table renderer consumes. */
export function toTableRows(
  snapshot: readonly ToolCountSnapshot[],
): TableRow[] {
  return snapshot.map((tool) => ({
    name: tool.name,
    calls: tool.calls,
    ok: Math.max(0, tool.completed - tool.errors),
    errors: tool.errors,
    pending: tool.pending,
    source: tool.source,
    inactive: tool.active === false,
  }));
}

export function formatToolRows(
  snapshot: readonly ToolCountSnapshot[],
): string[] {
  if (snapshot.length === 0) return ["No tools configured or recorded"];

  return snapshot.map((tool) => {
    const details = [`${tool.calls} call${tool.calls === 1 ? "" : "s"}`];
    if (tool.completed > 0) {
      details.push(`${tool.completed - tool.errors} ok`);
    }
    if (tool.errors > 0) details.push(`${tool.errors} error${tool.errors === 1 ? "" : "s"}`);
    if (tool.pending > 0) details.push(`${tool.pending} pending`);
    details.push(tool.source);
    if (tool.active === false) details.push("inactive");
    return `${tool.name}  ·  ${details.join(" · ")}`;
  });
}
