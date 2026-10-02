import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeftIcon, Minimize2Icon, SendIcon, SquareIcon } from "lucide-react";
import { useConnectionState, usePiNet, useSessionState } from "../lib/context";
import { groupSessionsByHost } from "../lib/session-groups";
import { deriveRunFeedback } from "../lib/run-state";
import { RunIndicator } from "../components/thread/RunIndicator";
import { cn } from "../lib/utils";

/** How many sessions to hold live status for. Each one is an attachment. */
const LIVE_LIMIT = 12;

/**
 * A status board for a screen that is left on: every session, what it is doing,
 * and a way to say something to it.
 *
 * Live state comes from the ordinary status frames — attaching to a session is
 * what starts them, and once attached the updates are small, so there is no
 * polling here beyond the catalog (which is what discovers new sessions).
 *
 * Deliberately its own route rather than a mode of the session list: open
 * /app/status in the installed app, and it fills the screen.
 */
export function StatusPage() {
  const connection = usePiNet();
  const conn = useConnectionState();
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: () => connection.list(), refetchInterval: 5_000 });
  const sessions = useMemo(() => catalog.data ?? [], [catalog.data]);
  const groups = useMemo(() => groupSessionsByHost(sessions), [sessions]);

  const [now, setNow] = useState(() => new Date());
  const [awake, setAwake] = useState(true);

  // Attaching is what makes a session report status, so the board attaches to
  // everything it shows. Bounded, and only once per session.
  useEffect(() => {
    for (const session of sessions.slice(0, LIVE_LIMIT)) {
      if (!connection.store(session.sessionId).get().attached) {
        void connection.attach(session.sessionId, "control").catch(() => {});
      }
    }
  }, [connection, sessions]);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1_000);
    return () => clearInterval(timer);
  }, []);

  // Screen Wake Lock: the point of the page is to stay visible. Chrome and
  // Safari 16.4+ support it; elsewhere the page still works, the screen just sleeps.
  useEffect(() => {
    if (!awake) return;
    type Sentinel = { release?: () => Promise<void> };
    let lock: Sentinel | undefined;
    const acquire = async () => {
      try {
        const wakeLock = (navigator as unknown as { wakeLock?: { request: (type: string) => Promise<Sentinel> } }).wakeLock;
        lock = await wakeLock?.request("screen");
      } catch {
        /* unsupported or refused */
      }
    };
    void acquire();
    const onVisible = () => {
      if (document.visibilityState === "visible") void acquire();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      void lock?.release?.();
    };
  }, [awake]);

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center gap-3 border-b border-border/50 px-4 py-3">
        <Link to="/" className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground" title="Sessions">
          <ArrowLeftIcon className="size-4" />
        </Link>
        <h1 className="text-[15px] font-medium tracking-tight">Status</h1>
        <span className="text-[12px] text-muted-foreground/60">
          {sessions.length} session{sessions.length === 1 ? "" : "s"}
          {conn.status !== "connected" && ` · ${conn.status}`}
        </span>
        <div className="ms-auto flex items-center gap-3">
          <button
            type="button"
            onClick={() => setAwake((value) => !value)}
            className={cn(
              "rounded-full px-2.5 py-1 text-[11.5px] transition-colors",
              awake ? "bg-foreground/[0.06] text-foreground/80" : "text-muted-foreground hover:bg-foreground/[0.05]",
            )}
            title="Keep the screen awake while this page is open"
          >
            {awake ? "screen: awake" : "screen: normal"}
          </button>
          <time className="text-[13px] tabular-nums text-muted-foreground/70">{now.toLocaleTimeString()}</time>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {groups.length === 0 && (
          <p className="mt-16 text-center text-[13px] text-muted-foreground/60">
            {conn.status === "connected" ? "No sessions" : "Connecting…"}
          </p>
        )}
        <div className="mx-auto grid max-w-[100rem] gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {groups.map((group) => (
            <div key={group.hostId} className="space-y-2">
              <div className="flex items-center gap-2 px-1">
                <span className={cn("size-1.5 rounded-full", group.hostConnected ? "bg-emerald-500" : "bg-foreground/25")} />
                <h2 className="truncate text-[12.5px] text-muted-foreground" title={group.hostId}>
                  {group.hostName}
                </h2>
              </div>
              {group.sessions.map((session) => (
                <SessionCard key={session.sessionId} sessionId={session.sessionId} name={session.meta?.name ?? session.sessionId.slice(0, 8)} host={session.hostName ?? ""} cwd={session.meta?.cwd ?? ""} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SessionCard({ sessionId, name, cwd }: { sessionId: string; name: string; cwd: string; host: string }) {
  const connection = usePiNet();
  const state = useSessionState(sessionId);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const running = state.status?.phase === "running" || state.status?.isIdle === false;
  const feedback = deriveRunFeedback({ outbox: null, running, compacting: Boolean(state.status?.compacting) });
  const context = state.status?.contextUsage;
  const model = state.status?.model;

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
    } catch {
      /* the next status frame will tell the truth */
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={cn("rounded-2xl border bg-foreground/[0.02] p-3", running ? "border-blue-500/25" : "border-border/50")}>
      <div className="flex items-start gap-2">
        <Link to="/s/$sessionId" params={{ sessionId }} className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-medium leading-tight">{name}</p>
          <p className="truncate text-[11px] text-muted-foreground/60" title={cwd}>
            {cwd || "—"}
          </p>
        </Link>
        <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground/50">
          {typeof context?.percent === "number" ? `${Math.round(context.percent)}%` : ""}
        </span>
      </div>

      <div className="mt-2 min-h-5">
        {feedback ? (
          <RunIndicator feedback={feedback} />
        ) : (
          <span className="text-[12px] text-muted-foreground/45">{model?.name ?? "idle"}</span>
        )}
      </div>

      <form
        className="mt-2 flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          const value = text.trim();
          if (!value) return;
          setText("");
          void act(() => connection.prompt(sessionId, value));
        }}
      >
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Say something…"
          className="min-w-0 flex-1 rounded-lg border border-border/50 bg-background px-2 py-1.5 text-[12.5px] outline-none focus:border-foreground/25"
        />
        <button
          type="submit"
          disabled={busy || !text.trim()}
          className="grid size-7 shrink-0 place-items-center rounded-lg bg-foreground text-background transition-opacity hover:opacity-90 disabled:opacity-25"
          title="Send"
        >
          <SendIcon className="size-3.5" />
        </button>
      </form>

      <div className="mt-1.5 flex items-center gap-1.5">
        <button
          type="button"
          disabled={busy}
          onClick={() => void act(() => connection.prompt(sessionId, "continue"))}
          className="rounded-full px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-40"
        >
          Continue
        </button>
        <button
          type="button"
          disabled={busy || !running}
          onClick={() => void act(() => connection.abort(sessionId))}
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-40"
          title="Stop the current run"
        >
          <SquareIcon className="size-2.5 fill-current" />
          Stop
        </button>
        <button
          type="button"
          disabled={busy || running}
          onClick={() => void act(() => connection.compact(sessionId))}
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-40"
          title="Compact context"
        >
          <Minimize2Icon className="size-3" />
          Compact
        </button>
      </div>
    </div>
  );
}
