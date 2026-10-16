import { Store, useStore } from "./store";

/**
 * Sessions and whole hosts hidden from the sidebar and the status board.
 *
 * Kept per browser rather than on the host: it is a view preference about *your* list,
 * not a fact about the session, and two people looking at the same machine may well want
 * different sets. Persisted so it survives a reload.
 */
const KEY = "pinet.hiddenSessions.v2";

interface Hidden {
  ids: string[];
  hosts: string[];
}

function load(): Hidden {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
    return { ids: strings(parsed?.ids), hosts: strings(parsed?.hosts) };
  } catch {
    return { ids: [], hosts: [] };
  }
}

export const hiddenStore = new Store<Hidden>(load());

function persist(state: Hidden) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* private mode, or a full quota: the preference simply does not outlive the tab */
  }
}

function toggle(key: keyof Hidden, value: string) {
  hiddenStore.set((state) => {
    const next = {
      ...state,
      [key]: state[key].includes(value) ? state[key].filter((entry) => entry !== value) : [...state[key], value],
    };
    persist(next);
    return next;
  });
}

export const toggleHidden = (sessionId: string) => toggle("ids", sessionId);
export const toggleHiddenHost = (hostId: string) => toggle("hosts", hostId);

/** The hidden sets, for a component that wants to filter or count them. */
export function useHidden(): Hidden {
  return useStore(hiddenStore);
}

/** True when a session is hidden in its own right or because its host is. */
export const isHidden = (hidden: Hidden, sessionId: string, hostId?: string): boolean =>
  hidden.ids.includes(sessionId) || Boolean(hostId && hidden.hosts.includes(hostId));
