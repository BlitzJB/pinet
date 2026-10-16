import { MessageSquareIcon } from "lucide-react";
import { cn } from "../lib/utils";
import { useSessionState } from "../lib/context";

/**
 * The session's chat icon is also its status.
 *
 * Same semantics the separate dot had — colour for state, a pulse while working — but
 * carried by an icon that was already in the row, so there is one indicator instead of
 * two competing for the same space. It stays a component because the status hook cannot
 * be called from inside the list's map.
 *
 * With no status it stays a quiet icon rather than disappearing: the row still needs an
 * icon, and a missing one would read as a missing session.
 */
export function SessionStatusIcon({ sessionId, className }: { sessionId: string; className?: string }) {
  const state = useSessionState(sessionId);
  const status = state.status;

  const running = Boolean(status) && (status.phase === "running" || status.isIdle === false);
  const compacting = Boolean(status?.compacting);
  const failed = Boolean(state.outbox && state.outbox.status === "error");
  const waiting = Boolean(status) && !running && !compacting && Boolean(state.outbox && state.outbox.status !== "error");

  const tone = !status
    ? "text-muted-foreground/40"
    : failed
      ? "text-destructive"
      : running || compacting
        ? "text-emerald-500"
        : waiting
          ? "text-amber-400"
          : "text-muted-foreground";

  const label = !status
    ? state.attached
      ? "attached, waiting for status"
      : "not attached"
    : failed
      ? "the last send failed"
      : running || compacting
        ? "working"
        : waiting
          ? "waiting on you"
          : "idle";

  return (
    <MessageSquareIcon
      role="status"
      aria-label={label}
      title={label}
      className={cn(
        "size-3.5 shrink-0",
        tone,
        (running || compacting) && "animate-pulse motion-reduce:animate-none",
        className,
      )}
    />
  );
}
