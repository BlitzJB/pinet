import { cn } from "../../lib/utils";

const DOT_DELAYS = ["-0.32s", "-0.16s", "0s"];

export function TypingIndicator({ variant = "bare", className }: { variant?: "bubble" | "bare"; className?: string }) {
  const dots = DOT_DELAYS.map((delay) => (
    <span
      key={delay}
      aria-hidden
      className="size-1.5 animate-bounce rounded-full bg-foreground/40 motion-reduce:animate-none"
      style={{ animationDelay: delay, animationDuration: "1.1s" }}
    />
  ));
  if (variant === "bubble") {
    return (
      <div className={cn("w-fit rounded-full border border-border/60 bg-background px-4 py-3.5 dark:bg-popover", className)}>
        <div role="status" aria-label="Assistant is working" className="flex gap-1">
          {dots}
        </div>
      </div>
    );
  }
  return (
    <div role="status" aria-label="Assistant is working" className={cn("flex gap-1", className)}>
      {dots}
    </div>
  );
}
