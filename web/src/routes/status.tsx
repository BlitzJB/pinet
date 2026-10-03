import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronDownIcon, MessageSquareIcon, SendIcon, XIcon } from "lucide-react";
import { getMe } from "../lib/api";
import { useConnectionState, usePiNet, useSessionState } from "../lib/context";
import { groupSessionsByHost } from "../lib/session-groups";
import { deriveRunFeedback } from "../lib/run-state";
import { parseSummary, useRunSummary, type SummaryLabel } from "../lib/summaries";
import { RunIndicator } from "../components/thread/RunIndicator";
import { cn } from "../lib/utils";

/** How many sessions to hold live status for. Each one is an attachment. */
const LIVE_LIMIT = 12;

/**
 * A board for a screen that is left on: every session, what it is doing, and what
 * it last did.
 *
 * No chrome. There is no header, no navigation and no per-card controls — you go
 * into a session from the sidebar when you actually want to work in it. The only
 * interaction is the message icon, which turns a card into an input, because the
 * one thing worth doing from across the room is saying something to a session.
 *
 * Live state comes from the ordinary status frames: attaching is what starts them,
 * so there is no polling beyond the catalog that discovers new sessions.
 */
export function StatusPage() {
  const connection = usePiNet();
  const conn = useConnectionState();
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: () => connection.list(), refetchInterval: 5_000 });
  const sessions = useMemo(() => catalog.data ?? [], [catalog.data]);
  const groups = useMemo(() => groupSessionsByHost(sessions), [sessions]);
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: getMe, staleTime: 300_000 });

  // Attaching is what makes a session report status, so the board attaches to
  // everything it shows. Bounded, and only once per session.
  useEffect(() => {
    for (const session of sessions.slice(0, LIVE_LIMIT)) {
      if (!connection.store(session.sessionId).get().attached) {
        void connection.attach(session.sessionId, "control").catch(() => {});
      }
    }
  }, [connection, sessions]);

  // Screen Wake Lock, always on: a board that lets the screen sleep is pointless.
  // Chrome and Safari 16.4+ support it; elsewhere it degrades to nothing.
  useEffect(() => {
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
  }, []);

  const reconnecting = conn.status !== "connected";
  // Nothing yet, and nothing wrong: the catalog is in flight, or it arrived empty
  // and the attachments are still warming up.
  const warming = catalog.isLoading || (sessions.length === 0 && !catalog.isError);

  return (
    <div className="h-dvh overflow-y-auto bg-background p-4 text-foreground">
      {/* Reconnecting freezes the board rather than emptying it: muted, pulsing. */}
      {reconnecting && (
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 z-10 animate-pulse bg-background/50 motion-reduce:animate-none"
        />
      )}
      <div
        className={cn(
          "mx-auto grid max-w-[100rem] gap-4 transition-opacity duration-300 sm:grid-cols-2 xl:grid-cols-3",
          reconnecting && "pointer-events-none opacity-35",
        )}
      >
        {warming && Array.from({ length: 3 }, (_, index) => <SkeletonCard key={index} />)}
        {!warming && sessions.length === 0 && (
          <p className="col-span-full mt-24 text-center text-[13px] text-muted-foreground/50">No sessions</p>
        )}
        {groups.map((group) => (
          <div key={group.hostId} className="space-y-2">
            <div className="flex items-center gap-2 px-1">
              <span className={cn("size-1.5 rounded-full", group.hostConnected ? "bg-emerald-500" : "bg-foreground/25")} />
              <h2 className="truncate text-[12.5px] text-muted-foreground" title={group.hostId}>
                {group.hostName}
              </h2>
            </div>
            {group.sessions.map((session) => (
              <SessionCard
                key={session.sessionId}
                sessionId={session.sessionId}
                name={session.meta?.name ?? session.sessionId.slice(0, 8)}
                cwd={session.meta?.cwd ?? ""}
                summaries={Boolean(me?.summary?.enabled)}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** A card that has not loaded yet: the same silhouette, pulsing, with no content. */
function SkeletonCard() {
  return (
    <div className="animate-pulse rounded-2xl border border-border/40 p-3 motion-reduce:animate-none">
      <div className="flex items-center gap-2">
        <div className="h-3 w-16 rounded bg-foreground/[0.07]" />
        <div className="ms-auto h-3 w-8 rounded bg-foreground/[0.05]" />
      </div>
      <div className="mt-3 space-y-1.5">
        <div className="h-3 w-11/12 rounded bg-foreground/[0.05]" />
        <div className="h-3 w-2/3 rounded bg-foreground/[0.04]" />
      </div>
    </div>
  );
}

/** The label answers "does this need me?", so it is the loud part of the card. */
function LabelChip({ label }: { label: SummaryLabel }) {
  const tone =
    label === "Waiting"
      ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
      : label === "Blocked"
        ? "bg-red-500/15 text-red-600 dark:text-red-400"
        : label === "Done"
          ? "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400"
          : "bg-foreground/[0.06] text-muted-foreground";
  return (
    <span className={cn("shrink-0 rounded px-1.5 py-[1.5px] text-[9.5px] font-medium uppercase tracking-wide", tone)}>{label}</span>
  );
}

function SessionCard({
  sessionId,
  name,
  cwd,
  summaries,
}: {
  sessionId: string;
  name: string;
  cwd: string;
  summaries: boolean;
}) {
  const connection = usePiNet();
  const state = useSessionState(sessionId);
  const [expanded, setExpanded] = useState(false);
  const [composing, setComposing] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const running = state.status?.phase === "running" || state.status?.isIdle === false;
  const feedback = deriveRunFeedback({ outbox: null, running, compacting: Boolean(state.status?.compacting) });
  const { text: summary, previous } = useRunSummary(sessionId, state.entries, summaries && !running);
  const { labels, body } = parseSummary(summary);
  const context = state.status?.contextUsage;
  const model = state.status?.model;

  useEffect(() => {
    if (composing) inputRef.current?.focus();
  }, [composing]);

  async function send() {
    const value = text.trim();
    if (!value) return;
    setSending(true);
    try {
      await connection.prompt(sessionId, value);
      setText("");
      setComposing(false);
    } catch {
      /* the next status frame tells the truth */
    } finally {
      setSending(false);
    }
  }

  // Whether the summary is worth an expander. Approximate: measuring would mean
  // rendering it unclamped first.
  // Roughly three lines at this width; measuring would mean rendering it unclamped.
  const long = body.join(" ").length > 150;

  return (
    <div
      className={cn(
        "rounded-2xl border bg-foreground/[0.02] p-3 transition-[border-color,box-shadow] duration-200",
        running ? "border-blue-500/25" : "border-border/50",
        composing && "border-foreground/25 shadow-lg shadow-black/10",
      )}
    >
      {/* The percentage and the message icon ride with the title, so a card with no
          label has no empty row above it. */}
      <div className="flex items-start gap-2">
        <Link to="/s/$sessionId" params={{ sessionId }} className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-medium leading-tight">{name}</p>
          <p className="truncate text-[11px] text-muted-foreground/55" title={cwd}>
            {cwd || "—"}
          </p>
        </Link>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="text-[10.5px] tabular-nums text-muted-foreground/50">
            {typeof context?.percent === "number" ? `${Math.round(context.percent)}%` : ""}
          </span>
          <button
            type="button"
            onClick={() => setComposing((value) => !value)}
            className={cn(
              "grid size-6 place-items-center rounded-lg transition-colors",
              composing ? "bg-foreground text-background" : "text-muted-foreground/60 hover:bg-foreground/[0.06] hover:text-foreground",
            )}
            title={composing ? "Cancel" : `Message ${name}`}
            aria-label={composing ? "Cancel message" : `Message ${name}`}
          >
            {composing ? <XIcon className="size-3.5" /> : <MessageSquareIcon className="size-3.5" />}
          </button>
        </div>
      </div>

      {composing ? (
        <form
          className="mt-2"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <textarea
            ref={inputRef}
            value={text}
            rows={2}
            disabled={sending}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              } else if (event.key === "Escape") {
                event.preventDefault();
                setComposing(false);
                setText("");
              }
            }}
            placeholder={`Message to ${name}`}
            className="w-full resize-none rounded-lg border border-border/50 bg-background px-2 py-1.5 text-[12.5px] outline-none focus:border-foreground/25"
          />
          <div className="mt-1 flex items-center justify-end">
            <button
              type="submit"
              disabled={sending || !text.trim()}
              className="inline-flex items-center gap-1 rounded-lg bg-foreground px-2 py-1 text-[11.5px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-25"
            >
              <SendIcon className="size-3" />
              Send
            </button>
          </div>
        </form>
      ) : (
        <div className="mt-2">
          {feedback ? (
            <RunIndicator feedback={feedback} />
          ) : summary ? (
            <>
              {labels.length > 0 && (
                <div className="mb-1 flex flex-wrap items-center gap-1">
                  {labels.map((label) => (
                    <LabelChip key={label} label={label} />
                  ))}
                </div>
              )}
              {/* One paragraph, so the browser wraps it: long identifiers and URLs
                  must not push the card wider than the grid. Clamped by line count
                  rather than height, so it cannot grow past three lines. */}
              <div className="relative">
                <p
                  className={cn(
                    "text-[12.5px] leading-snug text-muted-foreground/75 [overflow-wrap:anywhere]",
                    !expanded && long && "line-clamp-3",
                  )}
                >
                  {body.join(" ")}
                </p>
                {!expanded && long && (
                  <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-4 bg-gradient-to-t from-background to-transparent" />
                )}
              </div>
              {long && (
                <button
                  type="button"
                  onClick={() => setExpanded((value) => !value)}
                  className="mt-0.5 inline-flex items-center gap-0.5 rounded-md px-1 py-0.5 text-[10.5px] text-muted-foreground/60 shadow-sm transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
                  aria-expanded={expanded}
                >
                  <ChevronDownIcon className={cn("size-3 transition-transform duration-200", expanded && "rotate-180")} />
                  {expanded ? "Less" : "More"}
                </button>
              )}
              {previous.length > 0 && (
                <div className="mt-2 border-t border-border/40 pt-1.5">
                  <p className="text-[9.5px] uppercase tracking-wide text-muted-foreground/40">Previously</p>
                  {previous.slice(0, 2).map((line, index) => (
                    <p key={index} className="line-clamp-1 text-[11px] text-muted-foreground/45 [overflow-wrap:anywhere]" title={line}>
                      {parseSummary(line).body.join(" ")}
                    </p>
                  ))}
                </div>
              )}
            </>
          ) : (
            <span className="text-[12px] text-muted-foreground/45">{model?.name ?? "idle"}</span>
          )}
        </div>
      )}
    </div>
  );
}
