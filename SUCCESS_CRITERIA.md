# PiNet v1 — Success Criteria

All criteria verified by `npm test` (vitest, 75 tests) and the real-process
extension test. `node --test` is not used; the suite runs with `vitest`.

## A. Authentication & identity — PASS
- [x] A1. Google SSO (BYO credentials) authorization-code + PKCE completes and
      creates/loads an account by verified email/sub.
      *`test/integration/auth.test.mjs`, `test/integration/http.test.mjs`*
- [x] A2. OAuth endpoints and client id/secret/redirect are configurable.
      *`src/coordinator/server.mjs` `configFromEnv`; mock IdP used in tests*
- [x] A3. The flow works against a mock IdP; no real Google account needed.
      *`startMockGoogleIdp` in `src/auth/google.mjs`*
- [x] A4. Session credentials are HMAC-signed, expire, and are validated.
      *`test/unit/tokens.test.mjs`*
- [x] A5. Pre-MFA (`pending`) tokens cannot access authenticated endpoints.
      *`test/integration/auth.test.mjs` ("blocks the pending token")*

## B. Multi-factor authentication — PASS
- [x] B1. TOTP matches the RFC 6238 vectors. *`test/unit/totp.test.mjs`*
- [x] B2. Enrollment returns a secret, `otpauth://` URI and recovery codes.
      *`test/unit/accounts.test.mjs`, `test/integration/http.test.mjs`*
- [x] B3. Valid codes activate; invalid codes are rejected.
      *`test/unit/accounts.test.mjs`*
- [x] B4. TOTP counter replay is prevented.
      *`test/unit/accounts.test.mjs`, `test/integration/auth.test.mjs`*
- [x] B5. Recovery codes are hashed, single-use, non-reusable.
      *`test/unit/accounts.test.mjs`, `test/integration/auth.test.mjs`*
- [x] B6. Login requires the TOTP code after enrollment.
      *`test/integration/auth.test.mjs`, `test/integration/http.test.mjs`*
- [x] B7. All MFA behavior is exercised with locally generated codes (no phone).
      *all of the above*

## C. Device enrollment & proof-of-possession — PASS
- [x] C1. Controllers generate Ed25519 + X25519 keys at enrollment.
      *`src/auth/google.mjs`/`accounts`, `test/helpers/harness.mjs`*
- [x] C2. Device registration requires an authenticated session.
      *`test/integration/http.test.mjs` (401 + register)*
- [x] C3. Hosts enroll with a short-lived single-use code.
      *`test/integration/http.test.mjs`, `test/integration/pi-extension.test.mjs`*
- [x] C4. Enrollment codes expire and cannot be reused.
      *`test/unit/accounts.test.mjs`, `test/integration/http.test.mjs`*
- [x] C5. WebSocket auth is Ed25519 challenge-response bound to nonce+timestamp.
      *`test/integration/ws-auth.test.mjs`*
- [x] C6. Replayed/stale challenge responses are rejected.
      *`test/integration/ws-auth.test.mjs` (stale, replay, wrong key)*
- [x] C7. Revoked devices cannot authenticate. *`test/integration/ws-auth.test.mjs`*

## D. Authorization — PASS
- [x] D1. Only account-owned, enrolled, non-revoked devices can list/attach/command.
      *`test/integration/multihost.test.mjs` (cross-account), `session.test.mjs`*
- [x] D2. `read` attachments never command. *`test/integration/session.test.mjs`*
- [x] D3. Commands without an attachment are rejected (`not_attached`).
      *`test/integration/session.test.mjs`*
- [x] D4. Commands for an offline host are rejected (`host_unavailable`).
      *`test/integration/session.test.mjs`*

## E. End-to-end encryption — PASS
- [x] E1. Coordinator relays ciphertext only; never holds a session key.
      *`src/coordinator/ws.mjs` handles only opaque `enc`; `test/unit/e2e.test.mjs`*
- [x] E2. Per-epoch group key wrapped via ephemeral-static X25519 + HKDF + AES-GCM.
      *`test/unit/e2e.test.mjs`, `test/integration/session.test.mjs`*
