import { useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import type { DisplayEntry } from "../../lib/pinet";
import { ghostButton } from "../ui/surfaces";
import { Markdown } from "../Markdown";
import { Reasoning } from "./Reasoning";
import { ToolCard } from "./ToolCard";
import { TypingIndicator } from "./TypingIndicator";

function CopyAction({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          /* clipboard unavailable */
        }
      }}
      className={cn(ghostButton, "size-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100")}
    >
      {copied ? <CheckIcon className="size-3.5 text-emerald-500" /> : <CopyIcon className="size-3.5" />}
    </button>
  );
}

interface Group {
  key: string;
  kind: "user" | "assistant" | "system";
  entries: DisplayEntry[];
}

export function groupEntries(entries: DisplayEntry[]): Group[] {
  const groups: Group[] = [];
  for (const entry of entries) {
    const key = entry.id ?? `${groups.length}`;
    if (entry.kind === "user") {
      groups.push({ key, kind: "user", entries: [entry] });
    } else if (entry.kind === "system") {
      groups.push({ key, kind: "system", entries: [entry] });
    } else {
      const last = groups[groups.length - 1];
      if (last && last.kind === "assistant") last.entries.push(entry);
      else groups.push({ key, kind: "assistant", entries: [entry] });
    }
  }
  return groups;
}

function UserMessage({ entry }: { entry: DisplayEntry }) {
  return (
    <div className="group flex flex-col items-end gap-1">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-muted px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap text-foreground">
        {entry.text ?? entry.body}
      </div>
      <div className="flex h-7 items-center">
        <CopyAction text={entry.text ?? entry.body ?? ""} label="Copy message" />
      </div>
    </div>
  );
}

function AssistantTurn({ group, running }: { group: Group; running: boolean }) {
  const results = new Map<string, DisplayEntry>();
  for (const entry of group.entries) if (entry.kind === "tool" && entry.toolCallId) results.set(entry.toolCallId, entry);
  const consumed = new Set<string>();
  const text = group.entries
    .filter((entry) => entry.kind === "assistant")
    .map((entry) => entry.text ?? "")
    .join("\n\n")
    .trim();

  return (
    <div className="group flex flex-col gap-3">
      {group.entries.map((entry) => {
        if (entry.kind === "assistant") {
          return (
            <div key={entry.id} className="flex flex-col gap-3">
              {entry.reasoning ? <Reasoning text={entry.reasoning} active={running} /> : null}
              {entry.text ? <Markdown text={entry.text} /> : null}
              {entry.tools?.map((tool, index) => {
                const result = tool.id ? results.get(tool.id) : undefined;
                if (result?.id) consumed.add(result.id);
                const durationMs = result?.timestamp && entry.timestamp ? result.timestamp - entry.timestamp : undefined;
                return (
                  <ToolCard
                    key={tool.id ?? index}
                    name={tool.name}
                    args={tool.args}
                    output={result?.text}
                    error={result?.error}
                    running={!result}
                    durationMs={durationMs}
                  />
                );
              })}
            </div>
          );
        }
        if (entry.kind === "tool") {
          if (entry.id && consumed.has(entry.id)) return null;
          return <ToolCard key={entry.id} name={entry.title ?? "tool"} output={entry.text} error={entry.error} />;
        }
        return null;
      })}
      {running && !group.entries.some((entry) => entry.tools?.length) ? <TypingIndicator /> : null}
      {text ? (
        <div className="flex h-7 items-center">
          <CopyAction text={text} label="Copy response" />
        </div>
      ) : null}
    </div>
  );
}

export function ThreadMessages({ entries, running }: { entries: DisplayEntry[]; running: boolean }) {
  const groups = groupEntries(entries);
  if (groups.length === 0) return null;
  return (
    <div className="flex flex-col gap-8">
      {groups.map((group, index) => {
        const isLast = index === groups.length - 1;
        if (group.kind === "user") return <UserMessage key={group.key} entry={group.entries[0]} />;
        if (group.kind === "system") {
          return (
            <div key={group.key} className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="h-px flex-1 bg-border/60" />
              <span>
                [{group.entries[0].title ?? "system"}] {group.entries[0].body}
              </span>
              <span className="h-px flex-1 bg-border/60" />
            </div>
          );
        }
        return <AssistantTurn key={group.key} group={group} running={running && isLast} />;
      })}
    </div>
  );
}
