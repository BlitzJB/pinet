import { XIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import { useSessionState } from "../../lib/context";
import { usePanes } from "../../lib/use-panes";
import { ThreadView } from "./ThreadView";

/** Thin chrome identifying each pane once more than one is open. */
function PaneHeader({ sessionId }: { sessionId: string }) {
  const { close } = usePanes();
  const state = useSessionState(sessionId);
  const name = state.meta?.name ?? `${sessionId.slice(0, 8)}…`;
  const host = state.meta?.host;

  return (
    <header className="flex h-8 shrink-0 items-center gap-2 border-b border-border/60 bg-background/70 px-2.5 backdrop-blur">
      <span
        aria-hidden
        className={cn("size-1.5 shrink-0 rounded-full", state.attached ? "bg-emerald-500" : "bg-foreground/25")}
        title={state.attached ? "attached" : "not attached"}
      />
      <span className="min-w-0 flex-1 truncate text-[12px] text-foreground/80">{name}</span>
      {host && <span className="hidden shrink-0 truncate text-[11px] text-muted-foreground/60 sm:inline">{host}</span>}
      <button
        type="button"
        aria-label={`Close ${name}`}
        title="Close pane"
        onClick={() => close(sessionId)}
        className="-me-1 grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground/60 transition-colors hover:bg-foreground/[0.08] hover:text-foreground"
      >
        <XIcon className="size-3.5" />
      </button>
    </header>
  );
}

/**
 * One or more live sessions side by side (stacked on narrow screens). Each pane
 * owns its own attachment, composer and scroll container, so panes are genuinely
 * independent — closing one never disturbs the others.
 */
export function SessionPanes() {
  const { panes } = usePanes();
  const showHeaders = panes.length > 1;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col md:flex-row">
      {panes.map((id, index) => (
        <div
          key={id}
          className={cn(
            "flex min-h-0 min-w-0 flex-1 flex-col",
            index > 0 && "border-t border-border/60 md:border-t-0 md:border-s",
          )}
        >
          {showHeaders && <PaneHeader sessionId={id} />}
          <div className="min-h-0 min-w-0 flex-1">
            <ThreadView key={id} sessionId={id} />
          </div>
        </div>
      ))}
    </div>
  );
}
