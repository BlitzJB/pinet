import { describe, expect, it } from "vitest";
import { groupSessionsByHost } from "../../web/src/lib/session-groups.ts";

const session = (id, hostId, hostName, name, connected = true) => ({
  sessionId: id,
  hostId,
  hostName,
  hostConnected: connected,
  meta: { name },
});

describe("groupSessionsByHost", () => {
  it("groups sessions under their host and sorts hosts + sessions", () => {
    const groups = groupSessionsByHost([
      session("s1", "h2", "zeta", "beta"),
      session("s2", "h1", "alpha", "two"),
      session("s3", "h1", "alpha", "one"),
    ]);

    expect(groups.map((group) => group.hostName)).toEqual(["alpha", "zeta"]);
    expect(groups[0].sessions.map((s) => s.sessionId)).toEqual(["s3", "s2"]); // "one" < "two"
    expect(groups[1].sessions.map((s) => s.sessionId)).toEqual(["s1"]);
  });

  it("marks a host online if any of its sessions reports online", () => {
    const groups = groupSessionsByHost([
      session("s1", "h1", "alpha", "a", false),
      session("s2", "h1", "alpha", "b", true),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].hostConnected).toBe(true);
  });

  it("filters by session name, host name, cwd or id", () => {
    const sessions = [
      { sessionId: "s1", hostId: "h1", hostName: "alpha", hostConnected: true, meta: { name: "Fix login", cwd: "/srv/api" } },
      { sessionId: "s2", hostId: "h2", hostName: "beta", hostConnected: true, meta: { name: "Docs", cwd: "/srv/web" } },
    ];

    expect(groupSessionsByHost(sessions, "login")[0].sessions.map((s) => s.sessionId)).toEqual(["s1"]);
    expect(groupSessionsByHost(sessions, "beta")[0].sessions.map((s) => s.sessionId)).toEqual(["s2"]);
    expect(groupSessionsByHost(sessions, "/srv/web")[0].sessions.map((s) => s.sessionId)).toEqual(["s2"]);
    expect(groupSessionsByHost(sessions, "s1")[0].sessions.map((s) => s.sessionId)).toEqual(["s1"]);
    expect(groupSessionsByHost(sessions, "nope")).toEqual([]);
  });

  it("falls back to a synthetic host for sessions without a host id", () => {
    const groups = groupSessionsByHost([session("s1", undefined, undefined, "orphan")]);
    expect(groups[0].hostId).toBe("unknown");
    expect(groups[0].hostName).toBe("Unknown host");
  });
});
