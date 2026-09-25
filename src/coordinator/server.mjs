// Coordinator boot: one HTTP server carrying both the auth API and the
// authenticated WebSocket gateway.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { AccountStore } from "../auth/accounts.mjs";
import { GoogleOAuth, GOOGLE_DEFAULTS } from "../auth/google.mjs";
import { AuthService } from "../auth/service.mjs";
import { createHttpHandler } from "./http.mjs";
import { createGateway } from "./ws.mjs";

export function configFromEnv(env = process.env) {
  const publicUrl = env.PINET_PUBLIC_URL ?? `http://localhost:${env.PINET_PORT ?? 8787}`;
  return {
    port: Number(env.PINET_PORT ?? 8787),
    host: env.PINET_HOST ?? "0.0.0.0",
    sessionSecret: env.PINET_SESSION_SECRET ?? randomUUID() + randomUUID(),
    serverId: env.PINET_SERVER_ID ?? `srv_${randomUUID().slice(0, 8)}`,
    publicUrl,
    dataDir: env.PINET_DATA_DIR,
    allowedUsers: env.PINET_ALLOWED_USERS,
    google: {
      clientId: env.GOOGLE_CLIENT_ID ?? "configure-me",
      clientSecret: env.GOOGLE_CLIENT_SECRET ?? "configure-me",
      redirectUri: env.GOOGLE_REDIRECT_URI ?? `${publicUrl}/auth/callback`,
      authUrl: env.GOOGLE_AUTH_URL ?? GOOGLE_DEFAULTS.authUrl,
      tokenUrl: env.GOOGLE_TOKEN_URL ?? GOOGLE_DEFAULTS.tokenUrl,
      userinfoUrl: env.GOOGLE_USERINFO_URL ?? GOOGLE_DEFAULTS.userinfoUrl,
    },
  };
}

export async function createCoordinator({ config = configFromEnv(), accounts, google } = {}) {
  const server = createServer();
  await new Promise((resolve) => server.listen(config.port, config.host, resolve));
  const address = server.address();
  const port = typeof address === "object" ? address.port : config.port;
  const base = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
  const publicUrl = config.publicUrl ?? `http://${base}:${port}`;
  const redirectUri = config.google?.redirectUri ?? `${publicUrl}/auth/callback`;
  const store = accounts ?? new AccountStore({ persistPath: config.dataDir ? join(config.dataDir, "coordinator-store.json") : undefined });
  const googleClient = google ?? new GoogleOAuth({ ...config.google, redirectUri });
  const authService = new AuthService({ accounts: store, google: googleClient, sessionSecret: config.sessionSecret, allowedUsers: config.allowedUsers });
  const handler = createHttpHandler({ accounts: store, authService, publicUrl, webDir: config.webDir });
  server.on("request", (req, res) => void handler(req, res));
  const publicOrigin = (() => {
    try {
      return new URL(publicUrl).origin;
    } catch {
      return undefined;
    }
  })();
  const allowedOrigins = [
    publicOrigin,
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:8787",
    "http://127.0.0.1:8787",
  ].filter(Boolean);
  const gateway = createGateway({ server, accounts: store, serverId: config.serverId, allowedOrigins });
  const pruneTimer = setInterval(() => {
    try {
      authService.prune();
      store.prune();
    } catch {
      /* ignore */
    }
  }, 60_000);
  pruneTimer.unref?.();
  return {
    accounts: store,
    authService,
    registry: gateway.registry,
    serverId: config.serverId,
    port,
    httpUrl: `http://${base}:${port}`,
    wsUrl: `ws://${base}:${port}/ws`,
    publicUrl,
    close: async () => {
      clearInterval(pruneTimer);
      await gateway.close();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const config = configFromEnv();
  const coordinator = await createCoordinator({ config });
  console.log(`[hub] serverId=${coordinator.serverId}`);
  console.log(`[hub] http  ${coordinator.httpUrl}`);
  console.log(`[hub] ws    ${coordinator.wsUrl}`);
  const shutdown = async () => {
    await coordinator.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
