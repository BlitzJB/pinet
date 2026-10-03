import { memo, useEffect, useState } from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  FileTextIcon,
  FolderIcon,
  GlobeIcon,
  ListChecksIcon,
  LoaderIcon,
  PencilIcon,
  SearchIcon,
  SparklesIcon,
  TerminalIcon,
  XCircleIcon,
} from "lucide-react";
import { cn, formatDuration } from "../../lib/utils";
import { describeTool, splitPath, summarizeDiff, truncateLines, type DiffLine, type ToolKind } from "../../lib/tools";
import { CollapsibleContent } from "../ui/collapsible";
import { ghostButton, mono } from "../ui/surfaces";

export interface ToolCardProps {
  name: string;
  args?: string;
  output?: string;
  error?: boolean;
  running?: boolean;
  durationMs?: number;
  flat?: boolean;
}

export const TOOL_ICONS: Record<ToolKind, typeof FileTextIcon> = {
  read: FileTextIcon,
  edit: PencilIcon,
  write: PencilIcon,
  bash: TerminalIcon,
  search: SearchIcon,
  list: FolderIcon,
  web: GlobeIcon,
  todo: ListChecksIcon,
  agent: SparklesIcon,
  other: SparklesIcon,
};

/** Enough of an output to see what happened; the rest is one click away. */
const COLLAPSED_LINES = 24;
/** Below this a duration is noise rather than information. */
const MIN_DURATION_MS = 120;

export const ToolCard = memo(function ToolCard({ name, args, output, error, running, durationMs, flat }: ToolCardProps) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  const [copied, setCopied] = useState(false);
  // A running tool has no duration yet, so it is timed from when it appeared.
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [, tick] = useState(0);
  const [flash, setFlash] = useState(false);

  const view = describeTool(name, args, output);
  const Icon = TOOL_ICONS[view.kind];
  const status: "running" | "complete" | "error" = running ? "running" : error ? "error" : "complete";
  const hasBody = Boolean((output && output.trim()) || view.diff?.length);
  const shown = truncateLines(output ?? "", full ? Number.MAX_SAFE_INTEGER : COLLAPSED_LINES);

  useEffect(() => {
    if (!running) return;
    setStartedAt((current) => current ?? Date.now());
    const timer = setInterval(() => tick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);
  useEffect(() => {
    if (!running) setStartedAt(null);
  }, [running]);

  // An error is the one thing worth opening without being asked.
  useEffect(() => {
    if (error) setOpen(true);
  }, [error]);

  // A brief tint when a tool finishes, so a long list shows where the work landed.
  useEffect(() => {
    if (running) {
      setFlash(false);
      return;
    }
    setFlash(true);
    const timer = setTimeout(() => setFlash(false), 450);
    return () => clearTimeout(timer);
  }, [running]);

  const elapsed = running && startedAt ? Date.now() - startedAt : durationMs;
  const showDuration = !running && elapsed !== undefined && elapsed >= MIN_DURATION_MS;
  const stats = view.kind === "edit" || view.kind === "write" ? summarizeDiff(view.diff ?? []) : undefined;

  async function copy() {
    const text = output?.trim() ? (output ?? "") : (args ?? "");
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard refused; not worth interrupting anything over */
    }
  }

  return (
    <div
      className={cn(
        "group/tool w-full rounded-lg transition-colors duration-300",
        !flat && "border border-border/60 bg-foreground/[0.02] hover:bg-foreground/[0.04]",
        flash && "bg-emerald-500/[0.04] ring-1 ring-emerald-500/10 motion-reduce:bg-transparent motion-reduce:ring-0",
        status === "error" && "border-destructive/30 bg-destructive/[0.03]",
      )}
    >
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => hasBody && setOpen((value) => !value)}
          aria-expanded={hasBody ? open : undefined}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40 rounded-lg",
            flat ? "px-1" : "px-3",
          )}
        >
          <span className="relative flex size-3.5 shrink-0 items-center justify-center">
            {status === "running" ? (
              <LoaderIcon className="size-3.5 animate-spin text-foreground/60 motion-reduce:animate-none" />
            ) : (
              <Icon className="size-3.5 text-foreground/40" />
            )}
          </span>

          <span className="shrink-0 text-[12.5px] text-foreground/55">{view.verb}</span>
          {view.target && <Target kind={view.kind} target={view.target} />}
          {view.detail && <span className={cn(mono, "shrink-0 text-[11px] text-foreground/30")}>{view.detail}</span>}

          <span className="min-w-0 flex-1" />

          {stats && (stats.additions > 0 || stats.deletions > 0) && (
            <span className={cn(mono, "shrink-0 text-[11px] tabular-nums")}>
              {stats.additions > 0 && <span className="text-emerald-600/80">+{stats.additions}</span>}
              {stats.additions > 0 && stats.deletions > 0 && <span className="text-foreground/20"> </span>}
              {stats.deletions > 0 && <span className="text-red-600/80">−{stats.deletions}</span>}
            </span>
          )}

          {status === "running" && elapsed !== undefined && elapsed >= 1000 && (
            <span className={cn(mono, "shrink-0 text-[11px] text-foreground/30 tabular-nums")}>{formatDuration(elapsed)}</span>
          )}
          {showDuration && <span className={cn(mono, "shrink-0 text-[11px] text-foreground/30 tabular-nums")}>{formatDuration(elapsed)}</span>}
          {status === "error" && <XCircleIcon className="size-3.5 shrink-0 text-destructive/70" />}
          {status === "complete" && !hasBody && <CheckIcon className="size-3.5 shrink-0 text-emerald-500/50" />}

          {hasBody && (
            <ChevronDownIcon
              className={cn("size-3.5 shrink-0 text-foreground/30 transition-transform duration-200", open && "rotate-180")}
            />
          )}
        </button>

      </div>

      {hasBody && (
        <CollapsibleContent open={open}>
          <div className={flat ? "px-1 pb-3" : "px-3 pb-3"}>
            {/* The copy sits on the output rather than in the header. In the header it
                occupied a slot to the right of the chevron, which pushed the chevron
                out of line with the thinking block above — and a copy button belongs
                with the thing it copies anyway. */}
            <div className="group/out relative">
              <button
                type="button"
                onClick={() => void copy()}
                aria-label={copied ? "Copied" : "Copy output"}
                className={cn(
                  ghostButton,
                  "absolute right-1.5 top-1.5 z-10 size-6 rounded-md bg-background/85 p-0 opacity-0 backdrop-blur-sm transition-opacity group-hover/out:opacity-100 focus-visible:opacity-100",
                )}
              >
                {copied ? <CheckIcon className="size-3 text-emerald-500" /> : <CopyIcon className="size-3" />}
              </button>
              {view.diff?.length ? <DiffView lines={view.diff} /> : null}
            {shown.text.trim() && (
              <>
                <pre
                  className={cn(
                    mono,
                    "mt-0 max-h-96 overflow-auto rounded-lg border border-border/50 bg-background/60 p-2.5 text-[11.5px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]",
                    status === "error" ? "text-destructive/90" : "text-foreground/70",
                  )}
                >
                  {shown.text}
                </pre>
                {shown.hidden > 0 && (
                  <button
                    type="button"
                    onClick={() => setFull(true)}
                    className={cn(ghostButton, "mt-1 h-auto rounded-md px-2 py-0.5 text-[11px]")}
                  >
                    Show all {shown.total} lines
                  </button>
                )}
                </>
              )}
            </div>
          </div>
        </CollapsibleContent>
      )}
    </div>
  );
});

