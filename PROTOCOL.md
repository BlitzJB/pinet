# Pinet Protocol v1

Remote control for pi coding-agent sessions across three independent trust
domains: **controllers** (any device), the **coordinator** (registry + router),
and **hosts** (machines running pi). The host is authoritative; the coordinator
is a shallow, zero-knowledge router.

```
 controller(s) ──WSS──► coordinator ◄──WSS── host(s)   (pi processes)
        └────────────── end-to-end encrypted ──────────────┘
```

## 1. Identifiers

```
Account
  ├── Controller device   Ed25519 identity + X25519 encryption key
  └── Host device         Ed25519 identity + X25519 encryption key
        └── SessionId     globally unique (pi session UUID)
              └── Epoch   hosting incarnation / key rotation
                    └── AttachmentId   one controller's route to one session
```

## 2. Transports

- **HTTP** — SSO, MFA, enrollment.
- **WSS** at `/ws` — all live traffic; both hosts and controllers dial outbound.

## 3. Authentication

### 3.1 Google SSO (bring your own credentials)

`GET /auth/login` starts the authorization-code + PKCE flow against the
configured Google endpoints. Endpoints and credentials are operator-supplied
(`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, plus
`GOOGLE_AUTH_URL`/`GOOGLE_TOKEN_URL`/`GOOGLE_USERINFO_URL` overrides). The
callback upserts an account by verified `sub`/`email` and issues an HMAC-signed
session token (cookie `pinet_session` for browsers, `Authorization: Bearer` for
API/CLI).

### 3.2 MFA (authenticator apps)

- `POST /auth/mfa/enroll` → `{ secret, uri, recoveryCodes }` (secret is base32,
  `uri` is `otpauth://`). Fails if already enrolled.
- `POST /auth/mfa/activate { code }` → activates the factor.
- On every later login the callback returns a **pending** token; the client must
  call `POST /auth/mfa/verify { pending, code }` (or `{ pending, recoveryCode }`)
  to obtain a full session. Pending tokens are rejected by `verifySession`.
- TOTP is RFC 6238 (SHA-1, 6 digits, 30 s) with a ±1 step window. Reusing a
  counter is rejected. Recovery codes are stored hashed and single-use.

### 3.3 Device enrollment

- Controller: `POST /devices/register { kind, name, identityPub, encPub }`
  (requires a full session) → `{ deviceId, fingerprint }`.
- Host: `POST /hosts/enroll/start` (requires a session) → one-time code;
  `POST /hosts/enroll { code, name, identityPub, encPub }` → `{ hostId }`.
  Codes are single-use and expiring.

### 3.4 Device authorization (in-pi onboarding)

The pi extension onboards without a separate CLI using an RFC 8628-style
flow:

- `POST /auth/device/start` → `{ deviceCode, userCode, verificationUri,
  expiresIn, interval }`. `deviceCode` is a secret polled by the client;
  `userCode` (e.g. `ABCD-EFGH`) is shown to the user.
- The user opens `verificationUri` (`/auth/device?code=…`), authenticates with
  Google SSO + MFA, and approves. If not signed in, the page redirects to
  `/auth/login` with a same-origin `return_to`.
- `POST /auth/device/approve { userCode }` (authenticated) marks the flow
  approved and mints a session token for it.
- `POST /auth/device/poll { deviceCode }` returns `pending`, or `approved` with
  a one-time `sessionToken`, or `expired`/`invalid`.

The host uses that session token to register itself (`POST /devices/register`
with `kind:"host"`) and persists its keys. The whole sequence runs inside pi via
`/pinet setup`.

### 3.5 WebSocket challenge-response

On connect the coordinator sends `auth.challenge { nonce, serverId, ts }`. The
device replies:

```jsonc
{ "type":"hello", "data":{ "role":"host|controller", "deviceId":"...",
  "timestamp": 1789..., "signature":"<Ed25519>" } }
```

where `signature` signs `canonicalJson({ nonce, serverId, timestamp, role, deviceId })`.
The coordinator verifies the device exists, matches the role, is not revoked, the
timestamp is within 60 s, and the signature is valid. It replies `auth.ok` and the
connection becomes role-scoped. Replayed handshakes fail (per-connection nonce).

## 4. Authorization

- Only devices of the owning account can list/attach/command its sessions.
- `mode:"read"` observes; `mode:"control"` may command. Read-only commands are
  rejected with `read_only`.
- Commands for an unattached session are rejected (`not_attached`); for an
  offline host, `host_unavailable`.

## 5. End-to-end encryption

The coordinator never holds keys and cannot read session content or commands.

- The host generates a random 32-byte **group key per session epoch**.
- For each attached controller it wraps the group key with **ephemeral-static
  X25519 + HKDF-SHA256 + AES-256-GCM**; the wrapped blob is relayed as `e2e.key`.
  AAD binds `{ sessionId, epoch, deviceId }`.
- Session frames are sealed with the group key; AAD binds
  `{ sessionId, epoch, seq, type }`.
- Commands: the controller seals `args` with the group key using AAD
  `{ sessionId, commandId, epoch, op, deviceId }`, then signs
  `canonicalJson({ sessionId, commandId, epoch, op, deviceId, enc })` with its
  Ed25519 key. The host verifies the signature, checks the epoch and command-id
  uniqueness, then decrypts.

Hosts pin a controller's identity key on first use (TOFU) and reject a later key
change for the same device id.

## 6. Session stream

A session is pi's append-only entry tree plus ephemeral status. Frames, each
carrying `{ sessionId, epoch, seq }`:

| Type | Meaning | Durability |
|---|---|---|
| `session.snapshot` | full state: `entries`, `status`, `meta`, `leafId` | durable |
| `session.entries` | appended entries since `seq` | durable |
| `session.rebase` | derived state invalid (compaction/fork/tree-nav) | durable |
| `session.status` | `{ phase, isIdle, model, thinkingLevel, contextUsage, runningTools }` | ephemeral |
| `session.meta` | `{ name, cwd, host }` | durable-ish |
| `session.removed` | session gone | durable |

Token-level deltas are never relayed. Durable frames must be delivered;
ephemeral status may be dropped. A late-joining controller receives `e2e.key`
then a fresh encrypted snapshot, both triggered by `host.attach`.

## 7. Commands

Controller → coordinator `ctl.command`, coordinator → host `cmd.deliver`, host
ack `cmd.ack`.

| op | args | host action |
|---|---|---|
| `prompt` | `{ text, images?, deliverAs? }` | `pi.sendUserMessage` |
| `abort` | `{}` | `ctx.abort()` |
| `compact` | `{ instructions? }` | `ctx.compact()` |
| `set_model` | `{ provider, modelId }` | `pi.setModel()` |
| `set_thinking` | `{ level }` | `pi.setThinkingLevel()` |
| `rename` | `{ name }` | `pi.setSessionName()` |

`cmd.ack` reports `{ accepted, mode, error }` where `mode` is `immediate`,
`steer`, or `followUp`.

**Immediate delivery.** When the host is idle a prompt is delivered immediately
(`immediate`). When the host is running, a prompt is injected immediately as a
**steering** message (`steer`), exactly like a local user steering the active
turn — it is not queued as a follow-up unless the controller explicitly asks for
`deliverAs:"followUp"`. The host never defers a received command waiting for a
turn to end.

**Write authority.** There is no write lease. Any authorized `control`
attachment may command. The host executes commands through a serial queue and
acknowledges each one; effects are broadcast to every attached controller as
durable entries. Command ids are idempotent within a host runtime.

## 8. Multi-host / multi-controller

`SessionId` is globally unique; the coordinator maps it to a host. Sessions on
different hosts are routed and keyed independently. One session may have many
attachments; fan-out is one host copy to N controller copies.

## 9. Failure and reconnect

- Controller reconnect: re-auth, re-attach; the host sends `e2e.key` + a fresh
  snapshot. Commands are not replayed; retries use the same `commandId`.
- Host offline: sessions remain in the catalog with `hostConnected:false`; live
  streaming stops.
- Host restart / session resume: `epoch++`, keys rotate, controllers resnapshot.
- The coordinator holds no authoritative state and is replaceable.

## 10. Error codes

`bad_json`, `unknown_type`, `handshake_required`, `unauthorized`, `bad_signature`,
`stale`, `no_session`, `not_attached`, `read_only`, `host_unavailable`,
`stale_epoch`, `decrypt_failed`, `empty_prompt`, `model_not_found`,
`unknown_op`, `internal`.

## 11. Client implementer's guide (any runtime)

The client protocol is deliberately implementation-agnostic. A controller needs
only a WebSocket with text frames and the primitives below; there are no
Node-specific requirements. The reference implementation injects these via a
`CryptoProvider`, so the same client code runs on Node and in browsers (see
`src/crypto/webcrypto.mjs`). A pi TUI acting as a portal is just another
controller: `extension/portal.ts` renders the remote stream locally and forwards
typed input, with no protocol special-casing.

### 11.1 CryptoProvider interface

```
generateIdentityKeypair()            -> { publicKey, privateKey }   Ed25519
generateEncryptionKeypair()          -> { publicKey, privateKey }   X25519
exportPublicKey(handle)              -> base64 DER (spki)
importPublicKey(base64Der, kind)     -> handle   kind: "identity" | "encryption"
importPrivateKey(base64Der, kind)    -> handle
sign(message, privateKey)            -> base64 signature (message = canonical JSON string)
verify(message, signatureB64, pub)   -> boolean
ecdh(privateKey, publicKeyHandle)    -> Uint8Array shared secret
hkdf(ikm, info, length)              -> Uint8Array   (HKDF-SHA256, empty salt)
encrypt(key, plaintext, aad)         -> { n, ct, tag }  base64
decrypt(key, box, aad)               -> Uint8Array
randomBytes(n)                       -> Uint8Array
```

### 11.2 Encodings and primitives (exact)

- **Keys**: base64 (standard) of DER `spki` (public) / `pkcs8` (private), for
  Ed25519 and X25519. WebCrypto imports/exports exactly this.
- **Canonical JSON**: recursively sort object keys ascending by UTF-16 code
  unit, preserve array order, omit keys whose value is `undefined`, reject
  non-finite numbers, emit no whitespace. `JSON.stringify` after normalization.
- **AAD**: the UTF-8 bytes of canonical JSON of the bound object.
  - key wrap: `{ sessionId, epoch, deviceId }`
  - frame: `{ sessionId, epoch, seq, type }`
  - command: `{ sessionId, commandId, epoch, op, deviceId }`
- **HKDF**: SHA-256, empty salt, `info` = AAD bytes, output 32 bytes.
- **AEAD**: AES-256-GCM, random 96-bit IV, 128-bit tag; transmit
  `{ n, ct, tag }` as base64.
- **Command signature payload**: canonical JSON of
  `{ sessionId, commandId, epoch, op, deviceId, enc }`, signed with the device
  Ed25519 key.
- **Handshake signature payload**: canonical JSON of
  `{ nonce, serverId, timestamp, role, deviceId }`.

### 11.3 Minimal client sequence

1. Enroll once: `POST /devices/register` with a full session token and the
   base64 DER public keys. Store the device id and keypair.
2. Open `WSS /ws`. On `auth.challenge`, sign the handshake payload and send
   `hello { role, deviceId, timestamp, signature }`. Await `auth.ok`.
3. `ctl.list` → `ctl.catalog`.
4. `ctl.attach { sessionId, mode }` → `ctl.attached`, then receive `e2e.key`.
   Import the host ephemeral public key, ECDH with your encryption private key,
   HKDF (info = wrap AAD), AES-GCM-decrypt the wrapped blob → session group key.
5. Decrypt each `session.*` frame with the group key and the frame AAD.
6. `ctl.command { sessionId, commandId, epoch, op, enc, sig }`: seal `args` with
   the group key (command AAD) and sign the command payload. Await `cmd.ack`.

### 11.4 Conformance vectors

`test/fixtures/conformance.json` contains a fixed keypair, a signed handshake, a
wrapped group key, an encrypted frame and a signed command. A new client must
verify the signature, unwrap the group key, decrypt the frame, and verify +
decrypt the command. The suite runs these vectors against **both** the Node and
WebCrypto providers (`test/unit/conformance.test.mjs`), which is the
cross-runtime contract. Regenerate with `npm run conformance:generate`.

## 12. Network resilience

Both hosts and controllers connect outbound and use a **reconnecting socket**,
so uncontrolled networks (NAT rebinding, Wi-Fi/cellular changes, sleeps, flaky
links) recover without operator action.

- **Backoff**: reconnection retries indefinitely with exponential backoff +
  jitter, 500 ms → 15 s cap. Timers are unref'd so they never pin a process alive.
- **Heartbeat / half-open detection**: the client sends `ping` every 20 s and the
  server answers `pong`. If no inbound traffic arrives for 2.5 intervals the
  client treats the connection as dead and reconnects. The coordinator also uses
  WebSocket ping/pong and terminates unresponsive peers. This catches the
  "network vanished without a TCP close" case, not just clean disconnects.
- **Deliberate close**: calling `close()` disables reconnection (`closed` is
  emitted once, no retries).

### Host reconnect

The host re-authenticates, then:

1. `epoch += 1`, new random session group key, `seq` resets.
2. re-sends `session.opened`;
3. re-wraps `e2e.key` for every attachment the host still knows about;
4. sends a fresh `session.snapshot`.

Controllers still connected receive the new key and snapshot; controllers that
also dropped re-attach and get a fresh key. The `epoch` change fences any
delayed frames or commands.

### Controller reconnect

The controller re-authenticates and re-attaches **every session it was attached
to**, clearing stale keys first. It then receives `e2e.key` + a fresh snapshot
per session. It emits `disconnected`, `reconnecting`, `reconnected`, and
`resynced` so UIs can reflect state. Remote entries are id-keyed, so a resynced
snapshot never double-renders.

### Commands across a drop

A command waits for the connection (up to a timeout), re-seals with the current
epoch key, and retries **only if the send itself failed** — a command that may
have reached the host is never resent. If no ack arrives, the caller gets an
explicit reconciliation error ("verify the remote before retrying") rather than
a silent duplicate execution. Command ids remain idempotent at the host.

### Coordinator behavior

On host disconnect the coordinator marks the host's sessions
`hostConnected:false` and notifies subscribers, but keeps controller attachments
so the host can re-key them on return. A replacement connection for the same
`hostId` does not clobber the new host (the stale socket's cleanup is a no-op),
and the host's re-announcement restores routing.

### Multiple pi processes on one host

A host identity (`hostId`) identifies a *machine*, not a process. A machine may
run several pi processes at once (multiple terminals/sessions), all sharing the
stored identity, so the coordinator allows **many concurrent host connections
for one `hostId`**. Sessions are routed to the connection that opened them
(`session.hostWs`), never by `hostId` alone — otherwise two processes would
fight over one slot and commands would be delivered to the wrong process.

Setup is also idempotent: re-running `/pinet setup` on an already-enrolled
machine reconnects with the stored device instead of registering a duplicate
(which would create two devices sharing one keypair). Use `/pinet logout` first
to enroll a genuinely new device.
