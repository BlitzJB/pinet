# Security

Pinet assumes three distinct trust domains. Controllers and the coordinator are
**not** trusted with each other's secrets, and the coordinator is assumed
potentially hostile. This document states the model, the controls, and the
residual risks.

## Threat model

| Adversary | Capability | Defeated by |
|---|---|---|
| Network attacker | MITM, modify, replay | TLS (WSS/HTTPS) + end-to-end encryption + command signatures |
| Malicious/compromised coordinator | read, inject, reorder, drop, replay | E2E encryption; host-verified command signatures; host-side authorization. Still able to deny service and observe metadata |
| Stolen controller device | act as that device | device key (Ed25519 PoP on every connect), revocation, short session TTLs, `read` attachments |
| Stolen host | full control of that host | none at this layer (a host already runs arbitrary code) |
| Replay | resend a captured frame/handshake | per-connection challenge nonce, command ids, epoch fencing, timestamps |
| Revoked device | reconnect | store marks revoked; WS handshake rejects |
| Cross-account user | attach to someone else's session | account checks at list/attach/command |

## Controls

### Identity and authentication
- Google SSO (authorization code + PKCE) with operator-supplied credentials.
- TOTP MFA (RFC 6238) with a ±1 window and **counter replay prevention**; hashed
  single-use recovery codes. A pending (pre-MFA) token cannot access any
  authenticated endpoint.
- HMAC-SHA256 signed session tokens with expiry.
- Devices hold Ed25519 identity keys and X25519 encryption keys; private keys
  never leave the device. The coordinator stores only public keys.
- WebSocket handshake requires an Ed25519 signature over a per-connection nonce,
  bound to the server id, role, device id and a fresh timestamp.

### Authorization

- **Allowed-users allowlist**: `PINET_ALLOWED_USERS` is a case-insensitive
  regular expression matched against the signed-in email at the OAuth callback.
  Non-matching accounts are rejected with `403` before any account is created.
  An invalid pattern fails startup rather than silently opening up.
- Account-scoped session visibility.
- Per-attachment `read` vs `control`; read-only commands rejected.
- Commands require an existing attachment and a connected host.
- Revoked devices fail both the HTTP and WebSocket paths.

### End-to-end confidentiality and integrity
- A random 32-byte session group key per epoch, wrapped per controller with
  ephemeral-static X25519 + HKDF-SHA256.
- AES-256-GCM with AAD binding ciphertext to `{ sessionId, epoch, seq, type }`
  (frames) and `{ sessionId, commandId, epoch, op, deviceId }` (commands), so the
  coordinator cannot reorder or splice undetected.
- Controllers sign every command; the host verifies before executing.
- Hosts TOFU-pin controller identity keys and reject changes.

### Operational
- Keys and tokens are stored with `0600` file permissions under `$PINET_DIR`.
- Correlation ids and command ids are opaque; no secrets are logged by the
  servers.

## What the compromised coordinator can and cannot do

Can: deny service, drop/reorder frames (detected by `seq`/AAD), observe routing
metadata (session ids, frame sizes, timing).

Cannot: read session content or prompts; forge or modify commands; impersonate a
device; decrypt cached bytes (the coordinator does not cache plaintext and does
not persist session content in v1).

## Residual risks and recommendations

1. **First-use key trust.** The host learns a controller's public key from the
   coordinator at attach time and pins it. An active malicious coordinator could
   substitute a key on the *first* attach. Mitigation: an out-of-band pairing
   step (QR / short authentication string) that verifies the device key
   fingerprint before first use. Recommended next step.
2. **Group key lifetime.** The group key is static per session epoch; epoch
   rotation occurs on (re)start, not on every attach/detach. For stronger
   post-compromise security, rotate on membership change and add per-controller
   sender keys (or MLS for many controllers).
3. **Metadata.** The coordinator sees session ids and frame timing/sizes. If this
   matters, add padding and/or encrypt `meta`.
4. **No host guardrails.** By explicit choice, the host executes controller
   commands without an approval policy. A `control` attachment is equivalent to
   shell access on the host; prefer `read` attachments where possible, revoke
   unused devices, and keep the coordinator on a private network or behind TLS.
5. **Transport trust for the browser leg.** TLS termination and certificate
   management for the HTTP/SSO endpoints are the operator's responsibility.

## Reporting

This is a reference implementation. Treat it as pre-production: audit it before
exposing it to untrusted networks.
