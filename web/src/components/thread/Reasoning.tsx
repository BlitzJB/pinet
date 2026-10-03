import { useState } from "react";
import { BrainIcon, ChevronDownIcon } from "lucide-react";
import { cn, formatDuration } from "../../lib/utils";
import { CollapsibleContent } from "../ui/collapsible";
import { mono, ShimmerLabel } from "../ui/surfaces";

/**
 * A block of thinking, collapsed to what it cost: how long it took and how many
 * tokens it used. The thinking itself is rarely read twice, but its price is worth
 * seeing at a glance.
 */
export function Reasoning({
  text,
  active,
  durationMs,
  tokens,
  flat,
}: {
  text: string;
  active?: boolean;
  durationMs?: number;
  tokens?: number;
  flat?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!text.trim()) return null;

  const label = active ? "Thinking…" : durationMs ? `Thought for ${formatDuration(durationMs)}` : "Reasoning";

  return (
    <div className={cn("rounded-xl", !flat && "border border-border/60 bg-foreground/[0.02] px-3 py-2")}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className={cn(
          "flex w-full items-center gap-2 rounded-md text-[13px] text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
          flat && "px-1 py-1",
        )}
      >
        <BrainIcon className="size-3.5 shrink-0 text-foreground/35" />
        <ShimmerLabel active={active} className="min-w-0 truncate">
          {label}
        </ShimmerLabel>
        {!active && tokens !== undefined && tokens > 0 && (
          <span className={cn(mono, "shrink-0 text-[11px] text-foreground/30 tabular-nums")}>{tokens} tokens</span>
        )}
        <ChevronDownIcon className={cn("ml-auto size-3.5 shrink-0 transition-transform duration-200", open && "rotate-180")} />
      </button>
      <CollapsibleContent open={open}>
        <div className="mt-2 max-h-80 overflow-y-auto border-l-2 border-border pl-3 text-[13px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] text-muted-foreground italic">
          {text}
        </div>
      </CollapsibleContent>
    </div>
  );
}
