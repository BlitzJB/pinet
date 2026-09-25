// Pinet controller CLI.
//
//   node src/controller/cli.mjs login     # browser SSO + MFA, saves a session
//   node src/controller/cli.mjs enroll    # register this device with the hub
//   node src/controller/cli.mjs list
//   node src/controller/cli.mjs           # interactive control
//
// Env: PINET_HUB (ws url), PINET_HTTP (http origin), PINET_DIR.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { generateEd25519, generateX25519 } from "../crypto/keys.mjs";
import { PinetController } from "./client.mjs";

const DIR = process.env.PINET_DIR ?? join(process.env.HOME ?? ".", ".pinet");
const CONFIG = join(DIR, "controller.json");
const DEFAULT_HUB = process.env.PINET_HUB ?? "ws://127.0.0.1:8787/ws";
const DEFAULT_HTTP = process.env.PINET_HTTP ?? "http://127.0.0.1:8787";

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG, "utf8"));
  } catch {
    return {};
  }
}

function saveConfig(next) {
  mkdirSync(dirname(CONFIG), { recursive: true });
  writeFileSync(CONFIG, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}

function openBrowser(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(command, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* user can open manually */
  }
}

async function login() {
  const http = process.env.PINET_HTTP ?? loadConfig().http ?? DEFAULT_HTTP;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const code = url.searchParams.get("code");
    const legacyToken = url.searchParams.get("session_token");
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<h2>Pinet</h2><p>Login complete. You can close this tab.</p>");
    let sessionToken = legacyToken ?? undefined;
    if (!sessionToken && code) {
      try {
        const response = await fetch(`${http}/auth/cli/exchange`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code }),
        });
        if (response.ok) sessionToken = (await response.json()).sessionToken;
      } catch {
        /* fall through to error */
      }
    }
    if (sessionToken) {
      const config = loadConfig();
      saveConfig({ ...config, hub: config.hub ?? DEFAULT_HUB, http, sessionToken });
      console.log(C.green("login complete"));
      server.close();
      process.exit(0);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const returnTo = `http://127.0.0.1:${port}/`;
  const authUrl = `${http}/auth/login?return_to=${encodeURIComponent(returnTo)}`;
  console.log(`Open this URL to sign in (Google SSO + MFA):\n${authUrl}`);
  openBrowser(authUrl);
  await new Promise(() => {});
}

async function enroll() {
  const config = loadConfig();
  if (!config.sessionToken) {
    console.log(C.yellow("no session; run `node src/controller/cli.mjs login` first"));
    process.exit(1);
  }
  const identity = generateEd25519();
  const encryption = generateX25519();
  const response = await fetch(`${config.http}/devices/register`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.sessionToken}` },
    body: JSON.stringify({ kind: "controller", name: process.env.PINET_DEVICE_NAME ?? "cli", identityPub: identity.publicKey, encPub: encryption.publicKey }),
  });
  if (!response.ok) {
    console.log(C.red(`enroll failed: ${response.status} ${await response.text()}`));
    process.exit(1);
  }
  const { deviceId, fingerprint } = await response.json();
  saveConfig({ ...config, deviceId, identity, encryption });
  console.log(C.green(`device enrolled: ${deviceId} (${fingerprint.slice(0, 16)})`));
}

async function hostCode() {
  const config = loadConfig();
  if (!config.sessionToken) {
    console.log(C.yellow("no session; run `node src/controller/cli.mjs login` first"));
    process.exit(1);
  }
  const response = await fetch(`${config.http}/hosts/enroll/start`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.sessionToken}` },
  });
  if (!response.ok) {
    console.log(C.red(`failed: ${response.status}`));
    process.exit(1);
  }
  const { code } = await response.json();
  console.log(C.green(`host enrollment code: ${code}`));
  console.log(C.dim("start pi with:"));
  console.log(`  PINET_HUB=${config.hub} PINET_HTTP=${config.http} PINET_ENROLL_CODE=${code} pi -e /root/pinet/extension/index.ts`);
}

