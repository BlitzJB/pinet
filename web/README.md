# PiNet web client

A Vite + React + TypeScript SPA for controlling pi sessions from a browser.
Built with the TanStack stack and Tailwind CSS, served by the coordinator at
`/app`.

## Design system

The UI follows [assistant-ui](https://www.assistant-ui.com/)'s design language and
component patterns:

- **Tokens**: the shadcn oklch theme (background/foreground/muted/border/ring/
  destructive, `--radius: 0.625rem`) mapped through Tailwind v4 `@theme inline`,
  plus `tw-animate-css` for enter animations.
- **Surfaces** (`components/ui/surfaces.tsx`): `paper`, `floating`, `field`,
  `ghostButton`, `inkButton`, `iconSwap`, `mono`, `ShimmerLabel` — ported so our
  surfaces match theirs exactly.
- **Micro-interactions**: `active:scale-[0.96]` press, cubic-bezier transitions,
  send/stop icon swap (scale + opacity + blur), shimmering reasoning label,
  `0fr → 1fr` collapsible panels, fade/slide-in on entry, scroll-to-bottom.
- **Components**: sidebar thread list, thread viewport with welcome + suggestion
  starters, user/assistant messages with hover actions, reasoning panel, tool
  cards with status/duration/output, composer with auto-resize + model chip +
  thinking menu + compact + stop, connection-state banner, typing indicator.

## Stack

- **Vite** + React 19 + TypeScript
- **TanStack Router** — code-based routes (`/`, `/s/$sessionId`, `/settings`)
- **TanStack Query** — catalog / account / devices data
- **TanStack Table** — the sessions grid
- **Tailwind CSS v4** (`@tailwindcss/vite`, theme tokens in `src/styles.css`)
- **marked** + **DOMPurify** — sanitized markdown for assistant output

## How it talks to the coordinator

It reuses the repository's browser-safe client core:

- `src/lib/device.ts` — generates this browser's controller keypair with
  `webCryptoProvider`, registers it (`POST /devices/register`), and stores the
  `CryptoKey`s in IndexedDB.
- `src/lib/pinet.ts` — wraps `PiNetController` (from `../../../src/controller/
  client.mjs`) over `webCryptoProvider`, subscribes to decrypted session frames,
  and maps remote pi entries to display blocks with `describeEntry`.
- `src/lib/api.ts` — same-origin fetches for `/me`, `/devices`, `/auth/logout`.

Authentication is the coordinator's Google SSO + MFA; the session cookie is
same-origin because the app is served from the coordinator.

## Develop

```bash
npm install
npm run dev        # http://localhost:5173/app/ (proxies API + /ws to :8787)
```

Run the coordinator locally (`node ../src/coordinator/server.mjs`) with Google
credentials configured, then open the dev URL.

## Build

```bash
npm run build      # -> dist/, served at /app by the coordinator
```

`deploy/install.sh` builds this automatically on the server.

## Notes

- Keys live only in this browser (IndexedDB). "Forget this browser's device
  keys" on the Settings page clears them; revoke the device server-side too.
- A `control` attachment can run shell commands on the host. Use read-only
  attachments for passive viewing.
