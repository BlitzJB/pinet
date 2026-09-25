import { describe, expect, it } from "vitest";
import { SessionSpawner } from "../../src/host/spawner.mjs";

function fakeChild() {
  const listeners = {};
  return {
    pid: 4242,
    stdout: { resume() {} },
    stderr: { resume() {} },
    stdin: { end() {} },
    killed: false,
    once(event, fn) {
      (listeners[event] ??= []).push(fn);
    },
    kill() {
      this.killed = true;
    },
    emit(event) {
      for (const fn of listeners[event] ?? []) fn();
    },
  };
}

function makeSpawner(overrides = {}) {
  const calls = [];
  const children = [];
  const spawner = new SessionSpawner({
    cwd: "/srv/app",
    prefix: "Studio Host",
    env: { PATH: "/bin", PINET_DIR: "/home/u/.pinet" },
    spawnFn: (bin, args, options) => {
      const child = fakeChild();
      calls.push({ bin, args, options, child });
      children.push(child);
      return child;
    },
    ...overrides,
  });
  return { spawner, calls, children };
}

describe("SessionSpawner", () => {
  it("spawns an rpc pi session in the spawner directory for session mode", () => {
    const { spawner, calls } = makeSpawner();
    const result = spawner.spawn({ name: "Fix login" });
    expect(result.ok).toBe(true);
    expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[0].bin).toBe("pi");
    expect(calls[0].args).toEqual(["--mode", "rpc", "--session-id", result.sessionId, "--name", "Fix login"]);
    expect(calls[0].options.cwd).toBe("/srv/app");
    expect(calls[0].options.env).toMatchObject({ PINET_DIR: "/home/u/.pinet", PINET_SPAWNED: "1" });
    expect(spawner.list()).toHaveLength(1);
  });

  it("generates a hostname-prefixed name when none is given", () => {
    const { spawner } = makeSpawner();
    const result = spawner.spawn();
    expect(result.name).toMatch(/^studio-host-[a-z]+-[a-z]+$/);
  });

  it("enforces capacity", () => {
    const { spawner } = makeSpawner({ max: 2 });
    expect(spawner.spawn().ok).toBe(true);
    expect(spawner.spawn().ok).toBe(true);
    expect(spawner.spawn()).toMatchObject({ ok: false, error: "spawn_capacity" });
  });

  it("refuses to spawn when disabled or in an unsupported mode", () => {
    expect(makeSpawner({ mode: "off" }).spawner.spawn()).toMatchObject({ ok: false, error: "spawn_disabled" });
    expect(makeSpawner({ mode: "worktree" }).spawner.spawn()).toMatchObject({ ok: false, error: "spawn_mode_unavailable:worktree" });
  });

  it("kills children and forgets them", () => {
    const { spawner, children } = makeSpawner();
    const result = spawner.spawn();
    expect(spawner.kill(result.sessionId)).toBe(true);
    expect(children[0].killed).toBe(true);
    expect(spawner.list()).toHaveLength(0);
    expect(spawner.kill(result.sessionId)).toBe(false);
  });

  it("drops a child that exits on its own", () => {
    const { spawner, children } = makeSpawner();
    spawner.spawn();
    children[0].emit("exit");
    expect(spawner.list()).toHaveLength(0);
  });

  it("reports capability", () => {
    const { spawner } = makeSpawner({ git: true, max: 4 });
    expect(spawner.capability()).toMatchObject({ mode: "session", cwd: "/srv/app", git: true, max: 4, active: 0 });
  });

  it("surfaces a spawn failure instead of throwing", () => {
    const spawner = new SessionSpawner({
      cwd: "/tmp",
      spawnFn: () => {
        throw new Error("ENOENT");
      },
    });
    expect(spawner.spawn()).toMatchObject({ ok: false, error: "spawn_failed:ENOENT" });
  });
});

describe("SessionSpawner with tmux (sessions outlive the spawner)", () => {
  function makeTmuxSpawner(overrides = {}) {
    const calls = [];
    const live = new Set();
    const spawner = new SessionSpawner({
      cwd: "/srv/app",
      prefix: "studio",
      tmux: "tmux",
      listSessions: () => [...live].join("\n"),
      spawnFn: (bin, args, options) => {
        calls.push({ bin, args, options });
        if (args[0] === "new-session") live.add(args[3]);
        if (args[0] === "kill-session") live.delete(args[2]);
        return { pid: 1, once() {} };
      },
      ...overrides,
    });
    return { spawner, calls, live };
  }

  it("starts the session in a detached tmux session", () => {
    const { spawner, calls, live } = makeTmuxSpawner();
    const result = spawner.spawn({ name: "fix login" });
    expect(result).toMatchObject({ ok: true, detached: true });
    expect(result.tmuxName).toBe(`pinet-${result.sessionId.slice(0, 8)}`);
    expect(calls[0].bin).toBe("tmux");
    expect(calls[0].args.slice(0, 5)).toEqual(["new-session", "-d", "-s", result.tmuxName, "-c"]);
    expect(calls[0].args[5]).toBe("/srv/app");
    expect(calls[0].args[6]).toBe(`'pi' '--mode' 'rpc' '--session-id' '${result.sessionId}' '--name' 'fix login'`);
    expect(live.has(result.tmuxName)).toBe(true);
    expect(spawner.capability()).toMatchObject({ persistent: true, active: 1 });
  });

  it("does not kill detached sessions on shutdown, so a spawner restart keeps them", () => {
    const { spawner, calls, live } = makeTmuxSpawner();
    const result = spawner.spawn();
    spawner.shutdown();
    expect(calls.map((c) => c.args[0])).toEqual(["new-session"]);
    expect(live.has(result.tmuxName)).toBe(true);
    expect(spawner.list()).toHaveLength(1);
  });

  it("kills a detached session through tmux when asked", () => {
    const { spawner, calls, live } = makeTmuxSpawner();
    const result = spawner.spawn();
    expect(spawner.kill(result.sessionId)).toBe(true);
    expect(calls[1].args).toEqual(["kill-session", "-t", result.tmuxName]);
    expect(live.has(result.tmuxName)).toBe(false);
    expect(spawner.list()).toHaveLength(0);
  });

  it("forgets detached sessions whose tmux session is gone", () => {
    const { spawner, live } = makeTmuxSpawner();
    const first = spawner.spawn();
    expect(spawner.list()).toHaveLength(1);
    live.clear();
    spawner.spawn();
    expect(spawner.list().map((r) => r.sessionId)).not.toContain(first.sessionId);
  });

  it("falls back to a direct child when tmux is missing", () => {
    const { spawner } = makeSpawner();
    const result = spawner.spawn();
    expect(result).toMatchObject({ ok: true, detached: false });
    expect(spawner.capability().persistent).toBe(false);
  });
});
