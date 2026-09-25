import { useState } from "react";
import { cn } from "../lib/utils";

function initialsOf(name?: string | null, email?: string | null): string {
  const source = (name?.trim() || email?.split("@")[0] || "?").trim();
  return (
    source
      .split(/\s+|[._\-+]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}

/**
 * Account avatar. Uses the OAuth profile picture (served same-origin by the
 * coordinator at /me/avatar) and falls back to initials if it is missing or
 * fails to load.
 */
export function Avatar({
  name,
  email,
  src,
  className,
}: {
  name?: string | null;
  email?: string | null;
  src?: string | null;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const base = cn(
    "grid size-8 shrink-0 place-items-center overflow-hidden rounded-full bg-foreground/[0.08] text-[11px] font-semibold text-foreground/70 ring-1 ring-inset ring-foreground/[0.06]",
    className,
  );

  if (src && !failed) {
    return <img src={src} alt="" aria-hidden onError={() => setFailed(true)} className={cn(base, "object-cover")} />;
  }
  return (
    <span aria-hidden className={base}>
      {initialsOf(name, email)}
    </span>
  );
}
