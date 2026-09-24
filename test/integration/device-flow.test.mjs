import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PinetSocket } from "../../src/common/ws-client.mjs";
import { startMockGoogleIdp } from "../../src/auth/google.mjs";
import { createCoordinator } from "../../src/coordinator/server.mjs";
import { loadHostState, onboardHost } from "../../src/host/onboarding.mjs";

let idp;
let coord;

beforeAll(async () => {
  idp = await startMockGoogleIdp();
  coord = await createCoordinator({
    config: {
      port: 0,
      host: "127.0.0.1",
      sessionSecret: "device-flow-secret",
      serverId: "srv_device_flow",
      google: { clientId: "cid", clientSecret: "csec", authUrl: idp.authUrl, tokenUrl: idp.tokenUrl, userinfoUrl: idp.userinfoUrl },
    },
  });
});

afterAll(async () => {
  await coord.close();
  await idp.close();
});

async function loginToken(n) {
  idp.setUser({ sub: `device-${n}`, email: `device${n}@example.com`, name: `Device ${n}` });
  const start = await fetch(`${coord.httpUrl}/auth/login`, { redirect: "manual" });
  const authorized = await fetch(start.headers.get("location"), { redirect: "manual" });
  const callback = authorized.headers.get("location");
  const response = await fetch(callback, { redirect: "manual", headers: { accept: "application/json" } });
  return (await response.json()).sessionToken;
}

async function approve(userCode, token) {
  const response = await fetch(`${coord.httpUrl}/auth/device/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ userCode }),
  });
  return response;
}

async function start() {
  const response = await fetch(`${coord.httpUrl}/auth/device/start`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  return response.json();
}

async function poll(deviceCode) {
  const response = await fetch(`${coord.httpUrl}/auth/device/poll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceCode }),
  });
  return response.json();
}

describe("device authorization flow", () => {
  it("requires approval and issues a session once", async () => {
    const flow = await start();
    expect(flow.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/u);
    expect(flow.verificationUri).toContain("/auth/device");
    expect(flow.verificationUri).toContain(encodeURIComponent(flow.userCode));

    expect(await poll(flow.deviceCode)).toEqual({ status: "pending" });

    const token = await loginToken(1);
    const approved = await approve(flow.userCode, token);
    expect(approved.status).toBe(200);

    const result = await poll(flow.deviceCode);
    expect(result.status).toBe("approved");
    expect(typeof result.sessionToken).toBe("string");

    // Consumed after one successful poll.
    expect((await poll(flow.deviceCode)).status).not.toBe("approved");
  });

  it("rejects an unknown code", async () => {
    const token = await loginToken(2);
    const response = await approve("ZZZZ-ZZZZ", token);
    expect(response.status).toBe(404);
  });

  it("runs the whole in-pi onboarding and yields a working host identity", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "pinet-onboard-"));
    try {
      const approverToken = await loginToken(3);
      let captured;
      const codeSeen = new Promise((resolve) => {
        captured = resolve;
      });

      const onboarding = onboardHost({
        httpUrl: coord.httpUrl,
        dir: tmp,
        name: "studio",
        onCode: (code) => captured(code),
      });

      const { userCode, verificationUri } = await codeSeen;
      expect(verificationUri).toContain("/auth/device");
      await approve(userCode, approverToken);

      const result = await onboarding;
      expect(result.hostId).toMatch(/^host_/u);

      const state = loadHostState(tmp);
      expect(state.hostId).toBe(result.hostId);

      // The enrolled host can authenticate over WebSocket.
      const socket = new PinetSocket(coord.wsUrl);
      const auth = await socket.connect({ role: "host", deviceId: state.hostId, identityPrivateKey: state.identity.privateKey });
      expect(auth).toMatchObject({ role: "host", deviceId: state.hostId });
      socket.close();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 20_000);
});
