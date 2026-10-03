import { useEffect, useMemo, useState } from "react";
import { summarizeExchange } from "./api";
import { Store, useStore } from "./store";

/**
 * One-line summaries of finished runs, cached per run.
 *
 * Keyed by the id of the run's final assistant entry, so each run is summarised
 * once and reused until the session moves on. Kept in localStorage rather than on
 * the hub: it describes session content, and `meta` — which the hub reads in the
 * clear so it can track names and directories — is deliberately not where this
 * goes. The hub sees the last exchange once, when the line is generated.
 */
const STORAGE_KEY = "pinet.runSummaries.v2";
/**
 * How long a session must be quiet before it is summarised.
 *
 * The key is the final assistant entry, so without this a summary would be written
 * after every single turn — an agent that takes six turns to finish a task would
 * cost six calls, and five of them would describe work that was not finished. A
 * quiet period means one line per finished stretch of work instead.
 */
export const SUMMARY_QUIET_MS = 3 * 60_000;
const HISTORY = 5;

export interface RunSummary {
  /** The final assistant entry id this line describes. */
  at: string;
  text: string;
}

function load(): Record<string, RunSummary[]> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, RunSummary[]>;
    if (!raw || typeof raw !== "object") return {};
    // Tolerate the single-entry shape from the first version.
    for (const [id, value] of Object.entries(raw)) {
      if (!Array.isArray(value)) {
        const legacy = value as unknown as RunSummary;
        raw[id] = legacy?.text ? [legacy] : [];
      }
    }
    return raw;
  } catch {
    return {};
  }
}

export const summaryStore = new Store<{ bySession: Record<string, RunSummary[]> }>({ bySession: load() });

/** Newest first, one entry per run, capped. Pure so the ordering is testable. */
export function pushSummary(list: RunSummary[] | undefined, entry: RunSummary, max = HISTORY): RunSummary[] {
  const without = (list ?? []).filter((existing) => existing.at !== entry.at);
  return [entry, ...without].slice(0, max);
}

const LABELS = ["Done", "Answered", "Waiting", "Blocked", "No changes"] as const;
export type SummaryLabel = (typeof LABELS)[number];

/**
 * Split the leading labels off a summary, so the list can show whether the session
 * needs you before you read a word. Models sometimes return more than one
 * ("Waiting, Blocked — …"), which is useful: the most urgent is shown first.
 */
export function parseSummary(text: string | undefined): { labels: SummaryLabel[]; body: string[] } {
  const lines = String(text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return { labels: [], body: [] };

  const labels: SummaryLabel[] = [];
  let head = lines[0];
  for (;;) {
    // Separators may lead: "Waiting, Blocked — …" leaves a comma in front.
    const candidate = head.replace(/^[\s,/&+\u2014-]+/, "");
    const match = /^(Done|Answered|Waiting|Blocked|No changes)\b/i.exec(candidate);
    if (!match) break;
    const label = LABELS.find((entry) => entry.toLowerCase() === match[1].toLowerCase());
    if (!label) break;
    // A repeat is consumed rather than left in the body, but only shown once.
    if (!labels.includes(label)) labels.push(label);
    head = candidate.slice(match[0].length).replace(/^[\s,:\u2014-]+/, "").trim();
    if (!head) break;
  }

  const body = [head, ...lines.slice(1)].filter(Boolean);
  return { labels, body: body.length ? body : [lines[0]] };
}

summaryStore.subscribe(() => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(summaryStore.get().bySession));
  } catch {
    /* quota or blocked storage: the line still shows for this page's lifetime */
  }
});

const inflight = new Set<string>();

/** Generate once per run. Safe to call on every render. */
export function ensureSummary(sessionId: string, at: string, user: string, assistant: string): void {
  if (summaryStore.get().bySession[sessionId]?.some((entry) => entry.at === at)) return;
  if (inflight.has(sessionId)) return;
  inflight.add(sessionId);
  void summarizeExchange(user, assistant)
    .then(({ summary }) => {
      if (!summary) return;
      summaryStore.set((state) => ({ bySession: { ...state.bySession, [sessionId]: pushSummary(state.bySession[sessionId], { at, text: summary }) } }));
    })
    .catch(() => {
      /* the list just keeps showing the session's name */
    })
    .finally(() => inflight.delete(sessionId));
}

