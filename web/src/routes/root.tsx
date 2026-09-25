import { useEffect, useRef, useState } from "react";
import { Outlet, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronRightIcon } from "lucide-react";
import { getMe, loginUrl } from "../lib/api";
import { PinetProvider } from "../lib/context";
import { SessionSidebar } from "../components/SessionSidebar";
import { cn } from "../lib/utils";

const DRAWER_WIDTH = 288;
// Horizontal travel (and dominance over vertical) required before a touch is
// treated as a drag rather than a tap.
const COMMIT_PX = 18;
const COMMIT_RATIO = 1.6;
// Android's gesture navigation reserves a strip along each edge for the system
// back gesture and there is no web API to opt out (that needs a native shell's
// `setSystemGestureExclusionRects`). We do everything a PWA can:
//   - treat the drawer edge as our own: non-passive touchmove + preventDefault
//   - kill Chrome's horizontal swipe-to-navigate (overscroll-behavior-x in css)
//   - keep a tap target on the edge so the drawer is reachable without a swipe
// A back gesture that does reach the OS will still navigate, so the drawer is a
// progressive enhancement over the tap handle.
function useEdgeSwipeDrawer() {
  const [open, setOpen] = useState(false);
  const [offset, setOffset] = useState<number | null>(null); // 0 = open, -100 = closed
  const offsetRef = useRef<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ x: number; y: number; mode: "open" | "close"; committed: boolean } | null>(null);

  const updateOffset = (value: number | null) => {
    offsetRef.current = value;
    setOffset(value);
  };

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const onStart = (event: TouchEvent) => {
      if (window.innerWidth >= 768 || event.touches.length !== 1) {
        gesture.current = null;
        return;
      }
      const touch = event.touches[0];
      const fromEdge = touch.clientX <= 32;
      if (open) gesture.current = { x: touch.clientX, y: touch.clientY, mode: "close", committed: false };
      else if (fromEdge) gesture.current = { x: touch.clientX, y: touch.clientY, mode: "open", committed: false };
      else gesture.current = null;
    };

    const onMove = (event: TouchEvent) => {
      const active = gesture.current;
      if (!active) return;
      const touch = event.touches[0];
      const dx = touch.clientX - active.x;
      const dy = touch.clientY - active.y;
      if (!active.committed) {
        const ax = Math.abs(dx);
        const ay = Math.abs(dy);
        // A tap always jitters a few px. Require a clearly horizontal drag
        // before claiming the gesture, otherwise preventDefault() would cancel
        // the click on the link/button the user actually tapped.
        if (ax < COMMIT_PX) {
          if (ay > COMMIT_PX) gesture.current = null; // clearly vertical: let it scroll
          return;
        }
        if (ax < ay * COMMIT_RATIO) {
          gesture.current = null;
          return;
        }
        active.committed = true;
      }
      // Claim the gesture from the browser/system before it becomes a back swipe.
      event.preventDefault();
      const progress =
        active.mode === "open"
          ? Math.min(1, Math.max(0, dx / DRAWER_WIDTH))
          : Math.min(1, Math.max(0, -dx / DRAWER_WIDTH));
      updateOffset(-100 * (active.mode === "open" ? 1 - progress : progress));
    };

    const onEnd = () => {
      const active = gesture.current;
      gesture.current = null;
      if (!active || !active.committed) {
        updateOffset(null);
        return;
      }
      setOpen((offsetRef.current ?? (open ? 0 : -100)) > -50);
      updateOffset(null);
    };

    element.addEventListener("touchstart", onStart, { passive: true });
    element.addEventListener("touchmove", onMove, { passive: false });
    element.addEventListener("touchend", onEnd, { passive: true });
    element.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      element.removeEventListener("touchstart", onStart);
      element.removeEventListener("touchmove", onMove);
      element.removeEventListener("touchend", onEnd);
      element.removeEventListener("touchcancel", onEnd);
    };
  }, [open]);

  // NOTE: this drawer deliberately does *not* push a history entry. An earlier
  // version pushed a sentinel on open and called history.back() on close so a
  // system back gesture would close it instead of navigating. That raced with
  // the router: tapping a link closed the drawer and back() then undid the
  // navigation, so sessions appeared not to open. Overlays are closed by the
  // scrim or a drag; the back gesture keeps its normal browser meaning.

  return { open, setOpen, offset, ref };
}

