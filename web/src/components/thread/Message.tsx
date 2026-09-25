import { useState } from "react";
import { CheckIcon, ChevronDownIcon, CopyIcon, Minimize2Icon } from "lucide-react";
import { cn, formatTokens } from "../../lib/utils";
import type { DisplayEntry } from "../../lib/pinet";
import { segmentAssistantTurn } from "../../lib/segments";
import { CollapsibleContent } from "../ui/collapsible";
import { ghostButton } from "../ui/surfaces";
import { Markdown } from "../Markdown";
import { ActivityGroup } from "./ActivityGroup";

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

type GroupKind = "user" | "assistant" | "system" | "compaction";

interface Group {
  key: string;
  kind: GroupKind;
  entries: DisplayEntry[];
}

export function groupEntries(entries: DisplayEntry[]): Group[] {
  const groups: Group[] = [];
  for (const entry of entries) {
    const key = entry.id ?? `${groups.length}`;
    if (entry.kind === "user") {
      groups.push({ key, kind: "user", entries: [entry] });
    } else if (entry.kind === "system" || entry.kind === "compaction") {
      groups.push({ key, kind: entry.kind, entries: [entry] });
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

function CompactionNotice({ entry }: { entry: DisplayEntry }) {
  const [open, setOpen] = useState(false);
  const tokens = entry.tokensBefore ? formatTokens(entry.tokensBefore) : null;
  return (
    <div className="group flex flex-col items-center gap-1">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-foreground/[0.02] px-3 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-foreground/[0.04]"
      >
        <Minimize2Icon className="size-3.5 shrink-0" />
        <span>Context compacted{tokens ? ` · ${tokens} tokens summarized` : ""}</span>
        <ChevronDownIcon className={cn("size-3 shrink-0 transition-transform duration-200", open && "rotate-180")} />
      </button>
      <CollapsibleContent open={open} className="w-full">
        <div className="mx-auto mt-1 max-w-[36rem] rounded-xl border border-border/60 bg-foreground/[0.02] px-3 py-2 text-left text-[13px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {entry.summary || "No summary recorded."}
        </div>
      </CollapsibleContent>
    </div>
  );
}

function AssistantTurn({ group, running }: { group: Group; running: boolean }) {
  const segments = segmentAssistantTurn(group.entries);
  const text = group.entries
    .filter((entry) => entry.kind === "assistant")
    .map((entry) => entry.text ?? "")
    .join("\n\n")
    .trim();

  return (
    <div className="group flex flex-col gap-3">
      {segments.map((segment, index) => {
        if (segment.kind === "text") return <Markdown key={`text-${index}`} text={segment.text} />;
        const isLast = index === segments.length - 1;
        return <ActivityGroup key={`activity-${index}`} items={segment.items} running={running && isLast} />;
      })}
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
        if (group.kind === "compaction") return <CompactionNotice key={group.key} entry={group.entries[0]} />;
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
