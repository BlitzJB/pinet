import { cn } from "../../lib/utils";

// Design surfaces ported from assistant-ui's elements library so our surfaces
// match theirs exactly (motion curves, opacity steps, active scale).

export const paper = "bg-background border border-border/60 dark:bg-popover";

export const floating = "bg-background border border-border/60 dark:bg-popover";

export const field = "bg-foreground/[0.04] dark:bg-foreground/[0.06]";

export const fieldInteractive =
  "bg-foreground/[0.04] transition-colors hover:bg-foreground/[0.07] dark:bg-foreground/[0.06] dark:hover:bg-foreground/[0.09]";

export const pressable =
  "transition-transform duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] active:scale-[0.96] motion-reduce:transition-none";

export const ghostButton =
  "flex items-center justify-center rounded-full text-foreground/45 outline-none transition-[background-color,color,scale] duration-150 hover:bg-foreground/[0.06] hover:text-foreground/90 active:scale-[0.96] focus-visible:ring-1 focus-visible:ring-foreground/20 motion-reduce:transition-none dark:hover:bg-foreground/[0.09]";

export const inkButton =
  "bg-foreground text-background transition-[opacity,scale] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:opacity-90 active:scale-[0.96] motion-reduce:transition-none disabled:opacity-30";

export const iconSwap =
  "[grid-area:1/1] transition-[opacity,scale,filter] duration-200 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none";

export const iconSwapIn = "scale-100 opacity-100 blur-none";
export const iconSwapOut = "scale-[0.25] opacity-0 blur-[4px]";

export const mono = "font-mono text-[11px] tracking-tight";

export const collapsePanel =
  "overflow-hidden transition-[height] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none";

export const codeScroll = "overflow-x-auto";
export const codeSurface = "w-max min-w-full";

export function ShimmerLabel({
  active = true,
  className,
  ...props
}: React.ComponentProps<"span"> & { active?: boolean }) {
  return <span className={cn(active && "shimmer motion-reduce:animate-none", className)} {...props} />;
}
