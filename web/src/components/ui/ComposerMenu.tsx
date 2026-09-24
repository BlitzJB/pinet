import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

export function ComposerMenu({ open, align = "start", className, ...props }: ComponentProps<"div"> & { open: boolean; align?: "start" | "end" }) {
  return (
    <div
      data-slot="composer-menu"
      data-open={open || undefined}
      className={cn(
        "absolute bottom-full z-20 mb-2 flex w-44 flex-col gap-0.5 rounded-2xl border border-border/60 bg-background p-1.5 shadow-xl shadow-black/10 dark:bg-popover",
        align === "start" ? "start-0 origin-bottom-left" : "end-0 origin-bottom-right",
        "transition-[opacity,scale] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none",
        open ? "scale-100 opacity-100" : "pointer-events-none scale-[0.97] opacity-0",
        className,
      )}
      {...props}
    />
  );
}
