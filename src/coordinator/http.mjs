// HTTP surface: Google SSO, MFA enrollment/verification, device and host
// enrollment, and account inspection. Thin adapter over AuthService + store.

import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isValidPublicKey } from "../crypto/keys.mjs";
import { qrSvg } from "./qr.mjs";
import { createRateLimiter } from "./rate-limit.mjs";

const DEFAULT_WEB_DIR = fileURLToPath(new URL("../../web/dist/", import.meta.url));
const MAX_BODY_BYTES = 64 * 1024;
const MAX_NAME_LENGTH = 120;

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function contentType(path) {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function securityHeaders(req, publicUrl) {
  const https =
    String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() === "https" ||
    (publicUrl ?? "").startsWith("https://");
  const headers = {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "cross-origin-opener-policy": "same-origin",
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; font-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  };
  if (https) headers["strict-transport-security"] = "max-age=31536000; includeSubDomains";
  return headers;
}

/** Serve the built SPA from webDir, with an index.html fallback for client routes. */
async function serveWebApp(res, webDir, pathname) {
  const root = resolve(webDir);
  const relative = pathname.replace(/^\/app\/?/u, "");
  const candidate = resolve(root, relative || "index.html");
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    const info = await stat(candidate);
    if (info.isFile()) {
      const data = await readFile(candidate);
      const immutable = candidate.includes(`${sep}assets${sep}`);
      res.writeHead(200, {
        "content-type": contentType(candidate),
        "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      });
      res.end(data);
      return;
    }
  } catch {
    // fall through to SPA fallback
  }
  try {
    const data = await readFile(resolve(root, "index.html"));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
    res.end(data);
  } catch {
    res.writeHead(503, { "content-type": "text/html; charset=utf-8" });
    res.end(
      "<!doctype html><meta charset=utf-8><body style='font-family:system-ui;max-width:40rem;margin:3rem auto'>" +
        "<h1>Pinet web app not built</h1><p>Run <code>npm --prefix web install &amp;&amp; npm --prefix web run build</code>, then restart the coordinator.</p>",
    );
  }
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function redirect(res, location, headers = {}) {
  res.writeHead(302, { location, ...headers });
  res.end();
}

function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function setCookie(name, value, { maxAge = 604800, secure = false } = {}) {
  const attrs = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

function isHttps(req, publicUrl) {
  return (
    String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() === "https" ||
    (publicUrl ?? "").startsWith("https://")
  );
}

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("payload too large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  const type = req.headers["content-type"] ?? "";
  if (type.includes("application/json")) {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

function wantsJson(req, url) {
  const accept = req.headers.accept ?? "";
  const contentType = req.headers["content-type"] ?? "";
  return (
    accept.includes("application/json") ||
    contentType.includes("application/json") ||
    url.searchParams.get("format") === "json"
  );
}

function isAllowedReturnTo(value) {
  if (!value) return "/";
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "/";
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return "/";
    return value;
  } catch {
    return "/";
  }
}

function isLoopbackReturnTo(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  } catch {
    return false;
  }
}

function withQuery(value, key, replacement) {
  const url = new URL(value, "http://localhost");
  url.searchParams.set(key, replacement);
  return url.toString();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function devicePage(code, message) {
  return `<!doctype html><meta charset="utf-8"><title>Pinet</title>
  <h2>Pinet device login</h2>
  ${message ? `<p>${escapeHtml(message)}</p>` : "<p>Enter the code shown in pi to connect this device.</p>"}
  <form method="post" action="/auth/device/approve">
    <input name="userCode" value="${escapeHtml(code)}" placeholder="XXXX-XXXX" autocomplete="one-time-code" autofocus/>
    <button type="submit">Approve</button>
  </form>`;
}

function page(title, body) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><body style="font-family:system-ui;max-width:640px;margin:2rem auto;padding:0 1rem;line-height:1.5">${body}</body>`;
}

function mfaPage(pending, returnTo) {
  return page(
    "Pinet — verify",
    `<h1>Verify it's you</h1>
     <form method="post" action="/auth/mfa/verify">
       <input type="hidden" name="pending" value="${escapeHtml(pending)}"/>
       <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}"/>
       <input name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" autofocus/>
       <button type="submit">Verify</button>
     </form>`,
  );
}

function mfaSetupPage({ email, secret, uri, recoveryCodes, error }) {
  const grouped = secret.replace(/(.{4})/gu, "$1 ").trim();
  const qr = qrSvg(uri, { cellSize: 4, margin: 2 });
  const codes = recoveryCodes
    ? `<h3>Recovery codes</h3><p>Save these now. Each works once.</p><pre>${recoveryCodes.map(escapeHtml).join("\n")}</pre>`
    : `<p><em>Recovery codes were shown when you first opened this page.</em></p>`;
  return page(
    "Pinet — set up MFA",
    `<h1>Set up multi-factor authentication</h1>
     <p>Account: <b>${escapeHtml(email)}</b></p>
     ${error ? `<p style="color:#c5221f">${escapeHtml(error)}</p>` : ""}
     <p>Scan this with your authenticator app:</p>
     ${qr ? `<div style="background:#fff;padding:10px;border-radius:8px;display:inline-block">${qr}</div>` : "<p>(QR unavailable; use the key below)</p>"}
     <p>Or enter this key manually:<br><code style="user-select:all;font-size:1.1em">${escapeHtml(grouped)}</code></p>
     <p style="word-break:break-all"><small>${escapeHtml(uri)}</small></p>
     ${codes}
     <form method="post" action="/auth/mfa/activate">
       <input name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" autofocus/>
       <button type="submit">Activate</button>
     </form>`,
  );
}

function validKeys(body) {
  return isValidPublicKey(body.identityPub, "ed25519") && isValidPublicKey(body.encPub, "x25519");
}

export function createHttpHandler({ accounts, authService, publicUrl, webDir = DEFAULT_WEB_DIR }) {
  const globalLimiter = createRateLimiter({ windowMs: 60_000, max: 300 });
  const sensitiveLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });

  function session(req) {
    const auth = req.headers.authorization ?? "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
    const token = bearer ?? parseCookies(req.headers.cookie).pinet_session;
    if (!token) return null;
    return authService.verifySession(token);
  }

  return async function handle(req, res) {
    // Attach security headers to every response.
    const baseHeaders = securityHeaders(req, publicUrl);
    const originalWriteHead = res.writeHead.bind(res);
    res.writeHead = (status, headers) =>
      originalWriteHead(status, { ...baseHeaders, ...(headers && typeof headers === "object" ? headers : {}) });

    const url = new URL(req.url, "http://localhost");
    const route = `${req.method} ${url.pathname}`;
    try {
      // Rate limiting.
      const ip = clientIp(req);
      if (!globalLimiter.check(`all:${ip}`)) return json(res, 429, { error: "rate_limited" });
      if (/^\/(auth|devices|hosts)\b/u.test(url.pathname) && !sensitiveLimiter.check(`auth:${ip}`)) {
        return json(res, 429, { error: "rate_limited" });
      }

      if (route === "GET /health") return json(res, 200, { ok: true });

      // ---- web app (Vite SPA) ----
      if (route === "GET /app") return redirect(res, "/app/");
      if (req.method === "GET" && (url.pathname === "/app/" || url.pathname.startsWith("/app/"))) {
        return serveWebApp(res, webDir, url.pathname);
      }

      if (route === "GET /auth/login") {
        const returnTo = isAllowedReturnTo(url.searchParams.get("return_to"));
        const { url: authUrl } = authService.startLogin({ returnTo });
        return redirect(res, authUrl);
      }

      if (route === "GET /auth/callback") {
        let result;
        try {
          result = await authService.handleCallback({
            code: url.searchParams.get("code"),
            state: url.searchParams.get("state"),
          });
        } catch (error) {
          if (error?.code === "access_denied") {
            if (wantsJson(req, url)) return json(res, 403, { error: "access_denied" });
            res.writeHead(403, { "content-type": "text/html" });
            res.end(page("Pinet — access denied", "<h1>Access denied</h1><p>This account is not permitted to use this Pinet hub.</p>"));
            return;
          }
          throw error;
        }
        const returnTo = result.returnTo ?? "/";
        if (result.mfaRequired) {
          const target = `/auth/mfa?pending=${encodeURIComponent(result.pendingToken)}&return_to=${encodeURIComponent(returnTo)}`;
          if (wantsJson(req, url)) return json(res, 200, { mfaRequired: true, pendingToken: result.pendingToken, returnTo });
          return redirect(res, target);
        }
        if (wantsJson(req, url)) return json(res, 200, { mfaRequired: false, sessionToken: result.sessionToken, returnTo });
        return finishBrowserLogin(req, res, returnTo, result.accountId, result.sessionToken, false);
      }

      if (route === "POST /auth/mfa/verify") {
        const body = await readBody(req);
        const pending = body.pending ?? url.searchParams.get("pending");
        const { sessionToken, accountId } = authService.completeMfa({
          pendingToken: pending,
          code: body.code,
          recoveryCode: body.recoveryCode,
        });
        if (wantsJson(req, url)) return json(res, 200, { sessionToken, accountId });
        const returnTo = isAllowedReturnTo(body.return_to ?? url.searchParams.get("return_to") ?? "/");
        return finishBrowserLogin(req, res, returnTo, accountId, sessionToken, true);
      }

      if (route === "POST /auth/cli/exchange") {
        const body = await readBody(req);
        const result = authService.exchangeLoginCode(String(body.code ?? ""));
        if (!result) return json(res, 400, { error: "invalid_code" });
        return json(res, 200, { sessionToken: result.sessionToken, accountId: result.accountId });
      }

      if (route === "GET /auth/mfa") {
        const pending = url.searchParams.get("pending") ?? "";
        const returnTo = url.searchParams.get("return_to") ?? "/";
        res.writeHead(200, { "content-type": "text/html" });
        res.end(mfaPage(pending, returnTo));
        return;
      }

      // ---- device authorization (powers in-pi onboarding) ----
      const current = session(req);

      if (route === "POST /auth/device/start") {
        const flow = authService.startDeviceFlow();
        const base = publicUrl ?? `http://${req.headers.host ?? "localhost"}`;
        return json(res, 200, { ...flow, verificationUri: `${base}/auth/device?code=${encodeURIComponent(flow.userCode)}` });
      }

      if (route === "POST /auth/device/poll") {
        const body = await readBody(req);
        return json(res, 200, authService.pollDeviceFlow(String(body.deviceCode ?? "")));
      }

      if (route === "GET /auth/device") {
        const code = url.searchParams.get("code") ?? "";
        if (!current) {
          const returnTo = `/auth/device${code ? `?code=${encodeURIComponent(code)}` : ""}`;
          return redirect(res, `/auth/login?return_to=${encodeURIComponent(returnTo)}`);
        }
        res.writeHead(200, { "content-type": "text/html" });
        res.end(devicePage(code));
        return;
      }

      if (route === "POST /auth/device/approve") {
        if (!current) return json(res, 401, { error: "unauthorized" });
        const body = await readBody(req);
        const result = authService.approveDeviceFlow(String(body.userCode ?? ""), current.accountId, current.mfa);
        if (!result.ok) return json(res, result.reason === "unknown_code" ? 404 : 400, { ok: false, reason: result.reason });
        if (wantsJson(req, url)) return json(res, 200, { ok: true });
        res.writeHead(200, { "content-type": "text/html" });
        res.end(devicePage("", "Device approved. You can return to pi."));
        return;
      }

      // ---- authenticated endpoints ----
      const protectedPath =
        url.pathname === "/me" ||
        url.pathname === "/auth/mfa/enroll" ||
        url.pathname === "/auth/mfa/activate" ||
        url.pathname.startsWith("/devices") ||
        url.pathname === "/hosts/enroll/start";
      if (protectedPath && !current) return json(res, 401, { error: "unauthorized" });

      if (route === "GET /me") {
        const account = accounts.getAccount(current.accountId);
        return json(res, 200, {
          accountId: account.id,
          email: account.email,
          name: account.name,
          mfaEnrolled: account.mfa.enrolled,
          devices: accounts.listDevices(account.id).map((d) => ({ id: d.id, kind: d.kind, name: d.name, revoked: d.revoked })),
        });
      }

      if (route === "POST /auth/mfa/enroll") {
        const account = accounts.getAccount(current.accountId);
        if (account.mfa.enrolled) return json(res, 409, { error: "already_enrolled" });
        const enrollment = authService.enrollMfa(current.accountId);
        return json(res, 200, enrollment);
      }

      if (route === "POST /auth/mfa/activate") {
        const body = await readBody(req);
        const ok = authService.activateMfa(current.accountId, String(body.code ?? ""));
        if (wantsJson(req, url)) return json(res, ok ? 200 : 400, { ok });
        return redirect(res, ok ? "/?mfa=enrolled" : "/auth/mfa/setup?error=Invalid+code");
      }

      if (route === "GET /auth/mfa/setup") {
        if (!current) return redirect(res, "/auth/login?return_to=%2Fauth%2Fmfa%2Fsetup");
        const account = accounts.getAccount(current.accountId);
        if (account.mfa.enrolled) {
          res.writeHead(200, { "content-type": "text/html" });
          res.end(page("Pinet — MFA", `<h1>MFA enabled</h1><p>An authenticator app is already enrolled for ${escapeHtml(account.email)}.</p><p><a href="/">Back</a></p>`));
          return;
        }
        const enrollment = authService.enrollMfa(current.accountId);
        res.writeHead(200, { "content-type": "text/html" });
        res.end(
          mfaSetupPage({
            email: account.email,
            secret: enrollment.secret,
            uri: enrollment.uri,
            recoveryCodes: enrollment.recoveryCodes,
            error: url.searchParams.get("error") ?? undefined,
          }),
        );
        return;
      }

      if (route === "POST /auth/logout") {
        return redirect(res, "/", { "set-cookie": "pinet_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" });
      }

      if (route === "POST /devices/register") {
        const body = await readBody(req);
        if (!validKeys(body)) return json(res, 400, { error: "invalid_keys" });
        const device = accounts.registerDevice({
          accountId: current.accountId,
          kind: body.kind === "host" ? "host" : "controller",
          name: String(body.name ?? "device").slice(0, MAX_NAME_LENGTH),
          identityPub: body.identityPub,
          encPub: body.encPub,
        });
        return json(res, 200, { deviceId: device.id, fingerprint: device.fingerprint, kind: device.kind });
      }

      if (route === "GET /devices") {
        return json(res, 200, {
          devices: accounts.listDevices(current.accountId).map((d) => ({
            id: d.id,
            kind: d.kind,
            name: d.name,
            revoked: d.revoked,
            fingerprint: d.fingerprint,
          })),
        });
      }

      if (route === "POST /devices/revoke") {
        const body = await readBody(req);
        const device = accounts.getDevice(String(body.deviceId ?? ""));
        if (!device || device.accountId !== current.accountId) return json(res, 404, { error: "not_found" });
        accounts.revokeDevice(device.id);
        return json(res, 200, { ok: true });
      }

      if (route === "POST /hosts/enroll/start") {
        const enrollment = accounts.createHostEnrollment(current.accountId);
        return json(res, 200, enrollment);
      }

      if (route === "POST /hosts/enroll") {
        const body = await readBody(req);
        const consumed = accounts.consumeHostEnrollment(String(body.code ?? "").trim().toUpperCase());
        if (!consumed) return json(res, 400, { error: "invalid_or_expired_code" });
        if (!validKeys(body)) return json(res, 400, { error: "invalid_keys" });
        const device = accounts.registerDevice({
          accountId: consumed.accountId,
          kind: "host",
          name: String(body.name ?? "host").slice(0, MAX_NAME_LENGTH),
          identityPub: body.identityPub,
          encPub: body.encPub,
        });
        return json(res, 200, { hostId: device.id, accountId: consumed.accountId, fingerprint: device.fingerprint });
      }

      // ---- landing page ----
      if (route === "GET /") return redirect(res, "/app/");

      return json(res, 404, { error: "not_found" });
    } catch (error) {
      if (error?.status) return json(res, error.status, { error: error.status === 413 ? "payload_too_large" : "error" });
      const id = randomUUID().slice(0, 8);
      console.error(`[hub] request error (${id}):`, error?.message ?? error);
      return json(res, 500, { error: "internal_error", id });
    }
  };

  /** Set the session cookie and redirect — never place the token in the URL.
   *  Native/CLI loopback logins receive a single-use code they exchange. */
  function finishBrowserLogin(req, res, returnTo, accountId, sessionToken, mfa) {
    const headers = { "set-cookie": setCookie("pinet_session", sessionToken, { secure: isHttps(req, publicUrl) }) };
    if (isLoopbackReturnTo(returnTo)) {
      const code = authService.issueLoginCode(accountId, mfa);
      return redirect(res, withQuery(returnTo, "code", code), headers);
    }
    return redirect(res, returnTo, headers);
  }
}
