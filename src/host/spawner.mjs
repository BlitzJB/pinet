/**
 * Session spawner — owned by the pi extension.
 *
 * Any enrolled pi process can spawn additional sessions on its machine. This
 * mirrors `claude remote-control`'s `--spawn` modes:
 *
 *   - `session` (default): the new session starts in the spawner's directory.
 *   - `worktree` (planned): each session gets its own git worktree.
 *   - `off`: spawning disabled.
 *
 * A spawned session is a child `pi` process running in RPC mode. It inherits
 * PINET_DIR, so it reuses the host identity and registers with the coordinator
 * like any other host — no extra service, everything lives in the extension.
 */
import { execFile, spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const SPAWN_MODES = ["session", "worktree", "off"];

const ADJECTIVES = [
  "graceful", "quiet", "bright", "swift", "calm", "clever",
  "bold", "gentle", "lucky", "steady", "crisp", "wandering",
];
const NOUNS = [
  "otter", "falcon", "cedar", "harbor", "lantern", "meadow",
  "comet", "willow", "ember", "pilot", "summit", "raven",
];

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const sanitize = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);

/** True when `dir` is inside a git working tree (needed for worktree mode). */
export async function detectGit(dir, run = execFileAsync) {
  try {
    await run("git", ["rev-parse", "--show-toplevel"], { cwd: dir });
    return true;
  } catch {
    return false;
  }
}

export class SessionSpawner {
  #children = new Map();

  constructor({
    cwd,
    mode = "session",
    max = 8,
    prefix = hostname(),
    piBin = "pi",
    env = process.env,
    spawnFn = nodeSpawn,
    git = false,
    clock = Date.now,
  } = {}) {
    this.cwd = cwd;
    this.mode = SPAWN_MODES.includes(mode) ? mode : "session";
    this.max = Number.isFinite(max) && max > 0 ? Math.floor(max) : 8;
    this.prefix = sanitize(prefix) || "pinet";
    this.piBin = piBin;
    this.env = env;
    this.spawnFn = spawnFn;
    this.git = git;
    this.clock = clock;
  }

  get enabled() {
    return this.mode !== "off";
  }

  /** Host capability advertised in session meta so controllers can offer "new session". */
  capability() {
    return { mode: this.mode, cwd: this.cwd, git: Boolean(this.git), max: this.max, active: this.#children.size };
  }

  list() {
    return [...this.#children.values()].map(({ child, ...rest }) => rest);
  }

  autoName() {
    return `${this.prefix}-${pick(ADJECTIVES)}-${pick(NOUNS)}`;
  }

  buildArgs({ sessionId, name }) {
    const args = ["--mode", "rpc", "--session-id", sessionId];
    if (name) args.push("--name", name);
    return args;
  }

  spawn({ name } = {}) {
    if (!this.enabled) return { ok: false, error: "spawn_disabled" };
    if (this.mode !== "session") return { ok: false, error: `spawn_mode_unavailable:${this.mode}` };
    if (this.#children.size >= this.max) return { ok: false, error: "spawn_capacity" };

    const sessionId = randomUUID();
    const sessionName = String(name ?? "").trim() || this.autoName();
    let child;
    try {
      child = this.spawnFn(this.piBin, this.buildArgs({ sessionId, name: sessionName }), {
        cwd: this.cwd,
        env: { ...this.env, PINET_SPAWNED: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      return { ok: false, error: `spawn_failed:${String(error?.message ?? error)}` };
    }
    // Keep the pipes flowing so a chatty child never blocks on a full buffer.
    child.stdout?.resume?.();
    child.stderr?.resume?.();

    this.#children.set(sessionId, { sessionId, name: sessionName, pid: child.pid, startedAt: this.clock(), child });
    const forget = () => this.#children.delete(sessionId);
    child.once?.("exit", forget);
    child.once?.("error", forget);

    return { ok: true, sessionId, name: sessionName, pid: child.pid };
  }

  kill(sessionId) {
    const record = this.#children.get(sessionId);
    if (!record) return false;
    this.#children.delete(sessionId);
    try {
      record.child.stdin?.end?.();
      record.child.kill?.("SIGTERM");
    } catch {
      /* already gone */
    }
    return true;
  }

  shutdown() {
    for (const id of [...this.#children.keys()]) this.kill(id);
  }
}
