import { useState } from "react";
import { BrainIcon, ChevronDownIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import { CollapsibleContent } from "../ui/collapsible";
import { ShimmerLabel } from "../ui/surfaces";

export function Reasoning({ text, active }: { text: string; active?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!text.trim()) return null;
  return (
    <div className="rounded-xl border border-border/60 bg-foreground/[0.02] px-3 py-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 text-[13px] text-muted-foreground outline-none"
      >
        <BrainIcon className="size-3.5 shrink-0" />
        <ShimmerLabel active={active} className="font-medium">
          {active ? "Thinking…" : "Reasoning"}
        </ShimmerLabel>
        <ChevronDownIcon className={cn("ml-auto size-3.5 transition-transform duration-200", open && "rotate-180")} />
      </button>
      <CollapsibleContent open={open}>
        <div className="mt-2 max-h-80 overflow-y-auto border-l-2 border-border pl-3 text-[13px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] text-muted-foreground italic">
          {text}
        </div>
      </CollapsibleContent>
    </div>
  );
}
