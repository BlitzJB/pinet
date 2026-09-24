import { useState } from "react";

export function Composer({
  disabled,
  busy,
  onSend,
  onAbort,
}: {
  disabled?: boolean;
  busy?: boolean;
  onSend: (text: string) => void | Promise<void>;
  onAbort: () => void;
}) {
  const [text, setText] = useState("");

  function submit() {
    const value = text.trim();
    if (!value || disabled) return;
    setText("");
    void onSend(value);
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="flex items-end gap-2 border-t border-ink-800 bg-ink-900/80 p-3"
    >
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
        rows={1}
        placeholder={disabled ? "Attach to a session to send messages" : "Message the remote agent…  (Enter to send, Shift+Enter for newline)"}
        className="max-h-40 min-h-[44px] flex-1 resize-y rounded-xl border border-ink-700 bg-ink-950 px-3 py-2.5 text-sm text-mist-200 outline-none placeholder:text-mist-400/60 focus:border-brand-500 disabled:opacity-50"
      />
      {busy && (
        <button
          type="button"
          onClick={onAbort}
          className="rounded-xl border border-bad-400/40 px-4 py-2.5 text-sm font-medium text-bad-400 hover:bg-bad-400/10"
        >
          Stop
        </button>
      )}
      <button
        type="submit"
        disabled={disabled || !text.trim()}
        className="rounded-xl bg-brand-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-400 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Send
      </button>
    </form>
  );
}
