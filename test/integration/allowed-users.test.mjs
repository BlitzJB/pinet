import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMockGoogleIdp } from "../../src/auth/google.mjs";
import { createCoordinator } from "../../src/coordinator/server.mjs";

let idp;
let coord;

beforeAll(async () => {
  idp = await startMockGoogleIdp();
  coord = await createCoordinator({
    config: {
      port: 0,
      host: "127.0.0.1",
      sessionSecret: "allowed-users-secret",
      serverId: "srv_allowed",
      allowedUsers: "^allowed@example\\.com$",
      google: { clientId: "cid", clientSecret: "csec", authUrl: idp.authUrl, tokenUrl: idp.tokenUrl, userinfoUrl: idp.userinfoUrl },
    },
  });
});

afterAll(async () => {
  await coord.close();
  await idp.close();
});

async function login(email) {
  idp.setUser({ sub: `sub-${email}`, email, name: email });
  const start = await fetch(`${coord.httpUrl}/auth/login`, { redirect: "manual" });
  const authorized = await fetch(start.headers.get("location"), { redirect: "manual" });
  const callback = authorized.headers.get("location");
  return fetch(callback, { redirect: "manual", headers: { accept: "application/json" } });
}

describe("allowed-users pattern", () => {
  it("allows a matching email and creates the account", async () => {
    const response = await login("allowed@example.com");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(typeof body.sessionToken).toBe("string");
    expect(coord.accounts.getAccountByEmail("allowed@example.com")).toBeTruthy();
  });

  it("denies a non-matching email and creates no account", async () => {
    const response = await login("intruder@example.com");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "access_denied" });
    expect(coord.accounts.getAccountByEmail("intruder@example.com")).toBeUndefined();
  });
});
