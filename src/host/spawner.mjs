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
 * A spawned session is a `pi --mode rpc` process. RPC mode exits as soon as its
 * stdin closes, so a plain child would die with (and be killed by) the spawner —
 * a restart would take the spawned session down with it. When tmux is available
 * the session is started in a detached tmux session instead, which gives it a
 * TTY and makes it independent of the spawner process. Without tmux we fall back
 * to a direct child, which does not outlive the spawner.
 *
 * Either way it inherits PINET_DIR, so it reuses the host identity and registers
 * with the coordinator like any other host — no extra service.
 */
import { execFile, execFileSync, spawn as nodeSpawn } from "node:child_process";
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
const shQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/** True when `dir` is inside a git working tree (needed for worktree mode). */
export async function detectGit(dir, run = execFileAsync) {
  try {
    await run("git", ["rev-parse", "--show-toplevel"], { cwd: dir });
    return true;
  } catch {
    return false;
  }
}

/** Returns the tmux binary to use, or null when tmux isn't installed. */
export async function detectTmux(run = execFileAsync) {
  try {
    await run("tmux", ["-V"]);
    return "tmux";
  } catch {
    return null;
  }
}

const defaultListSessions = () =>
  execFileSync("tmux", ["list-sessions", "-F", "#{session_name}"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

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
    tmux = null,
    listSessions = defaultListSessions,
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
    this.tmux = tmux;
    this.listSessions = listSessions;
  }

  get enabled() {
    return this.mode !== "off";
  }

  /** Host capability advertised in session meta so controllers can offer "new session". */
  capability() {
    return {
      mode: this.mode,
      cwd: this.cwd,
      git: Boolean(this.git),
      max: this.max,
      active: this.#children.size,
      persistent: Boolean(this.tmux),
    };
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

  #tmuxCommand({ sessionId, name }) {
    return [this.piBin, ...this.buildArgs({ sessionId, name })].map(shQuote).join(" ");
  }

  /** Drop detached sessions whose tmux session has gone away. */
  #reconcile() {
    if (!this.tmux || this.#children.size === 0) return;
    let live;
    try {
      live = new Set(String(this.listSessions()).split("\n").map((name) => name.trim()).filter(Boolean));
    } catch {
      return; // no tmux server yet: nothing is live, but don't guess
    }
    for (const [id, record] of [...this.#children]) {
      if (record.detached && !live.has(record.tmuxName)) this.#children.delete(id);
    }
  }

  spawn({ name } = {}) {
    if (!this.enabled) return { ok: false, error: "spawn_disabled" };
    if (this.mode !== "session") return { ok: false, error: `spawn_mode_unavailable:${this.mode}` };
    this.#reconcile();
    if (this.#children.size >= this.max) return { ok: false, error: "spawn_capacity" };

    const sessionId = randomUUID();
    const sessionName = String(name ?? "").trim() || this.autoName();

    if (this.tmux) {
      const tmuxName = `pinet-${sessionId.slice(0, 8)}`;
      try {
        this.spawnFn(
          this.tmux,
          ["new-session", "-d", "-s", tmuxName, "-c", this.cwd, this.#tmuxCommand({ sessionId, name: sessionName })],
          { stdio: "ignore" },
        );
      } catch (error) {
        return { ok: false, error: `spawn_failed:${String(error?.message ?? error)}` };
      }
      this.#children.set(sessionId, { sessionId, name: sessionName, tmuxName, detached: true, pid: null, startedAt: this.clock() });
      return { ok: true, sessionId, name: sessionName, pid: null, detached: true, tmuxName };
    }

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

    this.#children.set(sessionId, { sessionId, name: sessionName, pid: child.pid, detached: false, startedAt: this.clock(), child });
    const forget = () => this.#children.delete(sessionId);
    child.once?.("exit", forget);
    child.once?.("error", forget);

    return { ok: true, sessionId, name: sessionName, pid: child.pid, detached: false };
  }

  kill(sessionId) {
    const record = this.#children.get(sessionId);
    if (!record) return false;
    this.#children.delete(sessionId);
    if (record.detached) {
      try {
        this.spawnFn(this.tmux, ["kill-session", "-t", record.tmuxName], { stdio: "ignore" });
      } catch {
        /* already gone */
      }
      return true;
    }
    try {
      record.child.stdin?.end?.();
      record.child.kill?.("SIGTERM");
    } catch {
      /* already gone */
    }
    return true;
  }

  /**
   * Detached (tmux) sessions deliberately outlive this process — that is the
   * whole point, so a spawner restart doesn't kill them. Only the direct-child
   * fallback is torn down.
   */
  shutdown() {
    for (const id of [...this.#children.keys()]) {
      if (!this.#children.get(id)?.detached) this.kill(id);
    }
  }
}
