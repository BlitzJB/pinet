import type { ServerSession } from "./api";

export interface HostGroup {
  hostId: string;
  hostName: string;
  hostConnected: boolean;
  sessions: ServerSession[];
}

/** Group sessions by their host, applying an optional filter, with stable sorting. */
export function groupSessionsByHost(sessions: ServerSession[], filter = ""): HostGroup[] {
  const needle = filter.trim().toLowerCase();
  const matches = (session: ServerSession) =>
    !needle ||
    [session.meta?.name, session.hostName, session.meta?.cwd, session.sessionId]
      .filter(Boolean)
      .some((field) => String(field).toLowerCase().includes(needle));

  const groups = new Map<string, HostGroup>();
  for (const session of sessions) {
    if (!matches(session)) continue;
    const hostId = session.hostId ?? "unknown";
    let group = groups.get(hostId);
    if (!group) {
      group = { hostId, hostName: session.hostName ?? "Unknown host", hostConnected: false, sessions: [] };
      groups.set(hostId, group);
    }
    group.sessions.push(session);
    group.hostConnected = group.hostConnected || Boolean(session.hostConnected);
  }

  const list = [...groups.values()];
  for (const group of list) {
    group.sessions.sort(
      (a, b) => (a.meta?.name ?? "").localeCompare(b.meta?.name ?? "") || a.sessionId.localeCompare(b.sessionId),
    );
  }
  return list.sort((a, b) => a.hostName.localeCompare(b.hostName) || a.hostId.localeCompare(b.hostId));
}
