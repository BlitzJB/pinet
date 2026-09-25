import { useEffect, type ReactNode } from "react";
import { cn } from "../../lib/utils";
import { paper } from "./surfaces";

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center px-4">
      <button
        type="button"
        aria-label="Close"
        onClick={onCancel}
        className="fade-in animate-in absolute inset-0 bg-black/40 backdrop-blur-sm duration-150 motion-reduce:animate-none"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          paper,
          "fade-in zoom-in-95 animate-in relative w-full max-w-sm rounded-2xl p-5 shadow-2xl duration-150 motion-reduce:animate-none",
        )}
      >
        <h2 className="text-sm font-semibold">{title}</h2>
        {description && <div className="mt-2 text-[13px] leading-relaxed text-muted-foreground">{description}</div>}
        {children}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full px-3.5 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            autoFocus
            disabled={busy}
            onClick={onConfirm}
            className={cn(
              "rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-[opacity,scale,background-color] duration-150 active:scale-[0.97] disabled:opacity-50",
              destructive ? "bg-destructive text-white hover:opacity-90" : "bg-foreground text-background hover:opacity-90",
            )}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
