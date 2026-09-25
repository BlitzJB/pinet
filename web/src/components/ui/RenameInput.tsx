import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils";

export function RenameInput({
  value,
  onSave,
  onCancel,
  className,
}: {
  value: string;
  onSave: (name: string) => void;
  onCancel: () => void;
  className?: string;
}) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save) onSave(text);
    else onCancel();
  };

  return (
    <input
      ref={ref}
      value={text}
      onChange={(event) => setText(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          finish(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
      className={cn(
        "w-full min-w-0 rounded-md border border-border/60 bg-background px-2 py-1 text-[13px] outline-none focus:border-blue-500",
        className,
      )}
    />
  );
}
