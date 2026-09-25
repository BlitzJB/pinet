import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMockGoogleIdp } from "../../src/auth/google.mjs";
import { createCoordinator } from "../../src/coordinator/server.mjs";

let idp;
let coord;
let pictureUrl;

beforeAll(async () => {
  idp = await startMockGoogleIdp();
  coord = await createCoordinator({
    config: {
      port: 0,
      host: "127.0.0.1",
      sessionSecret: "avatar-secret",
      serverId: "srv_avatar",
      google: { clientId: "cid", clientSecret: "csec", authUrl: idp.authUrl, tokenUrl: idp.tokenUrl, userinfoUrl: idp.userinfoUrl },
    },
  });
  pictureUrl = `${idp.url}/picture`;
});

afterAll(async () => {
  await coord.close();
  await idp.close();
});

async function loginToken(n, profile = {}) {
  idp.setUser({ sub: `av-${n}`, email: `av${n}@example.com`, name: `AV ${n}`, ...profile });
  const start = await fetch(`${coord.httpUrl}/auth/login`, { redirect: "manual" });
  const authorized = await fetch(start.headers.get("location"), { redirect: "manual" });
  const callback = authorized.headers.get("location");
  const response = await fetch(callback, { redirect: "manual", headers: { accept: "application/json" } });
  return (await response.json()).sessionToken;
}

const bearer = (token) => ({ authorization: `Bearer ${token}` });

describe("OAuth avatar", () => {
  it("exposes a same-origin avatar url and proxies the image", async () => {
    const token = await loginToken(1, { picture: pictureUrl });
    const me = await (await fetch(`${coord.httpUrl}/me`, { headers: bearer(token) })).json();
    expect(me.avatarUrl).toBe("/me/avatar");

    const avatar = await fetch(`${coord.httpUrl}/me/avatar`, { headers: bearer(token) });
    expect(avatar.status).toBe(200);
    expect(avatar.headers.get("content-type")).toBe("image/png");
    const bytes = Buffer.from(await avatar.arrayBuffer());
    expect(bytes.subarray(1, 4).toString()).toBe("PNG");
  });

  it("has no avatar when the provider sends none", async () => {
    const token = await loginToken(2);
    const me = await (await fetch(`${coord.httpUrl}/me`, { headers: bearer(token) })).json();
    expect(me.avatarUrl).toBeNull();
    const avatar = await fetch(`${coord.httpUrl}/me/avatar`, { headers: bearer(token) });
    expect(avatar.status).toBe(404);
  });

  it("requires authentication", async () => {
    const avatar = await fetch(`${coord.httpUrl}/me/avatar`, { redirect: "manual" });
    expect(avatar.status).toBe(401);
  });

  it("refuses to proxy a picture on a non-allowlisted host", async () => {
    const token = await loginToken(3, { picture: "https://not-allowed.example.com/avatar.png" });
    const me = await (await fetch(`${coord.httpUrl}/me`, { headers: bearer(token) })).json();
    expect(me.avatarUrl).toBe("/me/avatar");
    const avatar = await fetch(`${coord.httpUrl}/me/avatar`, { headers: bearer(token) });
    expect(avatar.status).toBe(404);
  });
});