function Splash() {
  return (
    <div className="grid h-full place-items-center">
      <div className="flex items-center gap-3 text-muted-foreground">
        <span className="size-3 animate-pulse rounded-full bg-foreground/30" />
        Loading Pinet…
      </div>
    </div>
  );
}

function Login() {
  return (
    <div className="grid h-full place-items-center px-6">
      <div className="fade-in slide-in-from-bottom-1 animate-in fill-mode-both w-full max-w-sm rounded-2xl border border-border/60 bg-card p-8 text-center shadow-xl duration-300 motion-reduce:animate-none">
        <div className="mb-1 text-2xl font-semibold tracking-tight">Pinet</div>
        <p className="mb-6 text-sm text-muted-foreground">Remote control for pi coding-agent sessions.</p>
        <a
          href={loginUrl("/app/")}
          className="inline-flex w-full items-center justify-center rounded-xl bg-foreground px-4 py-2.5 text-sm font-semibold text-background transition-[opacity,scale] duration-150 hover:opacity-90 active:scale-[0.98]"
        >
          Sign in with Google
        </a>
      </div>
    </div>
  );
}

function AppShell() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const activeSessionId = pathname.match(/\/s\/([^/]+)/)?.[1];
  const swipe = useEdgeSwipeDrawer();
  const offset = swipe.offset ?? (swipe.open ? 0 : -100);
  const dragging = swipe.offset !== null;

  return (
    <div ref={swipe.ref} className="flex h-full">
      <div className="hidden md:flex">
        <SessionSidebar activeSessionId={activeSessionId} />
      </div>

      <div className={cn("fixed inset-0 z-40 md:hidden", !swipe.open && !dragging && "pointer-events-none")}>
        <button
          type="button"
          aria-label="Close sessions"
          tabIndex={swipe.open ? 0 : -1}
          onClick={() => swipe.setOpen(false)}
          style={{ opacity: Math.max(0, 1 + offset / 100) }}
          className={cn("absolute inset-0 bg-black/40 backdrop-blur-sm", !dragging && "transition-opacity duration-300")}
        />
        <div
          style={{ transform: `translateX(${offset}%)` }}
          className={cn(
            "absolute inset-y-0 start-0 pt-[env(safe-area-inset-top)]",
            !dragging && "transition-transform duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none",
          )}
        >
          <SessionSidebar activeSessionId={activeSessionId} onNavigate={() => swipe.setOpen(false)} />
        </div>
      </div>

      {!swipe.open && (
        <button
          type="button"
          aria-label="Open sessions"
          onClick={() => swipe.setOpen(true)}
          className="fixed start-0 top-1/2 z-30 flex h-12 w-4 -translate-y-1/2 items-center justify-center rounded-e-full bg-foreground/10 text-foreground/40 backdrop-blur transition-colors hover:bg-foreground/20 md:hidden"
        >
          <ChevronRightIcon className="size-3.5" />
        </button>
      )}

      <main className="flex min-h-0 min-w-0 flex-1 flex-col pt-[env(safe-area-inset-top)]">
        <Outlet />
      </main>
    </div>
  );
}

export function Root() {
  const me = useQuery({ queryKey: ["me"], queryFn: getMe, retry: false, staleTime: 30_000 });
  if (me.isLoading) return <Splash />;
  if (me.isError || !me.data) return <Login />;
  return (
    <PinetProvider>
      <AppShell />
    </PinetProvider>
  );
}