function renderEntry(entry, seen) {
  if (!entry || seen.has(entry.id)) return;
  seen.add(entry.id);
  if (entry.type === "message" && entry.message) {
    const m = entry.message;
    const text = typeof m.content === "string" ? m.content : (m.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
    if (m.role === "user") output.write(`\n${C.bold("👤 you")}\n${text}\n`);
    else if (m.role === "assistant" && text.trim()) output.write(`\n${C.bold("🤖 pi")}\n${text}\n`);
    else if (m.role === "assistant") {
      for (const b of m.content ?? []) if (b.type === "toolCall") output.write(C.dim(`🔧 ${b.name} ${JSON.stringify(b.arguments).slice(0, 120)}\n`));
    } else if (m.role === "toolResult") output.write(C.dim(`✔ ${m.toolName} result\n`));
  } else if (entry.type === "model_change") output.write(C.dim(`· model → ${entry.provider}/${entry.modelId}\n`));
  else if (entry.type === "compaction") output.write(C.yellow("· compacted\n"));
}

async function interactive() {
  const config = loadConfig();
  if (!config.deviceId) {
    console.log(C.yellow("device not enrolled; run login then enroll"));
    process.exit(1);
  }
  const controller = new PinetController({
    url: config.hub ?? DEFAULT_HUB,
    deviceId: config.deviceId,
    identity: config.identity,
    encryption: config.encryption,
    reconnect: true,
  });
  controller.on("disconnected", () => output.write(C.yellow("! disconnected; reconnecting…\n")));
  controller.on("reconnecting", (info) => output.write(C.dim(`· reconnecting in ${Math.round(info.delayMs / 1000)}s\n`)));
  controller.on("reconnected", () => output.write(C.green("· reconnected; resyncing\n")));
  controller.on("resynced", () => output.write(C.dim("· resynced\n")));
  const seen = new Set();
  let current;
  controller.on("snapshot", (d) => {
    output.write(C.dim(`— snapshot seq=${d.seq} entries=${d.entries?.length ?? 0}\n`));
    (d.entries ?? []).forEach((e) => renderEntry(e, seen));
  });
  controller.on("rebase", (d) => (d.entries ?? []).forEach((e) => renderEntry(e, seen)));
  controller.on("entries", (d) => (d.entries ?? []).forEach((e) => renderEntry(e, seen)));
  controller.on("status", (d) => output.write(C.dim(`· ${d.status?.phase}${d.status?.model ? ` · ${d.status.model.provider}/${d.status.model.id}` : ""}\n`)));
  controller.on("cmd.ack", (d) => output.write(C.dim(`· ack ${d.accepted ? "ok" : "rejected"}${d.mode ? ` (${d.mode})` : ""}${d.error ? `: ${d.error}` : ""}\n`)));
  controller.on("decrypt_error", (d) => output.write(C.red(`! decrypt failed: ${d.error}\n`)));
  await controller.connect();
  output.write(C.dim(`connected to ${controller.url}\n`));

  const rl = createInterface({ input, output });
  const help = "commands: /list  /attach <id> [read]  /detach  /abort  /compact  /model <p> <id>  /thinking <l>  /rename <n>  /quit";
  output.write(`${help}\n`);
  for (;;) {
    const line = (await rl.question(C.cyan(current ? "pinet* " : "pinet> "))).trim();
    if (!line) continue;
    if (line === "/quit") break;
    if (line === "/list") {
      const sessions = await controller.list();
      sessions.forEach((s, i) => output.write(`  ${i + 1}. ${s.meta?.name ?? "(unnamed)"} ${C.dim(s.sessionId)} ${s.hostConnected ? "" : "OFFLINE"}\n`));
      continue;
    }
    if (line.startsWith("/attach ")) {
      const [id, mode] = line.slice(8).trim().split(/\s+/);
      await controller.attach(id, mode === "read" ? "read" : "control");
      current = id;
      output.write(C.green(`attached ${id}\n`));
      continue;
    }
    if (!current) {
      output.write(C.yellow("attach first\n"));
      continue;
    }
    if (line === "/detach") {
      controller.detach(current);
      current = undefined;
      continue;
    }
    if (line === "/abort") {
      await controller.command(current, "abort");
      continue;
    }
    if (line.startsWith("/compact")) {
      await controller.command(current, "compact", { instructions: line.slice(8).trim() || undefined });
      continue;
    }
    if (line.startsWith("/model ")) {
      const [, provider, modelId] = line.split(/\s+/);
      await controller.command(current, "set_model", { provider, modelId });
      continue;
    }
    if (line.startsWith("/thinking ")) {
      await controller.command(current, "set_thinking", { level: line.slice(10).trim() });
      continue;
    }
    if (line.startsWith("/rename ")) {
      await controller.command(current, "rename", { name: line.slice(8).trim() });
      continue;
    }
    await controller.command(current, "prompt", { text: line });
  }
  rl.close();
  controller.close();
}

const mode = process.argv[2];
const main =
  mode === "login" ? login : mode === "enroll" ? enroll : mode === "host-code" ? hostCode : interactive;
main().catch((error) => {
  console.error(C.red(`fatal: ${error.message}`));
  process.exitCode = 1;
});
