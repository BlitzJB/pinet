import { cn } from "../lib/utils";
import { useSessionState } from "../lib/context";
import { deriveRunFeedback } from "../lib/run-state";

/**
 * The agent's state at a glance, in the sidebar.
 *
 * Sourced from the session's own store, so it reports what the client actually knows
 * and nothing more: with no attachment there is no status, and this renders nothing
 * rather than guessing. A status-only attach mode would make it free for every session
 * in the list; until then it covers the ones this browser is connected to, which is
 * where you are actually working.
 */
export function SessionStatusDot({ sessionId, className }: { sessionId: string; className?: string }) {
  const state = useSessionState(sessionId);
  const status = state.status;
  if (!status) return null;

  const running = status.phase === "running" || status.isIdle === false;
  const compacting = Boolean(status.compacting);
  const failed = Boolean(state.outbox && state.outbox.status === "error");
  const feedback = deriveRunFeedback({ outbox: state.outbox, running, compacting });

  const tone = failed
    ? "bg-destructive"
    : running || compacting
      ? "bg-emerald-500"
      : feedback === "waiting"
        ? "bg-amber-400"
        : "bg-foreground/20";

  return (
    <span
      role="status"
      title={feedback ?? (running ? "working" : "idle")}
      aria-label={feedback ?? (running ? "working" : "idle")}
      className={cn("size-1.5 shrink-0 rounded-full", tone, (running || compacting) && "animate-pulse motion-reduce:animate-none", className)}
    />
  );
}
