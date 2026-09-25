import { useEffect, useRef, useState } from "react";
import { ArrowDownIcon, Loader2Icon } from "lucide-react";
import { cn } from "../../lib/utils";
import { useConnectionState, usePinet, useSessionState } from "../../lib/context";
import { deriveRunFeedback } from "../../lib/run-state";
import { ghostButton } from "../ui/surfaces";
import { ThreadMessages } from "./Message";
import { Composer } from "./Composer";
import { ConnectionState } from "./ConnectionState";
import { RunIndicator } from "./RunIndicator";

const SUGGESTIONS = [
  "Summarize the current state of this session",
  "What files have changed so far?",
  "Run the test suite and report back",
  "Explain the last change you made",
];

/** Show a flag only once it has stayed true past `delay` (avoids flicker). */
function useDelayedTrue(value: boolean, delay: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!value) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return shown;
}

function Welcome({ name, onPrompt }: { name?: string | null; onPrompt: (text: string) => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 py-16 text-center">
      <div className="fade-in slide-in-from-bottom-1 animate-in fill-mode-both flex flex-col gap-2 duration-300 motion-reduce:animate-none">
        <h1 className="text-2xl font-semibold tracking-tight">{name ?? "Pinet session"}</h1>
        <p className="text-muted-foreground">Ask the remote agent anything, or pick a starter.</p>
      </div>
      <div className="flex w-full max-w-md flex-col gap-2">
        {SUGGESTIONS.map((suggestion, index) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => onPrompt(suggestion)}
            style={{ animationDelay: `${index * 60}ms` }}
            className="fade-in slide-in-from-bottom-2 animate-in fill-mode-both flex cursor-pointer items-baseline gap-2.5 rounded-xl border border-border/60 px-3.5 py-2.5 text-start text-sm transition-[transform,background-color] duration-200 hover:-translate-y-px hover:bg-foreground/[0.03] active:scale-[0.98] motion-reduce:animate-none"
          >
            <span aria-hidden className="font-mono text-xs text-muted-foreground/60">
              {">"}
            </span>
            <span>{suggestion}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function ThreadView({ sessionId }: { sessionId: string }) {
  const connection = usePinet();
  const conn = useConnectionState();
  const state = useSessionState(sessionId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const refreshing = useDelayedTrue(Boolean(state.syncing), 250);

  useEffect(() => {
    if (conn.status !== "connected" || state.attached) return;
    let cancelled = false;
    connection.attach(sessionId, "control").catch(() => {
      if (!cancelled) {
        /* surfaced through connection state */
      }
    });
    return () => {
      cancelled = true;
    };
  }, [conn.status, state.attached, sessionId, connection]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element && atBottom) element.scrollTop = element.scrollHeight;
  }, [state.entries.length, atBottom]);

  const running = state.status?.phase === "running" || state.status?.isIdle === false;
  const model = state.status?.model;
  const runningTools = Array.isArray(state.status?.runningTools) ? state.status.runningTools.length : 0;
  const feedback = deriveRunFeedback({
    outbox: state.outbox,
    running,
    runningTools,
    entryCount: state.entries.length,
    compacting: Boolean(state.status?.compacting),
  });
  const cwd = state.meta?.cwd;

  return (
    <div className="relative flex h-full flex-col">
      {/* Transient indicator; opacity-only so it never shifts layout. */}
      <div className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center px-4">
        <div
          role="status"
          aria-hidden={!refreshing}
          className={cn(
            "flex items-center gap-2 rounded-full border border-border/60 bg-background/85 px-3 py-1.5 text-[11px] text-muted-foreground shadow-sm backdrop-blur transition-opacity duration-200 motion-reduce:transition-none",
            refreshing ? "opacity-100" : "opacity-0",
          )}
        >
          <Loader2Icon className="size-3 animate-spin motion-reduce:animate-none" />
          Refreshing…
        </div>
      </div>
      <div
        ref={scrollRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          setAtBottom(element.scrollHeight - element.scrollTop - element.clientHeight < 40);
        }}
        className="relative flex-1 overflow-y-auto scroll-smooth"
      >
        <div className="mx-auto flex w-full max-w-[44rem] flex-1 flex-col px-4 pt-6 pb-4">
          {state.entries.length === 0 ? (
            <Welcome name={state.meta?.name} onPrompt={(text) => void connection.prompt(sessionId, text)} />
          ) : (
            <ThreadMessages entries={state.entries} running={running} />
          )}
          <div className="pt-1">
            <RunIndicator feedback={feedback} />
          </div>
        </div>
        {!atBottom && (
          <button
            type="button"
            aria-label="Scroll to bottom"
            onClick={() => {
              const element = scrollRef.current;
              if (element) element.scrollTop = element.scrollHeight;
            }}
            className={cn(ghostButton, "absolute bottom-4 left-1/2 -translate-x-1/2 border border-border/60 bg-background p-2.5 shadow-lg dark:bg-popover")}
          >
            <ArrowDownIcon className="size-4" />
          </button>
        )}
      </div>

      <div className="bg-background/80 backdrop-blur pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto flex w-full max-w-[44rem] flex-col gap-1.5 px-4 pt-2 pb-1.5">
          <ConnectionState status={conn.status} error={conn.error} />
          <Composer
            busy={running}
            disabled={!state.attached}
            attached={state.attached}
            mode={state.mode}
            model={model}
            thinkingLevel={state.status?.thinkingLevel}
            contextUsage={state.status?.contextUsage}
            compacting={Boolean(state.status?.compacting)}
            onSend={(text) => connection.prompt(sessionId, text)}
            onStop={() => void connection.abort(sessionId).catch(() => {})}
            onCompact={() => void connection.compact(sessionId).catch(() => {})}
            onThinking={(level) => void connection.setThinking(sessionId, level).catch(() => {})}
          />
          {cwd && (
            <div className="truncate px-1 text-center text-[11px] leading-tight text-muted-foreground/50" title={cwd}>
              {cwd}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