- [x] E3. Session frames are unreadable without the key.
      *`test/unit/e2e.test.mjs` (wrong key), `test/integration/session.test.mjs` (decrypt)*
- [x] E4. Command args are encrypted by the controller, decrypted by the host.
      *`test/integration/session.test.mjs`, `test/integration/pi-extension.test.mjs`*
- [x] E5. Tampering with frames or bound metadata fails.
      *`test/unit/e2e.test.mjs`, `test/integration/session.test.mjs`*
- [x] E6. A late joiner receives the key and a fresh snapshot.
      *`test/integration/session.test.mjs`*

## F. Command integrity & replay — PASS
- [x] F1. Commands are Ed25519-signed and host-verified.
      *`test/integration/session.test.mjs`, `pi-extension.test.mjs`*
- [x] F2. Bad signatures are rejected. *`test/integration/session.test.mjs`*
- [x] F3. Stale epochs are rejected. *`test/integration/session.test.mjs`*
- [x] F4. Repeated command ids are idempotent. *`test/integration/session.test.mjs`*

## G. Immediate delivery / steering — PASS
- [x] G1. Idle prompt → `immediate`. *`test/unit/host.test.mjs`, bridge/session tests*
- [x] G2. Running prompt → `steer` (not follow-up). *`test/unit/host.test.mjs`*
- [x] G3. Steering is selected on receipt while busy. *`resolveDelivery` + queue tests*
- [x] G4. The host never defers a command awaiting a turn. *`src/host/delivery.mjs`*

## H. Write authority / serialization — PASS
- [x] H1. Host serializes command execution; each is acked.
      *`test/unit/host.test.mjs` (serial queue), `src/host/bridge.mjs`*
- [x] H2. No per-session lease; any control attachment may command.
      *`src/host/bridge.mjs`, `test/integration/session.test.mjs`*
- [x] H3. Effects broadcast to all controllers as entries.
      *`test/integration/session.test.mjs` (fan-out)*

## I. Session replication & multi-host — PASS
- [x] I1. Block-level entries/status forwarded (no token deltas).
      *`src/host/bridge.mjs`, `test/integration/session.test.mjs`*
- [x] I2. Multiple controllers receive the same frames.
      *`test/integration/session.test.mjs`*
- [x] I3. Multiple sessions/hosts route independently.
      *`test/integration/multihost.test.mjs`*
- [x] I4. Compaction/navigation produces a rebase.
      *`test/integration/session.test.mjs`*
- [x] I5. Host offline/online reflected in the catalog.
      *`test/integration/session.test.mjs`*

## J. Testing & tooling — PASS
- [x] J1. `npm test` runs unit + integration via vitest.
- [x] J2. Unit coverage: crypto, TOTP, tokens, accounts, delivery, queue.
- [x] J3. Integration: SSO+MFA, enrollment, authenticated WS, attach, encrypted
      command round-trip, steering modes, fan-out, multi-host, real pi process.
- [x] J4. Deterministic; no network or model access.
- [x] J5. All 75 tests pass on a clean run.

## K. Documentation — PASS
- [x] K1. `PROTOCOL.md` covers auth, MFA, enrollment, E2E, commands.
- [x] K2. `SECURITY.md` covers the threat model, residual risks, upgrade path.
- [x] K3. `README.md` covers setup incl. BYO Google credentials.
- [x] K4. This file is accurate on completion.

## L. In-pi onboarding (no separate CLI) — PASS
- [x] L1. Host onboarding happens inside pi via `/pinet setup`, using a device
      authorization flow (code + URL, browser SSO + MFA, poll for approval).
      *`src/host/onboarding.mjs`, `extension/index.ts`*
- [x] L2. `/pinet status`, `/pinet reconnect`, `/pinet logout` manage the host.
      *`extension/index.ts`*
- [x] L3. Enrollment persists host identity and reconnects automatically on
      later pi starts. *`src/host/onboarding.mjs` state tests*
- [x] L4. The device flow requires approval and issues a single-use session.
      *`test/integration/device-flow.test.mjs`*
