import { memo, useEffect, useState } from "react";
import { ChevronDownIcon, LoaderIcon, SparklesIcon } from "lucide-react";
import { cn, formatDuration } from "../../lib/utils";
import { describeTool, summarizeTools, type ToolKind } from "../../lib/tools";
import type { ActivityItem } from "../../lib/segments";
import { CollapsibleContent } from "../ui/collapsible";
import { mono, ShimmerLabel } from "../ui/surfaces";
import { TOOL_ICONS, ToolCard } from "./ToolCard";

export const ActivityGroup = memo(function ActivityGroup({ items, running }: { items: ActivityItem[]; running: boolean }) {
  // Collapsed by default; the header still reports live progress.
  const [open, setOpen] = useState(false);

  const tools = items.filter((item): item is Extract<ActivityItem, { type: "tool" }> => item.type === "tool");
  const views = tools.map((tool) => describeTool(tool.name, tool.args, tool.output));
  const summary = summarizeTools(views);
  const totalMs = tools.reduce((sum, tool) => sum + (tool.durationMs ?? 0), 0);
  const failed = tools.some((tool) => tool.error);
  const runningTool = tools.find((tool) => tool.running);

  // A group holding a failure opens itself: the error is the reason to look, and
  // making someone find it behind a disclosure defeats the point of showing it.
  useEffect(() => {
    if (failed) setOpen(true);
  }, [failed]);

  const kinds = [...new Set(views.map((view) => view.kind))].slice(0, 3);
  const header = running ? (runningTool ? `Running ${runningTool.name}…` : "Thinking…") : summary;

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border transition-colors",
        failed ? "border-destructive/25 bg-destructive/[0.02]" : "border-border/60 bg-foreground/[0.02]",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-muted-foreground outline-none transition-colors hover:bg-foreground/[0.03] focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        {running ? (
          <LoaderIcon className="size-3.5 shrink-0 animate-spin text-foreground motion-reduce:animate-none" />
        ) : (
          <IconCluster kinds={kinds} />
        )}
        <ShimmerLabel active={running} className="min-w-0 flex-1 truncate">
          {header}
        </ShimmerLabel>
        {failed && <span aria-label="contains an error" className="size-1.5 shrink-0 rounded-full bg-destructive/70" />}
        {!running && totalMs > 0 && (
          <span className={cn(mono, "shrink-0 text-[11px] text-foreground/30 tabular-nums")}>{formatDuration(totalMs)}</span>
        )}
        <ChevronDownIcon className={cn("size-3.5 shrink-0 text-foreground/30 transition-transform duration-200", open && "rotate-180")} />
      </button>

      <CollapsibleContent open={open}>
        <div className="border-t border-border/40 px-3 pb-3 pt-2.5">
          {/* A rail, so a nested list still reads as belonging to this group. */}
          <div className="space-y-2 border-l border-border/50 pl-3">
            {items.map((item, index) =>
              item.type === "reasoning" ? (
                <div
                  key={index}
                  style={{ animation: "pinet-item-in 180ms cubic-bezier(0.2, 0.8, 0.2, 1) both", animationDelay: `${Math.min(index, 8) * 18}ms` }}
                  className="max-h-72 overflow-y-auto border-l-2 border-border pl-3 text-[13px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] text-muted-foreground italic"
                >
                  {item.text}
                </div>
              ) : (
                <div key={index} style={{ animation: "pinet-item-in 180ms cubic-bezier(0.2, 0.8, 0.2, 1) both", animationDelay: `${Math.min(index, 8) * 18}ms` }}>
                  <ToolCard
                    name={item.name}
                    args={item.args}
                    output={item.output}
                    error={item.error}
                    running={item.running}
                    durationMs={item.durationMs}
                    flat
                  />
                </div>
              ),
            )}
          </div>
        </div>
      </CollapsibleContent>
    </div>
  );
});

/**
 * What kinds of work happened, as overlapping discs. Reading the shape of a group
 * before its text is most of what makes a long transcript skimmable.
 */
function IconCluster({ kinds }: { kinds: ToolKind[] }) {
  if (kinds.length === 0) return <SparklesIcon className="size-3.5 shrink-0 text-muted-foreground/70" />;
  return (
    <span className="flex shrink-0 items-center">
      {kinds.map((kind, index) => {
        const Icon = TOOL_ICONS[kind];
        return (
          <span
            key={kind}
            style={{ zIndex: kinds.length - index }}
            className={cn(
              "flex size-5 items-center justify-center rounded-full border border-border/60 bg-background",
              index > 0 && "-ml-1.5",
            )}
          >
            <Icon className="size-3 text-foreground/45" />
          </span>
        );
      })}
    </span>
  );
}
