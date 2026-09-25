// Google OAuth 2.0 (authorization code + PKCE), bring-your-own credentials.
// Endpoints are configurable so the same client works against real Google or
// the bundled mock IdP used by tests.

import { createHash, randomBytes } from "node:crypto";

export const GOOGLE_DEFAULTS = {
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  userinfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
  scope: "openid email profile",
};

export function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export class GoogleOAuth {
  constructor({
    clientId,
    clientSecret,
    redirectUri,
    authUrl = GOOGLE_DEFAULTS.authUrl,
    tokenUrl = GOOGLE_DEFAULTS.tokenUrl,
    userinfoUrl = GOOGLE_DEFAULTS.userinfoUrl,
    scope = GOOGLE_DEFAULTS.scope,
    fetchImpl = fetch,
  }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
    this.authUrl = authUrl;
    this.tokenUrl = tokenUrl;
    this.userinfoUrl = userinfoUrl;
    this.scope = scope;
    this.fetch = fetchImpl;
  }

  createAuthUrl({ state, codeChallenge }) {
    const url = new URL(this.authUrl);
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", this.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", this.scope);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("access_type", "online");
    url.searchParams.set("prompt", "select_account");
    return url.toString();
  }

  async exchangeCode({ code, codeVerifier }) {
    const response = await this.fetch(this.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: codeVerifier,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: this.redirectUri,
      }).toString(),
    });
    if (!response.ok) throw new Error(`token exchange failed: ${response.status}`);
    const tokens = await response.json();
    if (!tokens.access_token) throw new Error("token response missing access_token");
    return tokens;
  }

  async getUserinfo(accessToken) {
    const response = await this.fetch(this.userinfoUrl, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new Error(`userinfo failed: ${response.status}`);
    const profile = await response.json();
    if (!profile.sub || !profile.email) throw new Error("userinfo missing sub/email");
    return { sub: String(profile.sub), email: String(profile.email), name: profile.name ?? profile.email, picture: profile.picture ? String(profile.picture) : null };
  }

  async authenticate({ code, codeVerifier }) {
    const tokens = await this.exchangeCode({ code, codeVerifier });
    return this.getUserinfo(tokens.access_token);
  }
}

/** Local Google-compatible IdP for tests. Verifies PKCE, no network needed. */
export async function startMockGoogleIdp({ user = { sub: "google-sub-1", email: "user@example.com", name: "Test User" } } = {}) {
  const { createServer } = await import("node:http");
  const codes = new Map();
  let currentUser = user;

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state") ?? "";
      const codeChallenge = url.searchParams.get("code_challenge") ?? "";
      if (!redirectUri) return json(400, { error: "missing redirect_uri" });
      const code = randomBytes(8).toString("hex");
      codes.set(code, { redirectUri, state, codeChallenge, user: currentUser });
      res.writeHead(302, { location: `${redirectUri}?code=${code}&state=${encodeURIComponent(state)}` });
      res.end();
      return;
    }
    if (url.pathname === "/token" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const params = new URLSearchParams(body);
        const entry = codes.get(params.get("code"));
        if (!entry) return json(400, { error: "invalid_grant" });
        const verifier = params.get("code_verifier");
        if (!verifier) return json(400, { error: "missing code_verifier" });
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        if (entry.codeChallenge && challenge !== entry.codeChallenge) {
          return json(400, { error: "invalid_grant", error_description: "pkce mismatch" });
        }
        codes.delete(params.get("code"));
        json(200, { access_token: `at_${randomBytes(8).toString("hex")}`, token_type: "Bearer", expires_in: 3600 });
      });
      return;
    }
    if (url.pathname === "/userinfo") {
      const auth = req.headers.authorization ?? "";
      if (!auth.startsWith("Bearer at_")) return json(401, { error: "invalid_token" });
      return json(200, currentUser);
    }
    if (url.pathname === "/picture") {
      // 1x1 transparent PNG, so tests can exercise the avatar proxy.
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64",
      );
      res.writeHead(200, { "content-type": "image/png", "content-length": String(png.length) });
      res.end(png);
      return;
    }
    json(404, { error: "not_found" });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  return {
    url: base,
    authUrl: `${base}/authorize`,
    tokenUrl: `${base}/token`,
    userinfoUrl: `${base}/userinfo`,
    setUser(next) {
      currentUser = next;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
