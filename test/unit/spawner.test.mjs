import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    // A tmux pane does not inherit our environment, so the spawn marker travels in
    // the command itself: that is what makes the session mount on startup.
    expect(calls[0].args[6]).toBe(`env PINET_SPAWNED=1 'pi' '--mode' 'rpc' '--session-id' '${result.sessionId}' '--name' 'fix login'`);
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

describe("spawner: directory scope", () => {
  const tree = () => {
    const root = mkdtempSync(join(tmpdir(), "pinet-scope-"));
    mkdirSync(join(root, "apps", "web"), { recursive: true });
    mkdirSync(join(root, "node_modules", "x"), { recursive: true });
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, "file.txt"), "x");
    const outside = mkdtempSync(join(tmpdir(), "pinet-outside-"));
    symlinkSync(outside, join(root, "escape"));
    return { root, outside };
  };

  const spawnerFor = (root) => new SessionSpawner({ cwd: root, tmux: null, spawnFn: () => fakeChild(), env: {} });

  it("resolves the root and anything under it", () => {
    const { root } = tree();
    const spawner = spawnerFor(root);
    const real = realpathSync(root);
    expect(spawner.resolveDir()).toBe(real);
    expect(spawner.resolveDir(".")).toBe(real);
    expect(spawner.resolveDir("apps/web")).toBe(join(real, "apps", "web"));
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses to escape the scope, by any route", () => {
    const { root, outside } = tree();
    const spawner = spawnerFor(root);
    expect(spawner.resolveDir("..")).toBeUndefined();
    expect(spawner.resolveDir("../..")).toBeUndefined();
    expect(spawner.resolveDir("/etc")).toBeUndefined();
    expect(spawner.resolveDir(outside)).toBeUndefined();
    // A symlink inside the scope that points outside it is the interesting case.
    expect(spawner.resolveDir("escape")).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("refuses things that are not directories", () => {
    const { root } = tree();
    const spawner = spawnerFor(root);
    expect(spawner.resolveDir("file.txt")).toBeUndefined();
    expect(spawner.resolveDir("nope")).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });

  it("lists subdirectories, quietly", () => {
    const { root } = tree();
    const { entries, path } = spawnerFor(root).directories();
    expect(path).toBe(".");
    expect(entries).toContain("apps");
    expect(entries).not.toContain("node_modules");
    expect(entries).not.toContain(".git");
    rmSync(root, { recursive: true, force: true });
  });

  it("only lists inside the scope and walks down by relative path", () => {
    const { root, outside } = tree();
    const spawner = spawnerFor(root);
    expect(spawner.directories("../..").ok).toBe(false);
    expect(spawner.directories(outside).error).toBe("dir_out_of_scope");
    const nested = spawner.directories("apps");
    expect(nested.ok).toBe(true);
    expect(nested.path).toBe("apps");
    expect(nested.entries).toEqual(["web"]);
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("spawns into the chosen subdirectory", () => {
    const { root } = tree();
    const calls = [];
    const spawner = new SessionSpawner({
      cwd: root,
      tmux: "tmux",
      spawnFn: (bin, args) => {
        calls.push({ bin, args });
        return fakeChild();
      },
      env: {},
    });
    const real = realpathSync(root);
    const result = spawner.spawn({ dir: "apps/web" });
    expect(result.ok).toBe(true);
    expect(result.cwd).toBe(join(real, "apps", "web"));
    expect(calls[0].args).toContain(join(real, "apps", "web"));
    // And an escape attempt is refused before anything is spawned.
    expect(spawner.spawn({ dir: "../.." })).toMatchObject({ ok: false, error: "dir_out_of_scope" });
    expect(calls).toHaveLength(1);
    rmSync(root, { recursive: true, force: true });
  });
});
