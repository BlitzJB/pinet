import { useEffect, useMemo } from "react";
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
const STORAGE_KEY = "pinet.runSummaries";

export interface RunSummary {
  /** The final assistant entry id this line describes. */
  at: string;
  text: string;
}

function load(): Record<string, RunSummary> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, RunSummary>;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

export const summaryStore = new Store<{ bySession: Record<string, RunSummary> }>({ bySession: load() });

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
  if (summaryStore.get().bySession[sessionId]?.at === at) return;
  if (inflight.has(sessionId)) return;
  inflight.add(sessionId);
  void summarizeExchange(user, assistant)
    .then(({ summary }) => {
      if (!summary) return;
      summaryStore.set((state) => ({ bySession: { ...state.bySession, [sessionId]: { at, text: summary } } }));
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

/** The cached line for a session's current run, generating it if needed. */
export function useRunSummary(sessionId: string, entries: SummaryEntry[], enabled: boolean): string | undefined {
  const { bySession } = useStore(summaryStore);
  const exchange = useMemo(() => lastExchange(entries), [entries]);
  const at = exchange?.at;
  useEffect(() => {
    if (enabled && exchange && at) ensureSummary(sessionId, at, exchange.user, exchange.assistant);
    // `at` identifies the run; the exchange text cannot change without it changing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, sessionId, at]);
  const cached = bySession[sessionId];
  return exchange && cached?.at === exchange.at ? cached.text : undefined;
}
