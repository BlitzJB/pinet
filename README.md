# Pinet

Remote control for [pi](https://pi.dev) coding-agent sessions. A **controller**
(any device, any number) drives a **host** (a machine running pi) through a
**coordinator** (registry + router + fan-out). Three independent entities, Google
SSO with authenticator-app MFA, and end-to-end encryption between controller and
host.

```
 controller(s) ──WSS──► coordinator ◄──WSS── host(s)   (pi processes)
        └────────────── end-to-end encrypted ──────────────┘
```

- [`PROTOCOL.md`](./PROTOCOL.md) — wire protocol (auth, E2E, sessions, commands).
- [`SECURITY.md`](./SECURITY.md) — threat model, controls, residual risks.
- [`deploy/README.md`](./deploy/README.md) — self-hosting the coordinator with systemd + nginx + TLS.
- [`SUCCESS_CRITERIA.md`](./SUCCESS_CRITERIA.md) — verified acceptance criteria.

## Install as a pi package

```bash
# review the source first: pi packages run with full system access
pi install git:github.com/BlitzJB/pinet@v0.1.0
# or try it for one run
pi -e git:github.com/BlitzJB/pinet
```

This registers two extensions:

- `/pinet` — run pi as a **host** (bridge the local session to a coordinator).
- `/portal` — run pi as a **controller** (mount a remote session in this TUI).

Then `/pinet setup` or `/portal setup` onboards via device flow. Disable either
resource with `pi config` if you only want one role on a machine.

## Layout

| Path | Role |
| --- | --- |
| `src/coordinator/` | HTTP auth surface + authenticated WSS gateway + router |
| `src/auth/` | Google OAuth, accounts/MFA, signed sessions, device flow |
| `src/crypto/` | Ed25519/X25519 keys, E2E sealing, TOTP |
| `src/host/bridge.mjs` | host-side encrypted bridge (used by the pi extension) |
| `src/host/onboarding.mjs` | in-pi device-flow onboarding + host key storage |
| `src/host/delivery.mjs`, `command-queue.mjs` | immediate steering + serial execution |
| `src/controller/` | controller client library + optional CLI |
| `src/controller/portal.mjs` | portal mapping: remote stream → local blocks, input → commands |
| `extension/index.ts` | pi host extension (`/pinet` command) |
| `extension/portal.ts` | pi-as-controller portal extension (`/portal` command) |
| `test/` | unit + integration suites (vitest) |

## Prerequisites

- Node.js ≥ 22.19
- A Google OAuth client (bring your own credentials) for SSO
- `pi` for the host

```bash
cd /root/pinet && npm install
```

## 1. Coordinator

Create a Google OAuth **Web application** client and add the redirect URI
`https://<your-hub>/auth/callback` (or `http://localhost:8787/auth/callback` for
local dev). Then:

```bash
PINET_PORT=8787 \
PINET_SESSION_SECRET="$(openssl rand -hex 32)" \
GOOGLE_CLIENT_ID="....apps.googleusercontent.com" \
GOOGLE_CLIENT_SECRET="...." \
GOOGLE_REDIRECT_URI="http://localhost:8787/auth/callback" \
node src/coordinator/server.mjs
```

Endpoints: `GET /health`, `GET /auth/login`, `GET /auth/callback`,
`POST /auth/device/{start,poll,approve}`, `GET /auth/device`,
`POST /auth/mfa/{enroll,activate,verify}`, `POST /devices/register`,
`POST /hosts/enroll/start`, `POST /hosts/enroll`, `GET /me`, `WSS /ws`.

## 2. Set up a host — inside pi

Start pi with the extension and run the command. There is no separate CLI for
onboarding:

```bash
PINET_HUB=ws://localhost:8787/ws PINET_HTTP=http://localhost:8787 \
  pi -e /root/pinet/extension/index.ts
```

```
/pinet setup
```

`/pinet setup` shows a short code and a URL, opens your browser, and waits. Sign
in with Google SSO (and your authenticator-app code if enrolled), enter the
code, and the host enrolls and connects — right there in pi. Use
`/pinet status`, `/pinet reconnect`, and `/pinet logout` afterwards. Status also
appears in pi's status line.

Headless hosts (no browser on the machine) can instead mint a host code from the
controller CLI and pass it in the environment:

```bash
node src/controller/cli.mjs login       # once, on any machine
node src/controller/cli.mjs host-code    # prints a one-time code
PINET_HUB=... PINET_HTTP=... PINET_ENROLL_CODE=ABCD-EFGH pi -e /root/pinet/extension/index.ts
```

## 3. Control it

```bash
node src/controller/cli.mjs login     # once per device
node src/controller/cli.mjs enroll    # register this device's key
node src/controller/cli.mjs           # interactive
```

```
/list
/attach <sessionId>            # control (write)
/attach <sessionId> read       # observe only
write a prompt, it is delivered immediately (steers while pi is running)
/abort  /compact  /model <provider> <id>  /thinking <level>  /rename <name>
```

## Configuration

| Variable | Applies to | Meaning |
| --- | --- | --- |
| `PINET_PORT` / `PINET_HOST` | coordinator | listen address (default 8787 / 0.0.0.0) |
| `PINET_SESSION_SECRET` | coordinator | HMAC secret for session tokens |
| `PINET_SERVER_ID` | coordinator | logical server id |
| `GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI` | coordinator | BYO Google OAuth |
| `GOOGLE_AUTH_URL/TOKEN_URL/USERINFO_URL` | coordinator | endpoint overrides (tests use a mock IdP) |
| `PINET_HUB` | host, controller | coordinator WSS URL |
| `PINET_HTTP` | host, controller | coordinator HTTP origin |
| `PINET_ENROLL_CODE` | host | one-time host enrollment code |
| `PINET_DIR` | host, controller | key/config directory (default `~/.pinet`) |

## Security in one paragraph

Devices authenticate with Ed25519 proof-of-possession; sessions require Google
SSO plus TOTP MFA. The host and controller establish a per-epoch group key
(X25519 + HKDF) and encrypt all session frames and command arguments with
AES-256-GCM bound to routing metadata; controllers sign every command. The
coordinator routes ciphertext and never holds keys, so a compromised coordinator
can disrupt but cannot read or forge. See [`SECURITY.md`](./SECURITY.md) for the
full threat model and residual risks (notably first-use key pinning and the
absence of host-side approval guardrails).

## Pi as a portal (pi drives a remote pi)

A local pi can itself be a controller: its TUI renders the remote session's
blocks and whatever you type is forwarded to the remote host as an encrypted,
signed command. The local agent is bypassed while attached.

```bash
PINET_HUB=ws://localhost:8787/ws PINET_HTTP=http://localhost:8787 \
  pi -e /root/pinet/extension/portal.ts
```

```
/portal setup              # enroll this pi as a controller (device flow)
/portal sessions           # list remote sessions
/portal attach <sessionId> # mount the remote session into this TUI
<type>                     # sent to the remote agent (immediate / steer)
/portal detach             # return to the local agent
```

Remote entries (user text, assistant text, tool calls/results, model changes)
are appended to the local transcript via custom entries, so the local LLM context
is not polluted. `src/controller/portal.mjs` holds the mapping and is unit
+ end-to-end tested.

## Writing another client (web, mobile, …)

The client is a protocol, not a Node library. Any runtime with a WebSocket and
the `CryptoProvider` primitives can speak it; the reference controller is
runtime-agnostic and takes an injected `crypto`:

```js
import { PinetController } from "./src/controller/client.mjs";
import { webCryptoProvider } from "./src/crypto/webcrypto.mjs";

const controller = new PinetController({
  url: "wss://hub.example/ws",
  deviceId, identity, encryption,      // keypairs from your provider
  crypto: webCryptoProvider,           // browser/Deno/Bun; Node is the default
});
```

- **Interface**: `src/crypto/provider.mjs` (Node reference) defines the
  `CryptoProvider` contract; `src/crypto/webcrypto.mjs` implements it with
  `globalThis.crypto.subtle`. `src/crypto/session-crypto.mjs` is the
  provider-agnostic key-wrap / frame-crypto layer.
- **The exact wire + crypto spec** (encodings, canonical JSON, HKDF/AES
  parameters, AAD shapes) is in [`PROTOCOL.md`](./PROTOCOL.md) §11.
- **Conformance vectors**: `test/fixtures/conformance.json` — a fixed keypair,
  signed handshake, wrapped key, encrypted frame and signed command. A new client
  must verify/decrypt them; the suite runs them under both the Node and WebCrypto
  providers. Regenerate with `npm run conformance:generate`.
- **Proof it works cross-runtime**: `test/integration/webcrypto-client.test.mjs`
  runs a WebCrypto controller (browser-style) against a Node host end to end.

## Network resilience

Both sides survive uncontrolled networks. Hosts and controllers use a
reconnecting socket (exponential backoff + jitter, 500 ms → 15 s cap) with an
application heartbeat that detects half-open connections (dead Wi-Fi/cellular,
sleeps, NAT rebinding) — not just clean disconnects.

- **Host reconnect**: rotates the session epoch and group key, re-wraps the key
  for every known controller, and sends a fresh snapshot.
- **Controller reconnect**: re-attaches every session and resyncs; remote
  entries are id-keyed so nothing double-renders.
- **Commands across a drop**: a command waits for the connection, re-seals with
  the current key, and retries only if the send itself failed — never a silent
  duplicate. If no ack arrives you get an explicit "verify the remote" error.
- A deliberate `close()` disables reconnection.

See [`PROTOCOL.md`](./PROTOCOL.md) §12.

## Self-hosting the coordinator

`deploy/` contains a systemd unit, an nginx vhost (HTTP + WebSocket), and an
idempotent installer:

```bash
sudo DOMAIN=hub.example.com ./deploy/install.sh
sudo certbot --nginx -d hub.example.com --redirect --agree-tos -m you@example.com
```

See [`deploy/README.md`](./deploy/README.md) for DNS, secrets, Google OAuth,
and operations.

## Tests

```bash
npm test               # unit + integration (vitest)
npm run test:unit
npm run test:integration
```

The suite needs no network and no model: it drives a mock Google IdP, generates
TOTP codes locally, and (when `pi` is available) spawns a real pi process to
verify enrollment, session registration and encrypted snapshot delivery.
