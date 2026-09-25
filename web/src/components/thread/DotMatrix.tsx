import { cn } from "../../lib/utils";

/**
 * 3×3 dot matrix with a diagonal pulse. Used as the "working" indicator while a
 * message is delivered and the model is responding.
 */
export function DotMatrix({ running = true, className }: { running?: boolean; className?: string }) {
  return (
    <span className={cn("grid shrink-0 grid-cols-3 gap-[2.5px]", className)} aria-hidden>
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
