/**
 * Pinet portal extension: use a local pi as a controller.
 *
 * `/portal setup` enrolls this pi as a controller device (device flow).
 * `/portal sessions` lists remote sessions. `/portal attach <id>` mounts a
 * remote session into this TUI: incoming blocks render as transcript entries
 * and everything you type is forwarded to the remote host as an encrypted,
 * signed command. `/portal detach` returns to the local agent.
 *
 * Env: PINET_HUB, PINET_HTTP, PINET_DIR.
 */

import { hostname } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import { PinetController } from "../src/controller/client.mjs";
import { createPortal } from "../src/controller/portal.mjs";
import {
  clearControllerState,
  loadControllerState,
  onboardController,
} from "../src/host/onboarding.mjs";

type PortalRecord = { id?: string; kind?: string; title?: string; body?: string; text?: string; tools?: { name: string; args?: string }[]; error?: boolean };
type Pi = ExtensionAPI;

function markdownTheme(theme: any) {
  const fg = (name: string) => (text: string) => {
    try {
      return theme.fg(name, text);
    } catch {
      return text;
    }
  };
  return {
    heading: fg("accent"),
    link: fg("accent"),
    linkUrl: fg("dim"),
    code: fg("accent"),
    codeBlock: (text: string) => text,
    codeBlockBorder: fg("dim"),
    quote: fg("muted"),
    quoteBorder: fg("dim"),
    hr: fg("dim"),
    listBullet: fg("accent"),
    bold: (text: string) => {
      try {
        return theme.bold(text);
      } catch {
        return text;
      }
    },
    italic: (text: string) => text,
    strikethrough: (text: string) => text,
    underline: (text: string) => text,
  };
}

// Render a remote entry with pi's own TUI components so it looks like a native
// session: markdown for assistant text, tool calls, and boxed messages.
export function renderRemote(record: PortalRecord, expanded: boolean, theme: any) {
  const text = record.text ?? record.body ?? "";
  if (record.kind === "user") {
    const box = new Box(1, 0, (line: string) => theme.bg("customMessageBg", line));
    box.addChild(new Text(theme.bold(theme.fg("accent", "you")), 0, 0));
    box.addChild(new Text(text, 0, 0));
    return box;
  }
  if (record.kind === "assistant") {
    const box = new Box(1, 0);
    box.addChild(new Text(theme.bold(theme.fg("success", "pi")), 0, 0));
    if (record.text) box.addChild(new Markdown(record.text, 0, 0, markdownTheme(theme)));
    for (const tool of record.tools ?? []) {
      box.addChild(new Text(theme.fg("toolTitle", `$ ${tool.name} `) + theme.fg("dim", tool.args ?? ""), 0, 0));
    }
    return box;
  }
  if (record.kind === "tool") {
    const box = new Box(1, 0, (line: string) => theme.bg("customMessageBg", line));
    const mark = record.error ? theme.fg("error", "x") : theme.fg("success", "ok");
    box.addChild(new Text(`${mark} ${theme.fg("toolTitle", record.title ?? "tool")}`, 0, 0));
    const lines = String(text).split("\n");
    const shown = expanded ? lines : lines.slice(0, 12);
    if (shown.length) box.addChild(new Text(theme.fg("dim", shown.join("\n")), 0, 0));
    if (!expanded && lines.length > 12) box.addChild(new Text(theme.fg("muted", `... ${lines.length - 12} more lines`), 0, 0));
    return box;
  }
  return new Text(theme.fg("muted", `[${record.title ?? record.kind ?? "remote"}] `) + theme.fg("dim", text), 0, 0);
}

function deriveHttp(wsUrl: string): string {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url.origin;
}

