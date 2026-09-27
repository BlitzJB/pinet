#!/usr/bin/env node
// PiNet spawner daemon.
//
// Started on a host by hand (`/rc` inside pi), never from the PiNet UI. It holds
// no transcript and serves no conversation: it advertises a directory scope and
// creates sessions inside it when the UI asks. The sessions are what the user
// interacts with, and because the user may be nowhere near this host they mount
// themselves — which is why every child gets PINET_SPAWNED=1.
//
// It authenticates with the host's own device keys (kind "host", role
// "spawner"), so starting one needs no enrollment, and it reconnects on its own,
// so a spawner outlives both the pi session that launched it and a coordinator
// restart.

import { createHash, randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { PiNetSocket } from "../common/ws-client.mjs";
import { loadHostState } from "../host/onboarding.mjs";
import { SessionSpawner, detectGit, detectTmux } from "../host/spawner.mjs";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split("=");
    if (!flag.startsWith("--")) continue;
    const key = flag.slice(2);
    const value = inline ?? (argv[i + 1]?.startsWith("--") ? undefined : argv[i + 1]);
    if (inline === undefined && value !== undefined) i += 1;
    args[key] = value ?? true;
  }
  return args;
}

export async function startSpawner({
  cwd,
  label,
  max = 8,
  dir = process.env.PINET_DIR ?? `${process.env.HOME ?? "."}/.pinet`,
  hubUrl = process.env.PINET_HUB ?? "ws://127.0.0.1:8787/ws",
} = {}) {
  const root = realpathSync(cwd);
  const state = loadHostState(dir);
  if (!state.hostId || !state.identity?.privateKey) throw new Error("not_enrolled");

  // Stable per directory, with a suffix so two spawners rooted at the same place
  // stay distinct — overlapping scopes are allowed on purpose.
  const spawnerId = `${createHash("sha256").update(root).digest("hex").slice(0, 12)}-${randomBytes(2).toString("hex")}`;
  const spawner = new SessionSpawner({
    cwd: root,
    mode: "session",
    max: Number(max) || 8,
    git: await detectGit(root),
    tmux: await detectTmux(),
    env: { ...process.env, PINET_SPAWNED: "1" },
  });

  const socket = new PiNetSocket(hubUrl, { reconnect: true });
  const name = label || `${hostname()}:${root}`;
  const announce = () =>
    socket.send("spawner.register", { spawnerId, label: name, root, max: spawner.max, host: hostname() });

  socket.on("ready", announce);
  socket.on("spawn.request", (data) => {
    const result = spawner.spawn({ name: data.name, dir: data.dir });
    socket.send("spawn.result", {
      requestId: data.requestId,
      spawnerId,
      ok: result.ok,
      sessionId: result.sessionId,
      name: result.name,
      cwd: result.cwd,
      error: result.error,
    });
  });
  socket.on("spawn.dirs.request", (data) => {
    socket.send("spawn.dirs.result", { requestId: data.requestId, spawnerId, ...spawner.directories(data.path) });
  });

  await socket.connect({ role: "spawner", deviceId: state.hostId, identityPrivateKey: state.identity.privateKey, timeoutMs: 20_000 });
  return { socket, spawner, spawnerId, root, label: name };
}

const invokedDirectly = process.argv[1]?.endsWith("daemon.mjs");
if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  startSpawner({
    cwd: resolve(String(args.dir ?? process.cwd())),
    label: typeof args.label === "string" ? args.label : undefined,
    max: args.max,
  })
    .then(({ label: name, root }) => {
      console.log(`pinet spawner ready\n  scope: ${root}\n  label: ${name}`);
    })
    .catch((error) => {
      console.error(`pinet spawner: ${String(error?.message ?? error)}`);
      if (String(error?.message) === "not_enrolled") console.error("  run /pinet setup in pi on this host first");
      process.exit(1);
    });
  // Detached sessions survive this process; only its own bookkeeping goes away.
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(0));
}
