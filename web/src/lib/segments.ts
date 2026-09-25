import type { DisplayEntry } from "./pinet";

export interface ReasoningItem {
  type: "reasoning";
  text: string;
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
      if (entry.reasoning?.trim()) activity.push({ type: "reasoning", text: entry.reasoning });
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
