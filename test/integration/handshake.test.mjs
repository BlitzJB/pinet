import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { PinetSocket } from "../../src/common/ws-client.mjs";
import { nodeCryptoProvider } from "../../src/crypto/provider.mjs";
import { generateEd25519 } from "../../src/crypto/keys.mjs";

let server;
let wss;
let url;

beforeAll(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  url = `ws://127.0.0.1:${port}/ws`;
  wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws) => {
    // Send a challenge, then drop the connection before completing the handshake.
    ws.send(JSON.stringify({ v: 1, id: "1", type: "auth.challenge", ts: Date.now(), data: { nonce: "nonce", serverId: "srv", ts: Date.now() } }));
    setTimeout(() => ws.close(4002, "dropped"), 30);
  });
});

afterAll(async () => {
  await new Promise((resolve) => wss.close(resolve));
  await new Promise((resolve) => server.close(resolve));
});

describe("handshake resilience", () => {
  it("rejects promptly when the connection drops mid-handshake", async () => {
    const identity = generateEd25519();
    const socket = new PinetSocket(url);
    const started = Date.now();
    await expect(
      socket.connect({ role: "controller", deviceId: "dev_x", identityPrivateKey: identity.privateKey, crypto: nodeCryptoProvider, timeoutMs: 8000 }),
    ).rejects.toThrow(/closed during handshake/);
    // Must not wait for the full handshake timeout.
    expect(Date.now() - started).toBeLessThan(4000);
  });
});
