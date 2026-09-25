import { useLayoutEffect, useRef, useState } from "react";
import { ArrowUpIcon, BrainIcon, ChevronDownIcon, Minimize2Icon, SquareIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import { ComposerMenu } from "../ui/ComposerMenu";
import { ghostButton, iconSwap, iconSwapIn, iconSwapOut, mono, paper } from "../ui/surfaces";
import { ContextMeter } from "./ContextMeter";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function Composer({
  busy,
  disabled,
  model,
  thinkingLevel,
  contextUsage,
  compacting,
  onSend,
  onStop,
  onCompact,
  onThinking,
}: {
  busy: boolean;
  disabled: boolean;
  model?: { provider: string; id: string } | null;
  thinkingLevel?: string | null;
  contextUsage?: { tokens?: number | null; contextWindow?: number; percent?: number | null } | null;
  compacting?: boolean;
  onSend: (text: string) => void | Promise<void>;
  onStop: () => void;
  onCompact: () => void;
  onThinking: (level: string) => void;
}) {
  const [text, setText] = useState("");
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  return (
    <div className={cn(paper, "flex w-full flex-col gap-1 rounded-[24px] p-2.5 shadow-lg shadow-black/5 transition-colors")}>
      <textarea
        ref={textareaRef}
        value={text}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
        rows={1}
        placeholder={disabled ? "Attach to a session to send messages" : "Message the agent…"}
        className="min-h-11 w-full resize-none bg-transparent px-3 pt-2.5 text-[15px] leading-relaxed caret-blue-500 outline-none placeholder:text-foreground/35 disabled:opacity-50 dark:caret-blue-400"
      />
      <div className="flex items-center gap-1 px-1">
        <div className="flex min-w-0 items-center gap-1">
          {model && (
            <span
              className={cn(mono, "hidden max-w-[10rem] truncate rounded-full bg-foreground/[0.05] px-2 py-1 text-foreground/45 sm:inline-block")}
              title={`${model.provider}/${model.id}`}
            >
              {model.id}
            </span>
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
            <ComposerMenu open={thinkingOpen} align="start">
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
            onClick={onCompact}
            className={cn(ghostButton, "h-auto gap-1.5 rounded-full px-2.5 py-1 text-xs disabled:opacity-40")}
            title="Compact context"
          >
            <Minimize2Icon className="size-3.5" />
            <span className="hidden sm:inline">Compact</span>
          </button>
        </div>

        <div className="ms-auto flex shrink-0 items-center gap-1.5">
          <ContextMeter usage={contextUsage} compacting={compacting} />
          <button
            type="button"
            aria-label={busy ? "Stop" : "Send"}
            onClick={busy ? onStop : submit}
            disabled={disabled || (!busy && !text.trim())}
            className={cn(
              "relative grid size-9 shrink-0 place-items-center rounded-full",
              "bg-foreground text-background transition-[opacity,scale,background-color] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]",
              "hover:opacity-90 active:scale-[0.94] disabled:opacity-30 motion-reduce:transition-none",
            )}
          >
            <span className={cn(iconSwap, busy ? iconSwapOut : iconSwapIn)}>
              <ArrowUpIcon className="size-4" />
            </span>
            <span className={cn(iconSwap, busy ? iconSwapIn : iconSwapOut)}>
              <SquareIcon className="size-3.5 fill-current" />
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
