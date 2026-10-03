import type { DisplayEntry } from "./pinet";

export interface ReasoningItem {
  type: "reasoning";
  text: string;
  /** How long the model spent thinking before the next thing happened. */
  durationMs?: number;
  /** Tokens the turn added, from the context size recorded on each entry. */
  tokens?: number;
}

export interface ToolItem {
  type: "tool";
  name: string;
  args?: string;
  output?: string;
  error?: boolean;
  running?: boolean;
  durationMs?: number;
}

export type ActivityItem = ReasoningItem | ToolItem;

export type Segment = { kind: "activity"; items: ActivityItem[] } | { kind: "text"; text: string };

/**
 * Turn a group of assistant/tool entries into render segments: consecutive
 * reasoning and tool blocks collapse into a single `activity` segment, while
 * assistant text stays inline as `text` segments.
 */
export function segmentAssistantTurn(entries: DisplayEntry[]): Segment[] {
  const results = new Map<string, DisplayEntry>();
  for (const entry of entries) {
    if (entry.kind === "tool" && entry.toolCallId) results.set(entry.toolCallId, entry);
  }
  // What the thinking cost: the time until the next thing happened, and the growth
  // in recorded context size across the turn. Both come from the entries themselves,
  // so nothing has to be plumbed through the protocol.
  const reasoningStats = new Map<DisplayEntry, { durationMs?: number; tokens?: number }>();
  entries.forEach((entry, index) => {
    if (!entry.reasoning?.trim()) return;
    const next = entries[index + 1];
    const durationMs =
      entry.timestamp !== undefined && next?.timestamp !== undefined && next.timestamp > entry.timestamp
        ? next.timestamp - entry.timestamp
        : undefined;
    const before = entry.tokensBefore;
    const previous = entries[index - 1]?.tokensBefore;
    const tokens = typeof before === "number" && typeof previous === "number" && before > previous ? before - previous : undefined;
    reasoningStats.set(entry, { durationMs, tokens });
  });

  const consumed = new Set<string>();
  const segments: Segment[] = [];
  let activity: ActivityItem[] = [];
  const flush = () => {
    if (activity.length) {
      segments.push({ kind: "activity", items: activity });
      activity = [];
    }
  };

  for (const entry of entries) {
    if (entry.kind === "assistant") {
      if (entry.reasoning?.trim()) activity.push({ type: "reasoning", text: entry.reasoning, ...reasoningStats.get(entry) });
      if (entry.text?.trim()) {
        flush();
        segments.push({ kind: "text", text: entry.text });
      }
      for (const tool of entry.tools ?? []) {
        const result = tool.id ? results.get(tool.id) : undefined;
        if (result?.id) consumed.add(result.id);
        activity.push({
          type: "tool",
          name: tool.name,
          args: tool.args,
          output: result?.text,
          error: result?.error,
          running: !result,
          durationMs: result?.timestamp && entry.timestamp ? result.timestamp - entry.timestamp : undefined,
        });
      }
    } else if (entry.kind === "tool") {
      if (entry.id && consumed.has(entry.id)) continue;
      activity.push({ type: "tool", name: entry.title ?? "tool", output: entry.text, error: entry.error });
    }
  }
  flush();
  return segments;
}

/** Human summary for an activity group header. */
export function summarizeActivity(items: ActivityItem[]): { label: string; totalMs: number } {
  const tools = items.filter((item): item is ToolItem => item.type === "tool");
  const hasReasoning = items.some((item) => item.type === "reasoning");
  const totalMs = tools.reduce((sum, tool) => sum + (tool.durationMs ?? 0), 0);
  const names = [...new Set(tools.map((tool) => tool.name))];
  const nameList = names.slice(0, 3).join(", ") + (names.length > 3 ? ` +${names.length - 3}` : "");

  let label: string;
  if (tools.length > 0 && hasReasoning) label = `Thought · ran ${nameList}`;
  else if (tools.length > 0) label = tools.length === 1 ? `Ran ${nameList}` : `Ran ${nameList} (${tools.length})`;
  else if (hasReasoning) label = "Thought";
  else label = "Activity";
  return { label, totalMs };
}
