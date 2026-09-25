import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * Auto-height collapsible using grid-template-rows (0fr -> 1fr).
 *
 * Collapsed children are *unmounted*. In a long thread most activity groups are
 * collapsed by default, and keeping their reasoning/tool output in the DOM is by
 * far the biggest rendering cost (megabytes of hidden text). A short linger keeps
 * the closing animation intact.
 */
export function CollapsibleContent({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) {
  const [present, setPresent] = useState(open);
  const presentRef = useRef(present);
  presentRef.current = present;

  useLayoutEffect(() => {
    if (open) {
      setPresent(true);
      return;
    }
    if (!presentRef.current) return;
    const timer = setTimeout(() => setPresent(false), 220);
    return () => clearTimeout(timer);
  }, [open]);

  const show = open || present;

  return (
    <div
      className={cn(
        "grid transition-[grid-template-rows] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
        open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        className,
      )}
    >
      <div className="overflow-hidden">{show ? children : null}</div>
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
