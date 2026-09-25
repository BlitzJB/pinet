import { describe, expect, it } from "vitest";
import { Registry } from "../../src/coordinator/registry.mjs";

const fakeWs = () => ({ readyState: 1, send() {} });

describe("registry ownership and multi-connection hosts", () => {
  it("allows many host connections for one device identity", () => {
    const registry = new Registry();
    const a = fakeWs();
    const b = fakeWs();
    registry.registerHost(a, { deviceId: "hostX", accountId: "acct", hostName: "h" });
    registry.registerHost(b, { deviceId: "hostX", accountId: "acct", hostName: "h" });
    expect(registry.hosts.size).toBe(2);
  });

  it("refuses to bind a session id owned by another account", () => {
    const registry = new Registry();
    const a = fakeWs();
    const b = fakeWs();
    registry.registerHost(a, { deviceId: "hostA", accountId: "acctA", hostName: "A" });
    registry.registerHost(b, { deviceId: "hostB", accountId: "acctB", hostName: "B" });
    registry.openSession(a, { sessionId: "s1", meta: {} });
    expect(registry.openSession(b, { sessionId: "s1", meta: {} })).toBeUndefined();
    expect(registry.sessions.get("s1").accountId).toBe("acctA");
    expect(registry.ownsSession(b, "s1")).toBe(false);
  });

  it("only the owning connection may close a session", () => {
    const registry = new Registry();
    const a = fakeWs();
    const b = fakeWs();
    registry.registerHost(a, { deviceId: "hostA", accountId: "acct", hostName: "A" });
    registry.registerHost(b, { deviceId: "hostB", accountId: "acct", hostName: "B" });
    registry.openSession(a, { sessionId: "s1", meta: {} });
    expect(registry.closeSession("s1", b)).toBe(false);
    expect(registry.sessions.has("s1")).toBe(true);
    expect(registry.closeSession("s1", a)).toBe(true);
    expect(registry.sessions.has("s1")).toBe(false);
  });
});
