# Deploying the PiNet coordinator

A persistent, TLS-terminated coordinator on Ubuntu 24.04 with systemd + nginx.

```
clients ──wss──► nginx :443 (TLS) ──► 127.0.0.1:8787 (pinet-coordinator)
```

The coordinator binds to loopback only; nginx terminates TLS and proxies HTTP +
WebSocket. systemd keeps it running and restarts it on failure or reboot.

## 1. DNS

Create an **A** record for your hostname pointing at the VM's public IPv4 (and an
**AAAA** if you want IPv6):

```
hub.example.com.   A      203.0.113.10
hub.example.com.   AAAA   2001:db8::1
```

Verify before continuing (must return your IP):

```bash
dig +short hub.example.com A
```

## 2. Install

From the repository root, as root:

```bash
sudo DOMAIN=hub.example.com ./deploy/install.sh
```

The script is idempotent and does all of this:

- creates a `pinet` system user and `/var/lib/pinet` (0700) for durable state;
- installs the app to `/opt/pinet` and runs `npm ci --omit=dev`;
- writes `/etc/pinet/coordinator.env` (0600) with generated
  `PINET_SESSION_SECRET` and `PINET_SERVER_ID` (kept on re-runs);
- installs and enables `pinet-coordinator.service`;
- installs the nginx vhost and WebSocket upgrade map, reloads nginx;
- allows 80/443 through ufw.

It prints the service status and a local health check.

## 3. Google OAuth (bring your own)

Create an OAuth **Web application** client in Google Cloud Console with the
authorized redirect URI:

```
https://hub.example.com/auth/callback
```

Then edit `/etc/pinet/coordinator.env`:

```
GOOGLE_CLIENT_ID=....apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=....
```

and

```bash
sudo systemctl restart pinet-coordinator
```

Until these are set, the service runs but SSO login fails fast.

## 4. TLS

After DNS resolves:

```bash
sudo certbot --nginx -d hub.example.com --redirect --agree-tos -m you@example.com
```

certbot rewrites the vhost to add the TLS listener and HTTP→HTTPS redirect, and
installs a renewal timer. Verify:

```bash
curl -fsS https://hub.example.com/health
```

## 5. Clients

Point hosts and controllers at the coordinator:

```bash
# host
PINET_HUB=wss://hub.example.com/ws PINET_HTTP=https://hub.example.com \
  pi -e git:github.com/BlitzJB/pinet
# then: /pinet setup

# controller
PINET_HUB=wss://hub.example.com/ws PINET_HTTP=https://hub.example.com \
  node src/controller/cli.mjs login
```

(`pi -e` loads the package; run `/portal setup` for the pi-as-controller TUI.)

## Operations

| Task | Command |
| --- | --- |
| status | `systemctl status pinet-coordinator` |
| logs | `journalctl -u pinet-coordinator -f` |
| restart | `systemctl restart pinet-coordinator` |
| config | `$EDITOR /etc/pinet/coordinator.env` then restart |
| data | `/var/lib/pinet/coordinator-store.json` (0600; accounts, devices, MFA) |
| backup | copy that file (contains MFA secrets — protect it) |
| cert renew | `certbot renew --dry-run` |

## Configuration reference

| Variable | Meaning |
| --- | --- |
| `PINET_HOST` / `PINET_PORT` | bind address (default `127.0.0.1:8787`) |
| `PINET_PUBLIC_URL` | public origin, used for device-flow URLs and OAuth redirects |
| `PINET_SERVER_ID` | stable logical server id (keep constant) |
| `PINET_SESSION_SECRET` | HMAC secret for session tokens |
| `PINET_DATA_DIR` | durable state directory |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | your Google OAuth client |
| `GOOGLE_REDIRECT_URI` | must match the Google client (`…/auth/callback`) |
| `PINET_ALLOWED_USERS` | JavaScript regex (case-insensitive) matched against the signed-in email; only matches may sign in. Empty = allow any Google account. Invalid regex fails startup (closed). |
| `GOOGLE_AUTH_URL` / `GOOGLE_TOKEN_URL` / `GOOGLE_USERINFO_URL` | endpoint overrides (testing/mock IdP) |

## Notes

- The coordinator has no authoritative session state; hosts are authoritative.
  Restarting it only drops live routing — hosts and controllers reconnect and
  resync automatically.
- User MFA secrets and recovery hashes live in the store file. Keep the data
  directory private and consider disk encryption.
- Change `main`/`master` to pin a release tag in the install docs once you tag one.
