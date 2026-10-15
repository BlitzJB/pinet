import { Store, useStore } from "./store";

/**
 * Sessions hidden from the sidebar and the status board.
 *
 * Kept per browser rather than on the host: it is a view preference about *your* list,
 * not a fact about the session, and two people looking at the same machine may well
 * want different sets. Persisted so it survives a reload.
 */
const KEY = "pinet.hiddenSessions.v1";

function load(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export const hiddenStore = new Store<{ ids: string[] }>({ ids: load() });

function persist(ids: string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
    /* private mode, or a full quota: the preference simply does not outlive the tab */
  }
}

export function toggleHidden(sessionId: string) {
  hiddenStore.set((state) => {
    const ids = state.ids.includes(sessionId)
      ? state.ids.filter((id) => id !== sessionId)
      : [...state.ids, sessionId];
    persist(ids);
    return { ids };
  });
}

/** The hidden ids, for a component that wants to filter or count them. */
export function useHidden(): string[] {
  return useStore(hiddenStore).ids;
}