interface SummaryEntry {
  /** Absent on an optimistic local echo, which is never a run's final entry. */
  id?: string;
  kind?: string;
  text?: string;
  /** Epoch milliseconds on the client's entries, ISO string on the wire. */
  timestamp?: string | number;
}

/**
 * Whether a session's work is finished and worth describing.
 *
 * Preferred signal: the host reports when pi's agent settled. If that is at or
 * after the last entry written, the run is complete — so the summary can be
 * generated immediately, with nothing to wait for. The quiet period is only a
 * fallback for hosts that do not publish it yet.
 */
export function isRunComplete(
  { running, settledAt, entries }: { running: boolean; settledAt?: number | null; entries: SummaryEntry[] },
  quietMs = SUMMARY_QUIET_MS,
  now = Date.now(),
): boolean {
  if (running) return false;
  const stamp = entries?.[entries.length - 1]?.timestamp;
  const lastAt = typeof stamp === "number" ? stamp : stamp ? Date.parse(stamp) : undefined;
  if (typeof settledAt === "number" && Number.isFinite(settledAt)) {
    // Settled before the newest entry means more work happened afterwards.
    return lastAt === undefined || !Number.isFinite(lastAt) || settledAt >= lastAt;
  }
  return isSettled(entries, quietMs, now);
}

/** True when the session has stopped working long enough to be worth describing. */
export function isSettled(entries: SummaryEntry[], quietMs = SUMMARY_QUIET_MS, now = Date.now()): boolean {
  const last = entries?.[entries.length - 1]?.timestamp;
  if (last === undefined || last === null) return true;
  const at = typeof last === "number" ? last : Date.parse(last);
  return !Number.isFinite(at) || now - at >= quietMs;
}

/**
 * The last exchange: the final assistant reply that has text, and the user message
 * that prompted it. Nothing else — the hub only ever needs this much.
 */
export function lastExchange(entries: SummaryEntry[]): { at: string; user: string; assistant: string } | undefined {
  let assistant: { id: string; text: string; index: number } | undefined;
  for (let i = (entries?.length ?? 0) - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.kind === "assistant" && entry.id && entry.text?.trim()) {
      assistant = { id: entry.id, text: entry.text, index: i };
      break;
    }
  }
  if (!assistant) return undefined;
  // The prompt for *that* reply, not merely the last user entry: an optimistic
  // local echo sits after the reply and belongs to the next turn.
  let user = "";
  for (let i = assistant.index - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.kind === "user" && entry.text?.trim()) {
      user = entry.text;
      break;
    }
  }
  return { at: assistant.id, user, assistant: assistant.text };
}

/** The line for a session's current run (generating it if needed) and the ones before it. */
export function useRunSummary(
  sessionId: string,
  entries: SummaryEntry[],
  enabled: boolean,
): { text?: string; previous: string[] } {
  const { bySession } = useStore(summaryStore);
  const exchange = useMemo(() => lastExchange(entries), [entries]);
  const at = exchange?.at;
  // A timer, so a session that goes quiet while this page is open is summarised
  // without waiting for another event.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 30_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!enabled || !exchange || !at) return;
    if (!isSettled(entries)) return;
    ensureSummary(sessionId, at, exchange.user, exchange.assistant);
    // `at` identifies the run; `tick` re-checks the quiet period as time passes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, sessionId, at, tick]);
  const history = bySession[sessionId] ?? [];
  const current = history.find((entry) => entry.at === exchange?.at);
  return {
    text: current?.text,
    // Everything before the run on screen, newest first.
    previous: history.filter((entry) => entry.at !== exchange?.at).map((entry) => entry.text),
  };
}
