import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDownIcon, Loader2Icon } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "../../lib/utils";
import { useConnectionState, usePinet, useSessionState } from "../../lib/context";
import { deriveRunFeedback } from "../../lib/run-state";
import { ghostButton } from "../ui/surfaces";
import { groupEntries, MessageGroup } from "./Message";
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

function StartingSession({ name }: { name?: string | null }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
      <Loader2Icon className="size-5 animate-spin text-muted-foreground motion-reduce:animate-none" />
      <h1 className="text-lg font-medium">{name ?? "Starting session"}</h1>
      <p className="text-sm text-muted-foreground">Waiting for the host to register…</p>
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const attempt = async () => {
      try {
        await connection.attach(sessionId, "control");
      } catch {
        if (cancelled) return;
        attempts += 1;
        // A freshly spawned session may not have registered yet; keep trying.
        if (attempts < 20) timer = setTimeout(() => void attempt(), 1000);
      }
    };
    void attempt();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [conn.status, state.attached, sessionId, connection]);

  const running = state.status?.phase === "running" || state.status?.isIdle === false;
  const model = state.status?.model;
  const feedback = deriveRunFeedback({
    outbox: state.outbox,
    running,
    compacting: Boolean(state.status?.compacting),
  });
  const cwd = state.meta?.cwd;

  // --- virtualization ------------------------------------------------------
  // Only rows near the viewport are mounted, so re-layout (resize, expand,
  // streaming) stays O(viewport) instead of O(whole thread).
  const groups = useMemo(() => groupEntries(state.entries), [state.entries]);
  const tailIndex = groups.length;
  const rowCount = groups.length + 1; // + the run-indicator row
  const getItemKey = useCallback(
    (index: number) => (index < groups.length ? groups[index].key : "__tail__"),
    [groups],
  );

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 120,
    overscan: 8,
    getItemKey,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  // Keep the view pinned to the newest message while the user is at the bottom.
  // Re-runs when measured heights settle so a growing thread stays anchored.
  useLayoutEffect(() => {
    if (!atBottom) return;
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [state.entries.length, atBottom, totalSize]);

  const scrollToBottom = useCallback((smooth: boolean) => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    setAtBottom(true);
  }, []);

  const empty = state.entries.length === 0;

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

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={(event) => {
            const element = event.currentTarget;
            setAtBottom(element.scrollHeight - element.scrollTop - element.clientHeight < 40);
          }}
          className="h-full overflow-y-auto"
        >
          {empty ? (
            <div className="mx-auto flex w-full max-w-[44rem] flex-col px-4 pt-6 pb-4">
              {!state.attached && conn.status === "connected" ? (
                <StartingSession name={state.meta?.name} />
              ) : (
                <Welcome name={state.meta?.name} onPrompt={(text) => void connection.prompt(sessionId, text)} />
              )}
              <RunIndicator feedback={feedback} />
            </div>
          ) : (
            <div className="mx-auto w-full max-w-[44rem] px-4 pt-6 pb-4">
              <div className="relative w-full" style={{ height: `${totalSize}px` }}>
                {virtualItems.map((item) => {
                  const isTail = item.index >= tailIndex;
                  return (
                    <div
                      key={item.key}
                      data-index={item.index}
                      ref={virtualizer.measureElement}
                      className="absolute inset-x-0 top-0 pb-8"
                      style={{ transform: `translateY(${item.start}px)` }}
                    >
                      {isTail ? (
                        <div className="pt-1">
                          <RunIndicator feedback={feedback} />
                        </div>
                      ) : (
                        <MessageGroup group={groups[item.index]} running={running && item.index === tailIndex - 1} />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {!atBottom && (
          <button
            type="button"
            aria-label="Scroll to bottom"
            onClick={() => scrollToBottom(true)}
            className={cn(
              ghostButton,
              "absolute bottom-4 left-1/2 z-10 -translate-x-1/2 border border-border/60 bg-background p-2.5 shadow-lg dark:bg-popover",
            )}
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
            onModel={(provider, modelId, name) => void connection.setModel(sessionId, provider, modelId, name).catch(() => {})}
            loadModels={(options) => connection.listModels(sessionId, options)}
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
