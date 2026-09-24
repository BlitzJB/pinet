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
import { PinetController } from "../src/controller/client.mjs";
import { createPortal } from "../src/controller/portal.mjs";
import {
  clearControllerState,
  controllerStatePath,
  ensureControllerKeys,
  loadControllerState,
  onboardController,
} from "../src/host/onboarding.mjs";

type PortalRecord = { id?: string; kind?: string; title?: string; body?: string; error?: boolean };
type Pi = ExtensionAPI;

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

  function setStatus(ctx: ExtensionContext | undefined, text: string | undefined): void {
    try {
      ctx?.ui.setStatus("pinet-portal", text);
    } catch {
      /* no UI */
    }
  }

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
    instance.on("disconnected", () => setStatus(activeCtx, "pinet portal: reconnecting…"));
    instance.on("reconnecting", (info: { delayMs: number }) => setStatus(activeCtx, `pinet portal: reconnecting in ${Math.round(info.delayMs / 1000)}s`));
    instance.on("reconnected", () => {
      setStatus(activeCtx, "pinet portal: connected");
      notify(activeCtx, "Pinet portal reconnected; resyncing remote session.", "info");
    });
    instance.on("resynced", () => setStatus(activeCtx, "pinet portal: connected"));
    instance.on("resync_error", (info: { sessionId: string; error: string }) => notify(activeCtx, `Resync failed for ${info.sessionId}: ${info.error}`, "error"));
    await instance.connect();
    controller = instance;
    return instance;
  }

  function append(record: PortalRecord): void {
    pi.appendEntry("pinet.remote", record);
  }

  // Render remote blocks in the local transcript (minimal Component: render/invalidate).
  pi.registerEntryRenderer("pinet.remote", (entry, _options, theme) => {
    const record = (entry.data ?? {}) as PortalRecord;
    const color = record.kind === "user" ? "accent" : record.kind === "tool" ? "dim" : record.kind === "system" ? "muted" : "text";
    const marker = record.error ? theme.fg("error", "✖") : theme.fg(color, `[${record.title ?? record.kind ?? "remote"}]`);
    const lines = `${marker} ${record.body ?? ""}`.split("\n");
    return { render: () => lines, invalidate() {} };
  });

  pi.registerCommand("portal", {
    description: "Pinet portal: /portal setup | sessions | attach <id> | detach | status",
    handler: async (args, ctx) => {
      const [sub = "status", ...rest] = args.trim().split(/\s+/);

      if (sub === "setup") {
        try {
          setStatus(ctx, "pinet portal: waiting for browser approval…");
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
          setStatus(ctx, "pinet portal: ready");
        } catch (error) {
          notify(ctx, `Portal setup failed: ${String((error as Error)?.message ?? error)}`, "error");
          setStatus(ctx, "pinet portal: setup failed");
        }
        return;
      }

      if (sub === "logout") {
        controller?.close();
        controller = undefined;
        activePortal = undefined;
        activeSession = undefined;
        clearControllerState(dir);
        setStatus(ctx, "pinet portal: logged out");
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
              status: ({ phase, model }) => setStatus(ctx, `pinet portal · ${phase}${model ? ` · ${model.provider}/${model.id}` : ""}`),
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
        setStatus(ctx, "pinet portal: detached");
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
    try {
      const ack = await activePortal.sendPrompt(event.text);
      if (ack && ack.accepted === false) {
        pi.appendEntry("pinet.remote", { kind: "system", title: "rejected", body: ack.error ?? "command rejected", error: true });
      }
    } catch (error) {
      pi.appendEntry("pinet.remote", { kind: "system", title: "error", body: String((error as Error)?.message ?? error), error: true });
    }
    return { action: "handled" };
  });

  pi.on("session_start", async (_event, ctx) => {
    activeCtx = ctx;
    const state = loadControllerState(dir);
    setStatus(ctx, state.deviceId ? "pinet portal: ready" : "pinet portal: run /portal setup");
  });
}
