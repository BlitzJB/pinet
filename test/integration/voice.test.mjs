import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import hostExtension from "../../extension/index.ts";
import { PiNetController } from "../../src/controller/client.mjs";
import { enrollDevice, makeAccount, startCoordinator, waitFor } from "../helpers/harness.mjs";

const SESSION = "s_voice";

// Stands in for Groq: the real HTTP shapes, no network.
function fakeProvider() {
  const calls = { asr: 0, chat: 0, chatBody: null };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (req.url.endsWith("/audio/transcriptions")) {
        calls.asr += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ text: "um so the pin net coordinator should not see the payload" }));
        return;
      }
      calls.chat += 1;
      calls.chatBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "The PiNet coordinator should not see the payload." } }] }));
    });
  });
  return { server, calls, listen: () => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}/v1`))) };
}

function makeCtx(store) {
  return {
    cwd: "/tmp",
    model: { provider: "test", id: "m", name: "m" },
    thinkingLevel: "off",
    isIdle: () => true,
    getContextUsage: () => null,
    scopedModels: [],
    modelRegistry: { find: () => undefined, getProviderDisplayName: (p) => p, getAvailable: () => [] },
    abort() {},
    compact() {},
    sessionManager: { getSessionId: () => SESSION, getEntries: () => store.entries, getLeafId: () => store.entries.at(-1)?.id ?? null },
  };
}

function fakePi() {
  const handlers = {};
  const commands = {};
  return {
    handlers,
    commands,
    on(type, fn) { (handlers[type] ??= []).push(fn); },
    registerCommand(name, options) { commands[name] = options; },
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    events: { emit() {}, on() {} },
    getSessionName: () => "voice-test",
    sendUserMessage() {},
    setModel: async () => true,
    setThinkingLevel() {},
    setSessionName() {},
  };
}

let coord;
let account;
let dir;
let provider;

beforeEach(async () => {
  coord = await startCoordinator();
  account = makeAccount(coord.accounts, "voice@example.com");
  dir = mkdtempSync(join(tmpdir(), "pinet-voice-"));
  provider = fakeProvider();
});

afterEach(async () => {
  await coord.close();
  await new Promise((resolve) => provider.server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
  for (const key of ["PINET_DIR", "PINET_HUB", "PINET_HTTP", "GROQ_API_KEY", "PINET_VOICE", "PINET_VOICE_ASR_URL", "PINET_VOICE_LLM_URL"]) delete process.env[key];
});

describe("voice dictation", () => {
  it("turns sealed audio into cleaned text without the text touching the ack", async () => {
    const base = await provider.listen();
    process.env.PINET_DIR = dir;
    process.env.PINET_HUB = coord.url;
    process.env.PINET_HTTP = coord.httpUrl;
    process.env.GROQ_API_KEY = "test-key";
    process.env.PINET_VOICE_ASR_URL = base;
    process.env.PINET_VOICE_LLM_URL = base;

    const enrolled = enrollDevice(coord.accounts, account.id, "host", "voice-host");
    writeFileSync(join(dir, "host.json"), JSON.stringify({ hostId: enrolled.device.id, identity: enrolled.identity, encryption: enrolled.encryption }));

    const pi = fakePi();
    hostExtension(pi);
    await pi.handlers.session_start[0]({}, makeCtx({ entries: [{ type: "message", id: "v1", parentId: null, message: { role: "user", content: "hi" } }] }));

    const ctl = enrollDevice(coord.accounts, account.id, "controller", "voice-ctl");
    const controller = new PiNetController({ url: coord.url, deviceId: ctl.device.id, identity: ctl.identity, encryption: ctl.encryption });
    await controller.connect();
    for (let i = 0; i < 120; i += 1) {
      if ((await controller.list()).some((s) => s.sessionId === SESSION)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const snapshot = waitFor(controller, "snapshot", () => true, 10_000);
    await controller.attach(SESSION, "control");
    await snapshot;

    // The host advertises voice in the (clear) meta so the UI knows to offer it.
    const session = (await controller.list()).find((s) => s.sessionId === SESSION);
    expect(session.meta.voice).toEqual({ enabled: true });

    const voice = waitFor(controller, "voice", () => true, 15_000);
    await controller.command(SESSION, "voice.start", {});
    const pcm = Buffer.from(Int16Array.from([1, 2, 3, 4, 5, 6, 7, 8]).buffer);
    await controller.sendAudio(SESSION, pcm.toString("base64"), 0);
    await controller.sendAudio(SESSION, pcm.toString("base64"), 1);
    const ack = await controller.command(SESSION, "voice.end", {});

    // The ack is plaintext at the coordinator, so the transcript must not be in it.
    expect(ack.accepted).toBe(true);
    expect(JSON.stringify(ack)).not.toContain("PiNet coordinator should not see");
    expect(ack.data).toBeUndefined();

    const result = await voice;
    expect(result.text).toBe("The PiNet coordinator should not see the payload.");
    // The raw transcript comes along so the client can offer "use what I said".
    expect(result.raw).toContain("pin net");
    expect(result.flags).toEqual([]);
    expect(provider.calls.asr).toBe(1);
    expect(provider.calls.chat).toBe(1);
    // The cleanup ran the policy prompt at temperature 0.
    expect(provider.calls.chatBody.temperature).toBe(0);
    expect(provider.calls.chatBody.messages[0].content).toContain("PiNet");
    controller.close();
  }, 30_000);
});
