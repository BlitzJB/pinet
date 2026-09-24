// Portal logic: present a remote session inside a local pi TUI and forward
// local input to the remote host. Pure mapping, independent of pi's UI so it
// can be tested without a TUI.

/** Map a remote pi session entry to a renderable block, or null to skip. */
export function describeEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  if (entry.type === "message" && entry.message) {
    const message = entry.message;
    const text = contentText(message.content);
    if (message.role === "user") return { id: entry.id, kind: "user", title: "you", body: text };
    if (message.role === "assistant") {
      const tools = Array.isArray(message.content)
        ? message.content.filter((block) => block?.type === "toolCall").map((block) => `${block.name} ${shorten(JSON.stringify(block.arguments))}`)
        : [];
      const body = [text, ...tools].filter(Boolean).join("\n");
      if (!body.trim()) return null;
      return { id: entry.id, kind: "assistant", title: "pi", body };
    }
    if (message.role === "toolResult") {
      return { id: entry.id, kind: "tool", title: message.toolName ?? "tool", body: shorten(firstLines(contentText(message.content), 12)), error: Boolean(message.isError) };
    }
    if (message.role === "custom") return { id: entry.id, kind: "system", title: message.customType ?? "custom", body: shorten(contentText(message.content)) };
    return null;
  }
  if (entry.type === "model_change") return { id: entry.id, kind: "system", title: "model", body: `${entry.provider}/${entry.modelId}` };
  if (entry.type === "thinking_level_change") return { id: entry.id, kind: "system", title: "thinking", body: String(entry.thinkingLevel) };
  if (entry.type === "compaction") return { id: entry.id, kind: "system", title: "compacted", body: entry.reason ?? "manual" };
  if (entry.type === "session_info") return { id: entry.id, kind: "system", title: "session", body: entry.name ?? "(cleared)" };
  return null;
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block?.type === "text").map((block) => block.text).join("");
}

function firstLines(text, count) {
  return String(text).split("\n").slice(0, count).join("\n");
}

function shorten(text, max = 2000) {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * Wire a controller to a sink. `sink` receives renderable blocks and status.
 * Returns helpers the extension exposes to the TUI.
 */
export function createPortal({ controller, sink, sessionId }) {
  const seen = new Set();
  let activeSession = sessionId;

  function ingest(entries) {
    for (const entry of entries ?? []) {
      if (!entry?.id || seen.has(entry.id)) continue;
      const record = describeEntry(entry);
      if (!record) continue;
      seen.add(entry.id);
      sink.append(record);
    }
  }

  controller.on("snapshot", (data) => {
    activeSession = data.sessionId ?? activeSession;
    ingest(data.entries);
    if (data.status) sink.status({ sessionId: activeSession, ...data.status });
  });

  // Seed from an already-received snapshot (subscribe-before-attach still wins,
  // but this makes late portal creation correct too).
  const cached = controller.getSnapshot?.(activeSession);
  if (cached) {
    ingest(cached.entries);
    if (cached.status) sink.status({ sessionId: activeSession, ...cached.status });
  }
  controller.on("rebase", (data) => ingest(data.entries));
  controller.on("entries", (data) => ingest(data.entries));
  controller.on("status", (data) => sink.status({ sessionId: data.sessionId ?? activeSession, ...data.status }));
  controller.on("meta", (data) => sink.meta?.({ sessionId: data.sessionId ?? activeSession, ...data.meta }));
  controller.on("removed", () => sink.notify?.("Remote session removed", "warning"));
  controller.on("decrypt_error", (data) => sink.notify?.(`Remote decrypt error: ${data.error}`, "error"));

  return {
    ingest,
    sessionId: () => activeSession,
    sendPrompt(text) {
      return controller.command(activeSession, "prompt", { text });
    },
    abort() {
      return controller.command(activeSession, "abort", {});
    },
    compact(instructions) {
      return controller.command(activeSession, "compact", instructions ? { instructions } : {});
    },
    setModel(provider, modelId) {
      return controller.command(activeSession, "set_model", { provider, modelId });
    },
    setThinking(level) {
      return controller.command(activeSession, "set_thinking", { level });
    },
  };
}
