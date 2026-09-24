import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCoordinator } from "../../src/coordinator/server.mjs";

let coord;
let dir;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pinet-web-"));
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), "<!doctype html><div id=root>PINET_SPA</div>");
  writeFileSync(join(dir, "assets", "app-abc123.js"), "console.log('pinet');");
  coord = await createCoordinator({
    config: { port: 0, host: "127.0.0.1", sessionSecret: "web-secret", serverId: "srv_web", webDir: dir },
  });
});

afterAll(async () => {
  await coord.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("web app serving", () => {
  it("redirects / and /app to the app root", async () => {
    const root = await fetch(`${coord.httpUrl}/`, { redirect: "manual" });
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe("/app/");
  });

  it("serves index.html at /app/", async () => {
    const response = await fetch(`${coord.httpUrl}/app/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("PINET_SPA");
  });

  it("serves hashed assets with a long cache and correct type", async () => {
    const response = await fetch(`${coord.httpUrl}/app/assets/app-abc123.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("javascript");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(await response.text()).toContain("pinet");
  });

  it("falls back to index.html for client-side routes", async () => {
    const response = await fetch(`${coord.httpUrl}/app/s/session-1`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("PINET_SPA");
  });

  it("still serves /health and does not shadow auth routes", async () => {
    expect(await (await fetch(`${coord.httpUrl}/health`)).json()).toEqual({ ok: true });
    const login = await fetch(`${coord.httpUrl}/auth/login`, { redirect: "manual" });
    expect(login.status).toBe(302);
  });
});