- [x] L5. `onboardHost` completes the whole flow against a live coordinator and
      yields a host identity that authenticates over WS.
      *`test/integration/device-flow.test.mjs`*
- [x] L6. A headless fallback (`PINET_ENROLL_CODE`) still works.
      *`test/integration/pi-extension.test.mjs`*

## M. Generic client protocol (any modality) — PASS
- [x] M1. Client crypto is abstracted behind a `CryptoProvider` interface with
      no Node dependency (`src/crypto/provider.mjs`).
- [x] M2. A WebCrypto provider implements the same interface for browsers.
      *`src/crypto/webcrypto.mjs`, `test/unit/provider-parity.test.mjs`*
- [x] M3. Node and WebCrypto providers interoperate (signatures, ECDH, HKDF,
      AEAD, key wrapping) in both directions. *`test/unit/provider-parity.test.mjs`*
- [x] M4. The controller client is runtime-agnostic and accepts injected crypto;
      a WebCrypto controller commands a Node host end to end.
      *`test/integration/webcrypto-client.test.mjs`*
- [x] M5. Language-agnostic conformance vectors exist and pass under both
      providers. *`test/fixtures/conformance.json`, `test/unit/conformance.test.mjs`*
- [x] M6. The client implementer's guide documents the exact wire/crypto spec.
      *`PROTOCOL.md` §11*

## N. Pi-as-portal client modality — PASS
- [x] N1. Local pi can be a controller via `/portal setup|sessions|attach|detach`.
      *`extension/portal.ts`*
- [x] N2. Remote session blocks render in the local transcript without entering
      the local LLM context. *`src/controller/portal.mjs`, `test/unit/portal.test.mjs`*
- [x] N3. Typed local input is intercepted and forwarded as a signed, encrypted
      remote prompt. *`test/integration/portal-extension.test.mjs`*
- [x] N4. Detach returns input to the local agent (input event passes through).
      *`test/integration/portal-extension.test.mjs`*
- [x] N5. The remote stream is applied exactly once (dedup by entry id).
      *`test/unit/portal.test.mjs`*
- [x] N6. The portal extension loads and registers `/portal` in a real pi process.
      *`test/integration/pi-portal-load.test.mjs`*

## O. Network resilience — PASS
- [x] O1. Host and controller use a reconnecting socket with exponential
      backoff + jitter. *`src/common/ws-client.mjs`, `test/integration/reconnect.test.mjs`*
- [x] O2. An application heartbeat detects half-open (silently dead) connections.
      *`src/common/ws-client.mjs`, coordinator `ping`/`pong`*
- [x] O3. Host reconnect rotates epoch + group key, re-wraps `e2e.key` for known
      attachments, and resnapshots. *`test/integration/reconnect.test.mjs`*
- [x] O4. Controller reconnect re-attaches every session and resyncs.
      *`test/integration/reconnect.test.mjs`*
- [x] O5. A command issued during a drop waits and succeeds after reconnect,
      without duplicate execution. *`test/integration/reconnect.test.mjs`*
- [x] O6. A deliberate close disables reconnection.
      *`test/integration/reconnect.test.mjs`*
- [x] O7. Reconnection behavior is documented. *`PROTOCOL.md` §12*

## P. Packaging & deployment — PASS
- [x] P1. Public GitHub repo with a `pi-package` manifest declaring both extensions.
      *https://github.com/BlitzJB/pinet*
- [x] P2. Installable directly from GitHub: `pi -e git:github.com/BlitzJB/pinet`
      loads `/pinet` and `/portal`. *verified via RPC `get_commands`*
- [x] P3. Persistent coordinator: systemd unit (boot-enabled, auto-restart,
      hardened), nginx TLS + WebSocket reverse proxy, ufw 80/443, durable state.
      *`deploy/`, live at https://pinet.bharathi.fyi*
- [x] P4. Idempotent installer that preserves certbot-managed TLS on re-run.
      *`deploy/install.sh`*
- [x] P5. TLS issued + auto-renewing; WSS reaches the coordinator through the
      proxy (`wss://pinet.bharathi.fyi/ws` returns `auth.challenge`).
