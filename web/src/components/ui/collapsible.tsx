import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/** Auto-height collapsible using grid-template-rows (0fr -> 1fr). */
export function CollapsibleContent({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "grid transition-[grid-template-rows] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
        open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        className,
      )}
    >
      <div className="overflow-hidden">{children}</div>
    </div>
  );
}

export function IconSwap({ active, on, off }: { active: boolean; on: ReactNode; off: ReactNode }) {
  const base = "[grid-area:1/1] transition-[opacity,scale,filter] duration-200 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none";
  return (
    <span className="grid place-items-center">
      <span className={cn(base, active ? "scale-100 opacity-100 blur-none" : "scale-[0.25] opacity-0 blur-[4px]")}>{on}</span>
      <span className={cn(base, active ? "scale-[0.25] opacity-0 blur-[4px]" : "scale-100 opacity-100 blur-none")}>{off}</span>
    </span>
  );
}
