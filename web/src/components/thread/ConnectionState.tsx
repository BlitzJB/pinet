import type { ComponentProps } from "react";
import { CloudOffIcon, Loader2Icon } from "lucide-react";
import { cn } from "../../lib/utils";
import { mono, paper } from "../ui/surfaces";
import type { ConnStatus } from "../../lib/pinet";

export function ConnectionState({
  status,
  error,
  className,
  ...props
}: Omit<ComponentProps<"div">, "children"> & { status: ConnStatus; error?: string }) {
  if (status === "connected" || status === "idle") return null;
  const reconnecting = status === "connecting" || status === "reconnecting";

  return (
    <div
      className={cn(
        paper,
        "fade-in slide-in-from-top-1 animate-in flex w-full items-center gap-2.5 rounded-2xl px-3.5 py-2.5 duration-300 motion-reduce:animate-none",
        className,
      )}
      {...props}
    >
      {reconnecting ? (
        <>
          <Loader2Icon className="size-3.5 shrink-0 animate-spin text-foreground/40 motion-reduce:animate-none" />
          <span className="min-w-0 flex-1 text-[13px]">Reconnecting…</span>
        </>
      ) : (
        <>
          <CloudOffIcon className="size-3.5 shrink-0 text-amber-500" />
          <span className="min-w-0 flex-1 text-[13px]">Connection lost — the run keeps going on the host.</span>
          <button
            type="button"
            onClick={() => location.reload()}
            className="shrink-0 rounded-full px-2.5 py-1 text-xs font-medium text-foreground/70 transition-[background-color,color,scale] duration-150 hover:bg-foreground/[0.06] hover:text-foreground active:scale-[0.96]"
          >
            Reload
          </button>
        </>
      )}
      {error && !reconnecting && <span className={cn(mono, "shrink-0 truncate text-foreground/30")}>{error}</span>}
    </div>
  );
}
