import { useState } from "react";
import { AlertCircleIcon, CheckIcon, ChevronDownIcon, LoaderIcon, XCircleIcon } from "lucide-react";
import { cn, formatDuration } from "../../lib/utils";
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

export function ToolCard({ name, args, output, error, running, durationMs, flat }: ToolCardProps) {
  const [open, setOpen] = useState(false);
  const status: "running" | "complete" | "error" = running ? "running" : error ? "error" : "complete";
  const StatusIcon = status === "running" ? LoaderIcon : status === "complete" ? CheckIcon : XCircleIcon;
  const hasBody = Boolean(output && output.trim());

  return (
    <div
      className={cn(
        "group/tool w-full rounded-lg transition-colors",
        !flat && "border border-border/60 bg-foreground/[0.02] hover:bg-foreground/[0.04]",
      )}
    >
      <button
        type="button"
        onClick={() => hasBody && setOpen((value) => !value)}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left outline-none"
      >
        <StatusIcon
          className={cn(
            "size-3.5 shrink-0",
            status === "running" && "animate-spin text-blue-500 motion-reduce:animate-none",
            status === "complete" && "text-emerald-500",
            status === "error" && "text-destructive",
          )}
        />
        <span className={cn(mono, "shrink-0 font-medium text-foreground/80")}>{name}</span>
        {args ? <span className={cn(mono, "min-w-0 flex-1 truncate text-foreground/35")}>{args}</span> : <span className="flex-1" />}
        {durationMs !== undefined && <span className={cn(mono, "shrink-0 text-foreground/30 tabular-nums")}>{formatDuration(durationMs)}</span>}
        {hasBody && <ChevronDownIcon className={cn("size-3.5 shrink-0 text-foreground/30 transition-transform duration-200", open && "rotate-180")} />}
      </button>
      {hasBody && (
        <CollapsibleContent open={open}>
          <div className="px-3 pb-3">
            <pre className="max-h-96 overflow-auto rounded-lg border border-border/60 bg-background/60 p-2.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] text-foreground/70">
              {output}
            </pre>
          </div>
        </CollapsibleContent>
      )}
      {status === "error" && output && !open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={cn(ghostButton, "mx-3 mb-2 h-auto rounded-md px-2 py-0.5 text-[11px] text-destructive hover:text-destructive")}
        >
          <AlertCircleIcon className="mr-1 size-3" /> show error
        </button>
      )}
    </div>
  );
}
