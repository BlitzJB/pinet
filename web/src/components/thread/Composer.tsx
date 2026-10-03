import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUpIcon, BrainIcon, ChevronDownIcon, LoaderIcon, MicIcon, Minimize2Icon, SquareIcon, Undo2Icon } from "lucide-react";
import { cn } from "../../lib/utils";
import type { ModelInfo } from "../../lib/pinet";
import { appendPeaks, startVoiceRecorder, MicError, type VoiceRecorder } from "../../lib/voice";
import { activeToken, commandAtStart, commandItems, fileItems, replaceToken, tuiOnlyNotice, type CommandInfo, type MenuItem, type Token } from "../../lib/mentions";
import { ComposerMenu } from "../ui/ComposerMenu";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { ghostButton, iconSwap, iconSwapIn, iconSwapOut, paper } from "../ui/surfaces";
import { ContextMeter } from "./ContextMeter";
import { ModelPicker } from "./ModelPicker";
import { VoiceWaveform } from "./VoiceWaveform";

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
  onModel,
  loadModels,
  onSend,
  onStop,
  onCompact,
  onThinking,
  onVoiceTake,
  commands,
  loadFiles,
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
  onModel?: (provider: string, modelId: string, name: string) => void;
  loadModels?: (options?: { refresh?: boolean }) => Promise<ModelInfo[]>;
  onSend: (text: string) => void | Promise<void>;
  onStop: () => void;
  onCompact: () => void;
  onThinking: (level: string) => void;
  /** Send a take for transcription; resolves with the cleaned text. */
  onVoiceTake?: (chunks: string[]) => Promise<{ text: string; raw?: string; flags?: string[] }>;
  /** Slash commands the session offers, for the `/` palette. */
  commands?: CommandInfo[];
  /** Paths under the session directory, for `@` completion. */
  loadFiles?: (prefix: string) => Promise<string[]>;
}) {
  const [text, setText] = useState("");
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [confirmCompact, setConfirmCompact] = useState(false);
  const [recording, setRecording] = useState(false);
  const [polishing, setPolishing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ token: Token; index: number } | null>(null);
  const [fileMatches, setFileMatches] = useState<string[]>([]);
  const [retryTake, setRetryTake] = useState<string[] | null>(null);
  const takeRef = useRef<string[]>([]);
  const [insertion, setInsertion] = useState<{ start: number; end: number; at: number } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const recorderRef = useRef<VoiceRecorder | null>(null);
  const peaksRef = useRef<number[]>([]);

  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "0px";
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  }, [text]);

  function submit() {
    // A command that only exists in the terminal is refused here, with the reason,
    // rather than after a round trip.
    const terminalOnly = commandAtStart(text, commands ?? []);
    if (terminalOnly?.source === "tui") {
      setNotice(tuiOnlyNotice(terminalOnly.name));
      return;
    }
    setMenu(null);
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
        // Buffered here rather than streamed: the take is sent once, and a failure
        // can be retried without the audio having gone anywhere.
        onChunk: (chunk) => {
          takeRef.current.push(chunk);
        },
        onError: (message) => setNotice(message),
        onPeaks: (peaks) => {
          peaksRef.current = appendPeaks(peaksRef.current, peaks);
        },
      });
      recorderRef.current = recorder;
      setRecording(true);
    } catch (error) {
      setMicError(error instanceof MicError ? error.message : "Could not start recording");
    }
  }

  async function stopRecording({ cancel = false }: { cancel?: boolean } = {}) {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    setRecording(false);
    peaksRef.current = [];
    await recorder?.stop();
    const take = takeRef.current;
    takeRef.current = [];
    if (cancel || !take.length) return;
    await submitTake(take);
  }

  /** Transcribe a take and insert the result. The audio stays here for a retry. */
  async function submitTake(take: string[]) {
    setPolishing(true);
    setNotice(null);
    setMicError(null);
    try {
      const result = await onVoiceTake?.(take);
      const flags = result?.flags ?? [];
      if (!result?.text) {
        setNotice(
          flags.includes("no_speech")
            ? "Didn't catch that"
            : flags.includes("voice_disabled")
              ? "Dictation isn't enabled on the hub"
              : "Couldn't transcribe that",
        );
        setRetryTake(take);
        return;
      }
      insertAtCaret(result.text);
      setRetryTake(null);
      setNotice(flags.includes("truncated") ? "Only the first ten minutes were used" : null);
    } catch {
      setNotice("Couldn't transcribe that");
      setRetryTake(take);
    } finally {
      setPolishing(false);
    }
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

  // The undo affordance expires so it doesn't linger over the composer.
  useEffect(() => {
    if (!insertion) return;
    const timer = setTimeout(() => setInsertion(null), 12_000);
    return () => clearTimeout(timer);
  }, [insertion]);


  // -- `/` commands and `@` mentions -----------------------------------------

  const items: MenuItem[] = menu?.token.kind === "mention" ? fileItems(fileMatches) : commandItems(commands ?? [], menu?.token.query ?? "");
  const menuOpen = menu !== null && items.length > 0;
  const active = menu ? Math.min(menu.index, Math.max(0, items.length - 1)) : 0;
  const listRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);

  // With only four rows visible, the highlighted one has to be kept in view.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [active, menuOpen]);

  /** Recompute the token under the caret. The highlighted row survives typing. */
  function syncMenu(next?: string) {
    const element = textareaRef.current;
    const value = next ?? text;
    const token = activeToken(value, element?.selectionStart ?? value.length);
    setMenu((current) => (token ? { token, index: current && current.token.kind === token.kind ? current.index : 0 } : null));
  }

  // Held in a ref: an inline `loadFiles` from the parent changes identity every
  // render, which would otherwise re-run this effect on every keystroke.
  const loadFilesRef = useRef(loadFiles);
  useEffect(() => {
    loadFilesRef.current = loadFiles;
  }, [loadFiles]);

  useEffect(() => {
    if (menu?.token.kind !== "mention") {
      setFileMatches([]);
      return;
    }
    const query = menu.token.query;
    // The host owns the directory and does the ranking; debounced so typing does
    // not fire a request per character.
    const timer = setTimeout(() => {
      void loadFilesRef.current?.(query).then(setFileMatches).catch(() => setFileMatches([]));
    }, 120);
    return () => clearTimeout(timer);
  }, [menu?.token.kind, menu?.token.query]);

  function accept(item: MenuItem) {
    if (!menu || item.disabled) return;
    const { text: next, caret } = replaceToken(text, menu.token, item.insert);
    setText(next);
    setMenu(null);
    requestAnimationFrame(() => {
      const element = textareaRef.current;
      if (!element) return;
      element.focus();
      element.setSelectionRange(caret, caret);
    });
  }

  const hasText = text.trim().length > 0;
  // While a run is in flight the button only becomes "stop" when there is
  // nothing to send; with text it stays a send button so a steering message can
  // still go out mid-run.
  const stopping = busy && !hasText;

  return (
    <div className="relative w-full">
      {menuOpen && (
        // A sheet that rises from behind the composer: it is tucked under the card's
        // top edge, so it reads as sliding out of it rather than floating over it.
        <div
          className={cn(
            paper,
            "absolute inset-x-0 z-0 flex flex-col overflow-hidden rounded-t-[22px] rounded-b-none border-b-0 shadow-[0_-10px_30px_-18px_rgba(0,0,0,0.35)]",
          )}
          style={{ bottom: "calc(100% - 14px)", animation: "pinet-rise 200ms cubic-bezier(0.2, 0.8, 0.2, 1)" }}
        >
          <div className="flex items-center justify-between px-3.5 pb-0.5 pt-2.5">
            <span className="text-[10.5px] uppercase tracking-[0.08em] text-muted-foreground/45">
              {menu?.token.kind === "mention" ? "Files" : "Commands"}
            </span>
            <button
              type="button"
              onClick={() => setMenu(null)}
              className="rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground/60 transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
            >
              Cancel
            </button>
          </div>
          <div ref={listRef} className="max-h-[168px] overflow-y-auto overscroll-contain pb-1">
            {items.map((item, index) => (
              <button
                key={item.value}
                ref={index === active ? activeRef : undefined}
                type="button"
                disabled={item.disabled}
                onMouseEnter={() => setMenu((current) => current && { ...current, index })}
                onClick={() => accept(item)}
                className={cn(
                  "flex w-full items-center justify-between gap-3 px-3.5 py-[11px] text-left transition-colors",
                  index === active && !item.disabled ? "bg-foreground/[0.06]" : "hover:bg-foreground/[0.04]",
                  item.disabled && "opacity-45",
                )}
              >
                {/* The match on the left, its description on the right. */}
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <span className="truncate text-[13px] font-medium">{item.label}</span>
                  {item.hint && <span className="shrink-0 text-[10.5px] text-muted-foreground/50">{item.hint}</span>}
                </span>
                {item.description && (
                  <span className="max-w-[46%] shrink-0 truncate text-right text-[11px] text-muted-foreground/60">
                    {item.description}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className={cn(paper, "relative z-10 flex w-full flex-col gap-1 rounded-[24px] p-2.5 shadow-lg shadow-black/5 transition-colors")}>
      <textarea
        ref={textareaRef}
        value={text}
        disabled={disabled}
        onChange={(event) => {
          setText(event.target.value);
          syncMenu(event.target.value);
        }}
        onKeyUp={() => syncMenu()}
        onClick={() => syncMenu()}
        onKeyDown={(event) => {
          if (menuOpen) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : items.length - 1;
              setMenu((current) => current && { ...current, index: (current.index + step) % items.length });
              return;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              event.preventDefault();
              accept(items[active]);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setMenu(null);
              return;
            }
          }
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
              {recording && <VoiceWaveform peaks={peaksRef} active={recording} />}
              {!recording && polishing && <span className="truncate">Polishing…</span>}
              {!recording && !polishing && (micError || notice) && (
                <span className={cn("max-w-[16rem] truncate", micError && !notice && "text-amber-500")}>{notice ?? micError}</span>
              )}
              {!recording && !polishing && retryTake && (
                <button
                  type="button"
                  onClick={() => {
                    const take = retryTake;
                    setRetryTake(null);
                    if (take) void submitTake(take);
                  }}
                  className="shrink-0 rounded-full px-1.5 py-0.5 text-[11px] text-muted-foreground underline decoration-dotted transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
                  title="Transcribe the saved audio again"
                >
                  Retry
                </button>
              )}
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
    </div>
  );
}
