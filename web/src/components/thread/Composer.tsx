import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUpIcon, BrainIcon, ChevronDownIcon, LoaderIcon, MicIcon, Minimize2Icon, SquareIcon, Undo2Icon } from "lucide-react";
import { cn } from "../../lib/utils";
import type { ModelInfo, VoiceResult } from "../../lib/pinet";
import { startVoiceRecorder, MicError, captureDiagnostics, micPermissionState, voiceSupported, type MicErrorInfo, type VoiceRecorder } from "../../lib/voice";
import { ComposerMenu } from "../ui/ComposerMenu";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { ghostButton, iconSwap, iconSwapIn, iconSwapOut, paper } from "../ui/surfaces";
import { ContextMeter } from "./ContextMeter";
import { ModelPicker } from "./ModelPicker";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function Composer({
  busy,
  disabled,
  attached,
  mode,
  model,
  thinkingLevel,
  contextUsage,
  compacting,
  voiceEnabled,
  voice,
  onModel,
  loadModels,
  onSend,
  onStop,
  onCompact,
  onThinking,
  onVoiceChunk,
  onVoiceEnd,
  onVoiceCancel,
  onVoiceConsumed,
}: {
  busy: boolean;
  disabled: boolean;
  attached?: boolean;
  mode?: string | null;
  model?: { provider: string; id: string } | null;
  thinkingLevel?: string | null;
  contextUsage?: { tokens?: number | null; contextWindow?: number; percent?: number | null } | null;
  compacting?: boolean;
  /** The host has a dictation provider configured (from session meta). */
  voiceEnabled?: boolean;
  /** Latest dictation result from the host; consumed once inserted. */
  voice?: VoiceResult | null;
  onModel?: (provider: string, modelId: string, name: string) => void;
  loadModels?: (options?: { refresh?: boolean }) => Promise<ModelInfo[]>;
  onSend: (text: string) => void | Promise<void>;
  onStop: () => void;
  onCompact: () => void;
  onThinking: (level: string) => void;
  onVoiceChunk?: (chunk: string, index: number) => void | Promise<void>;
  onVoiceEnd?: () => void | Promise<void>;
  onVoiceCancel?: () => void | Promise<void>;
  onVoiceConsumed?: () => void;
}) {
  const [text, setText] = useState("");
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [confirmCompact, setConfirmCompact] = useState(false);
  const [recording, setRecording] = useState(false);
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [polishing, setPolishing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [micError, setMicError] = useState<MicErrorInfo | null>(null);
  const [diagnostics, setDiagnostics] = useState<Record<string, unknown> | null>(null);
  const [insertion, setInsertion] = useState<{ start: number; end: number; at: number } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const recorderRef = useRef<VoiceRecorder | null>(null);
  const handledAt = useRef<number | null>(null);

  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "0px";
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  }, [text]);

  function submit() {
    const value = text.trim();
    if (!value || disabled) return;
    setText("");
    void onSend(value);
  }

  // -- dictation ------------------------------------------------------------

  async function startRecording() {
    if (!voiceEnabled || recording || polishing) return;
    setNotice(null);
    setMicError(null);
    try {
      // Capture first, always. getUserMedia has to run inside the click's gesture
      // window, and awaiting a round trip to the host here would consume it —
      // Safari then rejects with NotAllowedError, which is indistinguishable from
      // a real permission denial. No host call is needed before capture: the host
      // resets its buffer when chunk index 0 of a new take arrives.
      const recorder = await startVoiceRecorder({
        onChunk: (chunk, index) => {
          void onVoiceChunk?.(chunk, index);
        },
        onError: (message) => setNotice(message),
        onLevel: setLevel,
      });
      recorderRef.current = recorder;
      setElapsed(0);
      setRecording(true);
    } catch (error) {
      // Any failure at all becomes a visible, copyable report: capture used to
      // fail silently, which is indistinguishable from the button being broken.
      const info: MicErrorInfo =
        error instanceof MicError
          ? error.info
          : {
              message: "Could not start recording",
              hint: "Reload the page. If it happens again, copy the diagnostics below and send them over.",
              detail: `${(error as { name?: string })?.name ?? "Error"}: ${(error as { message?: string })?.message ?? String(error)}`,
            };
      setMicError(info);
      setDiagnostics(await captureDiagnostics({ lastError: info.detail, hostVoice: voiceEnabled ? "enabled" : "not advertised by host" }));
    }
  }

  /** Re-read the permission state after the user has changed a browser or OS setting. */
  async function recheckMicrophone() {
    setMicError(null);
    setDiagnostics(null);
    const permission = await micPermissionState();
    if (permission === "denied") {
      setMicError({
        message: "Still blocked for this site",
        hint: "Click the mic icon in the address bar → Microphone → Allow, then reload the page. A reload alone does not clear a remembered block.",
        detail: `permission=${permission}`,
      });
      setDiagnostics(await captureDiagnostics({ lastError: "permission=denied" }));
      return;
    }
    await startRecording();
  }

  async function stopRecording({ cancel = false }: { cancel?: boolean } = {}) {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    setRecording(false);
    setLevel(0);
    await recorder?.stop();
    if (cancel) {
      await onVoiceCancel?.();
      return;
    }
    setPolishing(true);
    await onVoiceEnd?.();
  }

  /**
   * Put the dictated text where the caret is. Spacing is the only thing the two
   * sides cannot agree on by themselves, so it is handled here: one space
   * between words, nothing before punctuation or at the very start.
   */
  function insertAtCaret(value: string) {
    const element = textareaRef.current;
    const start = element?.selectionStart ?? text.length;
    const end = element?.selectionEnd ?? text.length;
    const before = text.slice(0, start);
    const after = text.slice(end);
    const spacer = before.length > 0 && !/\s$/.test(before) && !/^[,.;:!?)]/.test(value) ? " " : "";
    const caret = start + spacer.length + value.length;
    setText(`${before}${spacer}${value}${after}`);
    setInsertion({ start: start + spacer.length, end: caret, at: Date.now() });
    requestAnimationFrame(() => {
      const target = textareaRef.current;
      if (!target) return;
      target.focus();
      target.setSelectionRange(caret, caret);
    });
  }

  function undoInsertion() {
    if (!insertion) return;
    setText((current) => current.slice(0, insertion.start) + current.slice(insertion.end));
    setInsertion(null);
  }

  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setElapsed((value) => value + 100), 100);
    return () => clearInterval(timer);
  }, [recording]);

  // The undo affordance expires so it doesn't linger over the composer.
  useEffect(() => {
    if (!insertion) return;
    const timer = setTimeout(() => setInsertion(null), 12_000);
    return () => clearTimeout(timer);
  }, [insertion]);

  useEffect(() => {
    if (!voice || typeof voice.at !== "number" || voice.at === handledAt.current) return;
    handledAt.current = voice.at;
    setPolishing(false);
    const flags = voice.flags ?? [];
    if (!voice.text) {
      setNotice(
        flags.includes("no_speech")
          ? "Didn't catch that"
          : flags.includes("voice_disabled")
            ? "Dictation is not configured on this host"
            : flags.includes("too_long")
              ? "That was too long — try a shorter take"
              : "Dictation failed",
      );
      onVoiceConsumed?.();
      return;
    }
    insertAtCaret(voice.text);
    if (flags.includes("dropped_content") || flags.includes("added_content")) {
      setNotice("Inserted — check this one, the cleanup looked lossy");
    } else if (flags.includes("cleanup_failed")) {
      setNotice("Inserted the raw transcript (cleanup failed)");
    } else {
      setNotice(null);
    }
    onVoiceConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice]);

  const hasText = text.trim().length > 0;
  // While a run is in flight the button only becomes "stop" when there is
  // nothing to send; with text it stays a send button so a steering message can
  // still go out mid-run.
  const stopping = busy && !hasText;

  return (
    <div className={cn(paper, "flex w-full flex-col gap-1 rounded-[24px] p-2.5 shadow-lg shadow-black/5 transition-colors")}>
      <textarea
        ref={textareaRef}
        value={text}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          // Enter inserts a newline (mobile keyboards send a bare Enter); send
          // explicitly with the button or Cmd/Ctrl+Enter.
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          } else if (event.key === "Escape" && recording) {
            // Escape abandons the take: stop capturing and tell the host to drop
            // whatever audio it already holds.
            event.preventDefault();
            void stopRecording({ cancel: true });
          }
        }}
        rows={1}
        placeholder={disabled ? "Attach to a session to send messages" : "Message the agent…"}
        className="min-h-11 w-full resize-none bg-transparent px-3 pt-2.5 text-[15px] leading-relaxed caret-blue-500 outline-none placeholder:text-foreground/35 disabled:opacity-50 dark:caret-blue-400"
      />
      <div className="flex items-center gap-1 px-1">
        <div className="flex min-w-0 items-center gap-1">
          <span
            aria-label={!attached ? "Not attached" : mode === "control" ? "Control" : "Read-only"}
            title={
              !attached
                ? "Not attached to this session"
                : mode === "control"
                  ? "Control — you can send commands"
                  : `Attached (${mode ?? "read-only"})`
            }
            className={cn(
              "ms-1.5 size-2 shrink-0 rounded-full",
              !attached ? "bg-foreground/25" : mode === "control" ? "bg-emerald-500" : "bg-amber-400",
            )}
          />
          {onModel && loadModels && (
            <ModelPicker model={model} disabled={disabled} load={loadModels} onSelect={onModel} />
          )}
          <div className="relative">
            <button
              type="button"
              disabled={disabled}
              onClick={() => setThinkingOpen((value) => !value)}
              className={cn(ghostButton, "h-auto gap-1.5 rounded-full px-2.5 py-1 text-xs disabled:opacity-40")}
              title="Reasoning effort"
            >
              <BrainIcon className="size-3.5" />
              <span className="hidden sm:inline">{thinkingLevel ?? "thinking"}</span>
              <ChevronDownIcon className={cn("size-3 transition-transform duration-200", thinkingOpen && "rotate-180")} />
            </button>
            <ComposerMenu open={thinkingOpen} align="start" className="w-44 p-1.5">
              {THINKING_LEVELS.map((level) => (
                <button
                  key={level}
                  type="button"
                  onClick={() => {
                    onThinking(level);
                    setThinkingOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 text-[13.5px] capitalize transition-colors",
                    level === thinkingLevel ? "bg-foreground/[0.06]" : "hover:bg-foreground/[0.04]",
                  )}
                >
                  <BrainIcon className="size-3.5 shrink-0 text-foreground/35" />
                  {level}
                </button>
              ))}
            </ComposerMenu>
          </div>
          <button
            type="button"
            disabled={disabled}
            onClick={() => setConfirmCompact(true)}
            className={cn(ghostButton, "h-auto gap-1.5 rounded-full px-2.5 py-1 text-xs disabled:opacity-40")}
            title="Compact context"
          >
            <Minimize2Icon className="size-3.5" />
            <span className="hidden sm:inline">Compact</span>
          </button>
        </div>

        <div className="ms-auto flex shrink-0 items-center gap-1.5">
          {(recording || polishing || notice || insertion) && (
            <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground/70" role="status" aria-live="polite">
              {recording && (
                <span className="flex items-center gap-1.5">
                  <span aria-hidden className="size-1.5 rounded-full bg-red-500 motion-safe:animate-pulse" />
                  <span className="tabular-nums">{(elapsed / 1000).toFixed(1)}s</span>
                  <span aria-hidden className="h-1 w-6 overflow-hidden rounded-full bg-foreground/10">
                    <span
                      className="block h-full rounded-full bg-red-500/70 transition-[width] duration-100 ease-out motion-reduce:transition-none"
                      style={{ width: `${Math.round(Math.min(1, level * 1.8) * 100)}%` }}
                    />
                  </span>
                </span>
              )}
              {!recording && polishing && <span className="truncate">Polishing…</span>}
              {!recording && !polishing && notice && <span className="max-w-[16rem] truncate">{notice}</span>}
              {!recording && !polishing && insertion && (
                <button
                  type="button"
                  onClick={undoInsertion}
                  className="flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
                  title="Undo the dictated text"
                >
                  <Undo2Icon className="size-3" />
                  Undo
                </button>
              )}
            </span>
          )}
          {voiceEnabled && (
            <button
              type="button"
              aria-label={recording ? "Stop dictation" : "Dictate"}
              aria-pressed={recording}
              title={recording ? "Stop dictation (Esc to cancel)" : "Dictate"}
              onClick={() => void (recording ? stopRecording() : startRecording())}
              disabled={disabled || polishing}
              className={cn(
                "relative grid size-9 shrink-0 place-items-center rounded-full transition-[background-color,color,scale] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] active:scale-[0.94] disabled:opacity-30 motion-reduce:transition-none",
                recording
                  ? "bg-red-500/15 text-red-400"
                  : "text-muted-foreground/70 hover:bg-foreground/[0.05] hover:text-foreground",
              )}
            >
              {polishing ? <LoaderIcon className="size-4 animate-spin motion-reduce:animate-none" /> : <MicIcon className="size-4" />}
              {recording && (
                <span aria-hidden className="absolute inset-0 rounded-full ring-1 ring-red-500/40 motion-safe:animate-pulse" />
              )}
            </button>
          )}
          <ContextMeter usage={contextUsage} compacting={compacting} />
          <span aria-hidden className="hidden text-[10px] text-muted-foreground/35 sm:inline">
            ⌘↵
          </span>
          <button
            type="button"
            aria-label={stopping ? "Stop" : "Send"}
            title={stopping ? "Stop" : "Send (⌘↵)"}
            onClick={stopping ? onStop : submit}
            disabled={disabled || (!stopping && !hasText)}
            className={cn(
              "relative grid size-9 shrink-0 place-items-center rounded-full",
              "bg-foreground text-background transition-[opacity,scale,background-color] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]",
              "hover:opacity-90 active:scale-[0.94] disabled:opacity-30 motion-reduce:transition-none",
            )}
          >
            <span className={cn(iconSwap, stopping ? iconSwapOut : iconSwapIn)}>
              <ArrowUpIcon className="size-4" />
            </span>
            <span className={cn(iconSwap, stopping ? iconSwapIn : iconSwapOut)}>
              <SquareIcon className="size-3.5 fill-current" />
            </span>
          </button>
        </div>
      </div>

      {/* A capture failure is reported in full: silently doing nothing is
          indistinguishable from a broken button. */}
      {micError && (
        <div className="mx-1 mb-1 rounded-2xl border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2" role="alert">
          <div className="flex items-start gap-2">
            <span className="mt-[3px] size-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden />
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-[12.5px] text-amber-600 dark:text-amber-400">{micError.message}</p>
              <p className="text-[12px] leading-snug text-muted-foreground">{micError.hint}</p>
              <div className="flex flex-wrap items-center gap-2 pt-0.5">
                <button
                  type="button"
                  onClick={() => void recheckMicrophone()}
                  className={cn(ghostButton, "h-auto rounded-full px-2 py-0.5 text-[11.5px]")}
                >
                  Try again
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const text = JSON.stringify(diagnostics ?? {}, null, 2);
                    navigator.clipboard?.writeText(text).then(
                      () => setNotice("Diagnostics copied"),
                      () => setNotice(null),
                    );
                  }}
                  className={cn(ghostButton, "h-auto rounded-full px-2 py-0.5 text-[11.5px]")}
                >
                  Copy diagnostics
                </button>
                {!voiceSupported() && (
                  <span className="text-[11px] text-muted-foreground/70">this browser cannot capture audio (no AudioWorklet)</span>
                )}
              </div>
              {diagnostics && (
                <pre className="mt-1 max-h-32 overflow-auto rounded-lg bg-foreground/[0.04] p-2 text-[10px] leading-tight text-muted-foreground/80">
                  {JSON.stringify(diagnostics, null, 2)}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmCompact}
        title="Compact this context?"
        confirmLabel="Compact"
        onConfirm={() => {
          setConfirmCompact(false);
          onCompact();
        }}
        onCancel={() => setConfirmCompact(false)}
        description={
          <>
            The agent summarizes the conversation so far and continues from that summary. The transcript stays in PiNet, but older
detail may be dropped from the model's view.
            {typeof contextUsage?.percent === "number" && (
              <>
                {" "}
                Currently using <b>{Math.round(contextUsage.percent)}%</b> of the context window.
              </>
            )}
          </>
        }
      />
    </div>
  );
}
