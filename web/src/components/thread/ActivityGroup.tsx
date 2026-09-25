import { memo, useState } from "react";
import { ChevronDownIcon, SparklesIcon } from "lucide-react";
import { cn, formatDuration } from "../../lib/utils";
import { summarizeActivity, type ActivityItem } from "../../lib/segments";
import { CollapsibleContent } from "../ui/collapsible";
import { mono, ShimmerLabel } from "../ui/surfaces";
import { ToolCard } from "./ToolCard";

/** A 3×3 dot matrix with a diagonal pulse — the running indicator. */
function DotMatrix({ running }: { running: boolean }) {
  return (
    <span className="grid shrink-0 grid-cols-3 gap-[2.5px]" aria-hidden>
      {Array.from({ length: 9 }).map((_, index) => (
        <span
          key={index}
          style={running ? { animationDelay: `${(Math.floor(index / 3) + (index % 3)) * 90}ms` } : undefined}
          className={cn(
            "size-[3px] rounded-full",
            running ? "pinet-dot bg-blue-500 motion-reduce:animate-none" : "bg-muted-foreground/40",
          )}
        />
      ))}
    </span>
  );
}

export const ActivityGroup = memo(function ActivityGroup({ items, running }: { items: ActivityItem[]; running: boolean }) {
  // Collapsed by default; the header still reports live progress.
  const [open, setOpen] = useState(false);
  const runningTool = items.find((item) => item.type === "tool" && item.running) as
    | (ActivityItem & { name?: string })
    | undefined;
  const { label, totalMs } = summarizeActivity(items);

  const headerLabel = running ? (runningTool?.name ? `Running ${runningTool.name}…` : "Thinking…") : label;

  return (
    <div className="rounded-xl border border-border/60 bg-foreground/[0.02]">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-muted-foreground outline-none transition-colors hover:bg-foreground/[0.03]"
      >
        {running ? (
          <DotMatrix running />
        ) : (
          <SparklesIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
        )}
        <ShimmerLabel active={running} className="min-w-0 flex-1 truncate">
          {headerLabel}
        </ShimmerLabel>
        {!running && totalMs > 0 && <span className={cn(mono, "shrink-0 text-foreground/30 tabular-nums")}>{formatDuration(totalMs)}</span>}
        <ChevronDownIcon className={cn("size-3.5 shrink-0 transition-transform duration-200", open && "rotate-180")} />
      </button>
      <CollapsibleContent open={open}>
        <div className="space-y-2 px-3 pb-3">
          {items.map((item, index) =>
            item.type === "reasoning" ? (
              <div
                key={index}
                className="max-h-72 overflow-y-auto border-l-2 border-border pl-3 text-[13px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] text-muted-foreground italic"
              >
                {item.text}
              </div>
            ) : (
              <ToolCard key={index} name={item.name} args={item.args} output={item.output} error={item.error} running={item.running} durationMs={item.durationMs} flat />
            ),
          )}
        </div>
      </CollapsibleContent>
    </div>
  );
});
