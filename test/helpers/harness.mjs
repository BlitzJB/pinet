import { createServer } from "node:http";
import { AccountStore } from "../../src/auth/accounts.mjs";
import { Registry } from "../../src/coordinator/registry.mjs";
import { createGateway } from "../../src/coordinator/ws.mjs";
import { generateEd25519, generateX25519 } from "../../src/crypto/keys.mjs";

export async function startCoordinator({ verifySession, registry = new Registry() } = {}) {
  const accounts = new AccountStore();
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const gateway = createGateway({ server, accounts, serverId: "srv_test", verifySession, registry });
  return {
    accounts,
    server,
    port,
    serverId: "srv_test",
    url: `ws://127.0.0.1:${port}/ws`,
    gateway,
    registry,
    close: async () => {
      await gateway.close();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export function makeAccount(accounts, email = "user@example.com") {
  return accounts.upsertGoogleAccount({ sub: `sub_${email}`, email, name: email });
}

export function enrollDevice(accounts, accountId, kind, name) {
  const identity = generateEd25519();
  const encryption = generateX25519();
  const device = accounts.registerDevice({
    accountId,
    kind,
    name,
    identityPub: identity.publicKey,
    encPub: encryption.publicKey,
  });
  return { device, identity, encryption };
}

export function waitFor(emitter, type, predicate = () => true, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(type, handler);
      reject(new Error(`timeout waiting for ${type}`));
    }, timeoutMs);
    function handler(data) {
      if (!predicate(data)) return;
      clearTimeout(timer);
      emitter.off(type, handler);
      resolve(data);
    }
    emitter.on(type, handler);
  });
}
