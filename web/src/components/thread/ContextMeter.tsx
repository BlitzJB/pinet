import { cn } from "../../lib/utils";

export function ContextMeter({
  usage,
  compacting,
}: {
  usage?: { tokens?: number | null; contextWindow?: number; percent?: number | null } | null;
  compacting?: boolean;
}) {
  if (!usage || usage.percent == null) return null;
  const percent = Math.max(0, Math.min(100, usage.percent));
  const colour =
    percent >= 85 ? "text-destructive" : percent >= 60 ? "text-amber-500" : "text-muted-foreground";
  const stroke = percent >= 85 ? "stroke-destructive" : percent >= 60 ? "stroke-amber-500" : "stroke-emerald-500";
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const dash = (percent / 100) * circumference;
  const label = percent < 1 ? percent.toFixed(1) : String(Math.round(percent));

  return (
    <span
      className={cn("inline-flex shrink-0 items-center gap-1.5 text-[11px] tabular-nums", colour)}
      title={`${usage.tokens ?? "?"} / ${usage.contextWindow ?? "?"} tokens${compacting ? " · compacting" : ""}`}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" className={cn("shrink-0", compacting && "animate-pulse motion-reduce:animate-none")}>
        <circle cx="8" cy="8" r={radius} fill="none" strokeWidth="2" className="stroke-foreground/15" />
        <circle
          cx="8"
          cy="8"
          r={radius}
          fill="none"
          strokeWidth="2"
          strokeLinecap="round"
          className={stroke}
          strokeDasharray={`${dash} ${circumference}`}
          transform="rotate(-90 8 8)"
        />
      </svg>
      {label}%
    </span>
  );
}
