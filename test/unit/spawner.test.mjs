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
