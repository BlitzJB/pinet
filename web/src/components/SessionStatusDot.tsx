import { cn } from "../lib/utils";
import { useSessionState } from "../lib/context";

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
  if (!status) {
    // A visible placeholder rather than nothing. Rendering null was honest but made two
    // very different situations identical: a stale bundle that never ran this component
    // at all, and a component running with no status to show. A hollow ring tells them
    // apart, which is the whole reason this took several rounds to diagnose.
    return (
      <span
        role="status"
        title={state.attached ? "attached, waiting for status" : "not attached"}
        aria-label={state.attached ? "attached, waiting for status" : "not attached"}
        className={cn("size-2 shrink-0 rounded-full border border-dashed border-foreground/30", className)}
      />
    );
  }

  const running = status.phase === "running" || status.isIdle === false;
  const compacting = Boolean(status.compacting);
  const failed = Boolean(state.outbox && state.outbox.status === "error");
  const waiting = Boolean(state.outbox && state.outbox.status !== "error" && !running);

  const tone = failed
    ? "bg-destructive"
    : running || compacting
      ? "bg-emerald-500"
      : waiting
        ? "bg-amber-400"
        : "bg-foreground/40";

  return (
    <span
      role="status"
      title={failed ? "the last send failed" : running || compacting ? "working" : waiting ? "waiting on you" : "idle"}
      aria-label={failed ? "the last send failed" : running || compacting ? "working" : waiting ? "waiting on you" : "idle"}
      className={cn("size-2 shrink-0 rounded-full", tone, (running || compacting) && "animate-pulse motion-reduce:animate-none", className)}
    />
  );
}
