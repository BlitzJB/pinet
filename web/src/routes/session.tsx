import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { usePinet, useConnectionState, useSessionState } from "../lib/context";
import { Composer } from "../components/Composer";
import { Transcript } from "../components/Transcript";

export function SessionPage() {
  const { sessionId } = useParams({ from: "/s/$sessionId" });
  const connection = usePinet();
  const conn = useConnectionState();
  const state = useSessionState(sessionId);
  const [error, setError] = useState<string>();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Attach once the connection is up and we aren't already attached.
  useEffect(() => {
    if (conn.status !== "connected" || state.attached) return;
    let cancelled = false;
    connection.attach(sessionId, "control").catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      cancelled = true;
    };
  }, [conn.status, state.attached, sessionId, connection]);

  // Keep the transcript pinned to the newest entry.
  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [state.entries.length]);

  const busy = state.status?.phase === "running" || state.status?.isIdle === false;
  const usage = state.status?.contextUsage;
  const model = state.status?.model;

  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col">
      <div className="flex items-center gap-3 border-b border-ink-800 px-4 py-2.5">
        <Link to="/" className="text-xs text-mist-400 hover:text-mist-200">
          ← Sessions
        </Link>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-mist-200">{state.meta?.name ?? state.sessionId}</div>
          <div className="truncate text-[11px] text-mist-400">
            {state.meta?.host ?? ""}
            {state.meta?.cwd ? ` · ${state.meta.cwd}` : ""}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className={`rounded-md px-2 py-1 text-[11px] ${state.attached ? "bg-ok-400/10 text-ok-400" : "bg-ink-800 text-mist-400"}`}>
            {state.attached ? state.mode : "not attached"}
          </span>
          {busy && (
            <button
              type="button"
              onClick={() => void connection.abort(sessionId).catch(() => {})}
              className="rounded-md border border-bad-400/40 px-2.5 py-1 text-[11px] text-bad-400 hover:bg-bad-400/10"
            >
              Abort
            </button>
          )}
          <button
            type="button"
            onClick={() => void connection.compact(sessionId).catch(() => {})}
            className="rounded-md border border-ink-700 px-2.5 py-1 text-[11px] text-mist-300 hover:bg-ink-800"
          >
            Compact
          </button>
        </div>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
        {error && <div className="mb-4 rounded-lg border border-bad-400/40 bg-bad-400/10 px-3 py-2 text-xs text-bad-400">{error}</div>}
        {conn.status === "error" && (
          <div className="mb-4 rounded-lg border border-bad-400/40 bg-bad-400/10 px-3 py-2 text-xs text-bad-400">
            Not connected: {conn.error}
          </div>
        )}
        <Transcript entries={state.entries} />
      </div>

      <div className="flex items-center gap-4 border-t border-ink-800 bg-ink-900/60 px-4 py-1.5 text-[11px] text-mist-400">
        <span className={state.status?.phase === "running" ? "text-warn-400" : "text-mist-400"}>{state.status?.phase ?? "unknown"}</span>
        {model && <span>{model.provider}/{model.id}</span>}
        {state.status?.thinkingLevel && <span>thinking: {state.status.thinkingLevel}</span>}
        {usage?.percent != null && <span className="ml-auto">{usage.percent.toFixed(1)}% context</span>}
      </div>

      <Composer
        disabled={!state.attached}
        busy={busy}
        onSend={(text) => connection.prompt(sessionId, text)}
        onAbort={() => void connection.abort(sessionId).catch(() => {})}
      />
    </div>
  );
}
