import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/utils";

const ITEM_SELECTOR = '[role="menuitem"]:not([disabled])';

/**
 * Dropdown anchored to an element but rendered in a portal with fixed
 * positioning, so it is never clipped by a scroll container (the session list
 * is `overflow-y-auto`) and never fights its stacking context.
 *
 * Right-aligned to the anchor and flipped above it when short on room below.
 * Closes on Escape, outside pointerdown, scroll or resize; ArrowUp/ArrowDown/
 * Home/End move focus, and focus is restored to the anchor on Escape.
 */
export function AnchoredMenu({
  anchor,
  onClose,
  children,
  className,
  width = 176,
}: {
  anchor: HTMLElement | null;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>();
  const [shown, setShown] = useState(false);

  useLayoutEffect(() => {
    if (!anchor) {
      setShown(false);
      setStyle(undefined);
      return;
    }
    const rect = anchor.getBoundingClientRect();
    const height = ref.current?.offsetHeight ?? 0;
    const below = window.innerHeight - rect.bottom;
    const top = below < height + 12 && rect.top > height + 12 ? rect.top - height - 6 : rect.bottom + 6;
    setStyle({
      position: "fixed",
      top: Math.max(8, top),
      right: Math.max(8, window.innerWidth - rect.right),
      width,
      zIndex: 60,
    });
    setShown(true);
  }, [anchor, width]);

  useEffect(() => {
    if (!anchor) return;
    const items = () => [...(ref.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? [])];
    const onKey = (event: KeyboardEvent) => {
      const list = items();
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        anchor.focus?.();
        return;
      }
      if (!list.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const current = list.indexOf(document.activeElement as HTMLElement);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? list.length - 1
            : event.key === "ArrowDown"
              ? (current + 1) % list.length
              : (current - 1 + list.length) % list.length;
      list[next]?.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [anchor, onClose]);

  useEffect(() => {
    if (!anchor) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (ref.current?.contains(target) || anchor.contains(target)) return;
      onClose();
    };
    const dismiss = () => onClose();
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [anchor, onClose]);

  // Focus the first item once positioned, like a native menu.
  useEffect(() => {
    if (!shown) return;
    ref.current?.querySelector<HTMLElement>(ITEM_SELECTOR)?.focus();
  }, [shown]);

  if (!anchor) return null;

  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={style}
      className={cn(
        "flex flex-col gap-0.5 rounded-xl border border-border/60 bg-popover p-1.5 shadow-xl shadow-black/20",
        "transition-[opacity,scale] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none",
        shown ? "scale-100 opacity-100" : "pointer-events-none scale-[0.97] opacity-0",
        className,
      )}
    >
      {children}
    </div>,
    document.body,
  );
}

/** Shared item styling for menu rows. */
export const menuItem =
  "flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 text-start text-[13px] text-foreground/80 transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:pointer-events-none disabled:opacity-40";