export default function portal(pi: Pi): void {
  const dir = process.env.PINET_DIR ?? `${process.env.HOME ?? "."}/.pinet`;
  const hubUrl = process.env.PINET_HUB ?? "ws://127.0.0.1:8787/ws";
  const httpUrl = process.env.PINET_HTTP ?? deriveHttp(hubUrl);

  let controller: PinetController | undefined;
  let activePortal: ReturnType<typeof createPortal> | undefined;
  let activeSession: string | undefined;
  let activeCtx: ExtensionContext | undefined;


  function notify(ctx: ExtensionContext | undefined, message: string, type: "info" | "warning" | "error" = "info"): void {
    try {
      ctx?.ui.notify(message, type);
    } catch {
      /* no UI */
    }
  }

  function openUrl(url: string): void {
    try {
      const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
      const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
      void pi.exec(command, args).catch(() => {});
    } catch {
      /* user can open the shown URL */
    }
  }

  async function ensureController(): Promise<PinetController> {
    if (controller) {
      try {
        await controller.socket.waitForReady(15_000);
        return controller;
      } catch {
        controller.close();
        controller = undefined;
      }
    }
    const state = loadControllerState(dir);
    if (!state.deviceId || !state.identity || !state.encryption) throw new Error("not enrolled; run /portal setup");
    const instance = new PinetController({
      url: hubUrl,
      deviceId: state.deviceId,
      identity: state.identity,
      encryption: state.encryption,
      deviceName: hostname(),
      reconnect: true,
    });
    instance.on("reconnected", () => {
      notify(activeCtx, "Pinet portal reconnected; resyncing remote session.", "info");
    });
    instance.on("resync_error", (info: { sessionId: string; error: string }) => notify(activeCtx, `Resync failed for ${info.sessionId}: ${info.error}`, "error"));
    await instance.connect();
    controller = instance;
    return instance;
  }

  let pendingUserEchoes = 0;
  function append(record: PortalRecord): void {
    // Skip the remote echo of a message we already showed optimistically.
    if (record.kind === "user" && pendingUserEchoes > 0) {
      pendingUserEchoes -= 1;
      return;
    }
    pi.appendEntry("pinet.remote", record);
  }

  // Render remote blocks in the local transcript using pi's TUI components.
  pi.registerEntryRenderer("pinet.remote", (entry, { expanded }, theme) => renderRemote((entry.data ?? {}) as PortalRecord, expanded, theme));

  pi.registerCommand("portal", {
    description: "Pinet portal: /portal setup | sessions | attach <id> | detach | status",
    handler: async (args, ctx) => {
      const [sub = "status", ...rest] = args.trim().split(/\s+/);

      if (sub === "setup") {
        try {
          const result = await onboardController({
            httpUrl,
            dir,
            name: hostname(),
            onCode: ({ userCode, verificationUri }) => {
              notify(ctx, `Pinet portal setup\n\n1. Open: ${verificationUri}\n2. Sign in (Google + MFA)\n3. Enter code: ${userCode}`, "info");
              openUrl(verificationUri);
            },
          });
          await ensureController();
          notify(ctx, `Pinet portal enrolled as ${result.deviceId}`, "info");
        } catch (error) {
          notify(ctx, `Portal setup failed: ${String((error as Error)?.message ?? error)}`, "error");
        }
        return;
      }

      if (sub === "logout") {
        controller?.close();
        controller = undefined;
        activePortal = undefined;
        activeSession = undefined;
        clearControllerState(dir);
        notify(ctx, "Pinet portal identity cleared.", "warning");
        return;
      }

      if (sub === "sessions") {
        try {
          const instance = await ensureController();
          const sessions = await instance.list();
          if (sessions.length === 0) notify(ctx, "No remote sessions found.", "info");
          else notify(ctx, sessions.map((s, i) => `${i + 1}. ${s.meta?.name ?? "(unnamed)"}  ${s.sessionId}${s.hostConnected ? "" : "  OFFLINE"}`).join("\n"), "info");
        } catch (error) {
          notify(ctx, String((error as Error)?.message ?? error), "error");
        }
        return;
      }

      if (sub === "attach") {
        const sessionId = rest[0];
        if (!sessionId) {
          notify(ctx, "Usage: /portal attach <sessionId>", "warning");
          return;
        }
        try {
          // Detach any previous portal first.
          if (activePortal && controller) {
            try {
              controller.detach(activeSession);
            } catch {
              /* ignore */
            }
          }
          const instance = await ensureController();
          // Subscribe before attaching so the initial snapshot is never missed.
          const portalInstance = createPortal({
            controller: instance,
            sessionId,
            sink: {
              append,
              // The extension no longer writes to pi's status line; run
              // /pinet status (or /portal status) to see it on demand.
              status: () => {},
              notify: (message, type) => notify(ctx, message, type),
            },
          });
          activePortal = portalInstance;
          activeSession = sessionId;
          try {
            await instance.attach(sessionId, "control");
          } catch (error) {
            activePortal = undefined;
            activeSession = undefined;
            throw error;
          }
          append({ kind: "system", title: "portal", body: `attached to ${sessionId}` });
          notify(ctx, `Portal attached to ${sessionId}. Type to send to the remote agent; /portal detach to leave.`, "info");
        } catch (error) {
          notify(ctx, `Attach failed: ${String((error as Error)?.message ?? error)}`, "error");
        }
        return;
      }

      if (sub === "detach") {
        if (activeSession && controller) {
          try {
            controller.detach(activeSession);
          } catch {
            /* ignore */
          }
        }
        activePortal = undefined;
        activeSession = undefined;
        controller?.close();
        controller = undefined;
        notify(ctx, "Portal detached.", "info");
        return;
      }

      if (sub === "status") {
        const state = loadControllerState(dir);
        notify(
          ctx,
          [
            `hub: ${hubUrl}`,
            `enrolled: ${state.deviceId ?? "(no)"}`,
            `remote: ${activeSession ?? "(none)"}`,
          ].join("\n"),
          "info",
        );
        return;
      }

      notify(ctx, "Usage: /portal setup | sessions | attach <id> | detach | status | logout", "warning");
    },
  });

  // While a portal is attached, typed input goes to the remote host.
  pi.on("input", async (event) => {
    if (!activePortal) return { action: "continue" };
    if (event.text.startsWith("/")) return { action: "continue" };
    if (!event.text.trim()) return { action: "continue" };
    // Echo immediately so the user's message doesn't wait on the round-trip.
    append({ kind: "user", title: "you", body: event.text, text: event.text });
    pendingUserEchoes += 1;
    try {
      const ack = await activePortal.sendPrompt(event.text);
      if (ack && ack.accepted === false) {
        pendingUserEchoes = Math.max(0, pendingUserEchoes - 1);
        append({ kind: "system", title: "rejected", body: ack.error ?? "command rejected", error: true });
      }
    } catch (error) {
      pendingUserEchoes = Math.max(0, pendingUserEchoes - 1);
      append({ kind: "system", title: "error", body: String((error as Error)?.message ?? error), error: true });
    }
    return { action: "handled" };
  });

  pi.on("session_start", async (_event, ctx) => {
    activeCtx = ctx;
  });
}