/**
 * The thing the tool acted on. A path keeps its directory dimmed and its file name
 * legible, which is what makes a column of paths scannable; commands and patterns
 * stay monospace because they are code.
 */
function Target({ kind, target }: { kind: ToolKind; target: string }) {
  if (kind === "bash" || kind === "search" || kind === "web") {
    return <span className={cn(mono, "min-w-0 truncate text-[11.5px] text-foreground/70")}>{target}</span>;
  }
  const { dir, base } = splitPath(target);
  return (
    <span className={cn(mono, "min-w-0 truncate text-[11.5px]")}>
      {dir && <span className="text-foreground/30">{dir}</span>}
      <span className="font-medium text-foreground/80">{base}</span>
    </span>
  );
}

/** A unified diff with a line-number gutter, the way an editor would show it. */
function DiffView({ lines }: { lines: DiffLine[] }) {
  return (
    <div className={cn(mono, "max-h-96 overflow-auto rounded-lg border border-border/50 bg-background/60 text-[11.5px] leading-[1.55]")}>
      {lines.map((line, index) => {
        if (line.kind === "gap") {
          return (
            <div key={index} className="flex items-center gap-2 px-2.5 py-1 text-[10.5px] text-foreground/25">
              <span className="h-px flex-1 bg-border/50" />
              {line.text}
              <span className="h-px flex-1 bg-border/50" />
            </div>
          );
        }
        const number = line.kind === "remove" ? line.oldLine : line.newLine;
        return (
          <div
            key={index}
            className={cn(
              "flex",
              line.kind === "add" && "bg-emerald-500/[0.07]",
              line.kind === "remove" && "bg-red-500/[0.07]",
            )}
          >
            <span className="w-9 shrink-0 select-none border-r border-border/40 px-1.5 text-right text-foreground/25 tabular-nums">
              {number ?? ""}
            </span>
            <span
              className={cn(
                "w-4 shrink-0 select-none text-center",
                line.kind === "add" ? "text-emerald-600/70" : line.kind === "remove" ? "text-red-600/70" : "text-foreground/15",
              )}
            >
              {line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}
            </span>
            <span className="min-w-0 whitespace-pre-wrap px-1.5 text-foreground/75 [overflow-wrap:anywhere]">{line.text || " "}</span>
          </div>
        );
      })}
    </div>
  );
}
