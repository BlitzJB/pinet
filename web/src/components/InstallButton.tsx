import { useState } from "react";
import { DownloadIcon, ShareIcon, XIcon } from "lucide-react";
import { cn } from "../lib/utils";
import { isIosSafari, isStandalone, useInstallPrompt } from "../lib/pwa";
import { ghostButton } from "./ui/surfaces";

export function InstallButton({ className }: { className?: string }) {
  const { canInstall, promptInstall } = useInstallPrompt();
  const [hint, setHint] = useState(false);
  const ios = isIosSafari() && !isStandalone();

  if (!canInstall && !ios) return null;

  return (
    <div className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => {
          if (canInstall) void promptInstall();
          else setHint((value) => !value);
        }}
        className={cn(ghostButton, "h-auto gap-1.5 rounded-lg px-2.5 py-1.5 text-xs")}
      >
        {ios ? <ShareIcon className="size-3.5" /> : <DownloadIcon className="size-3.5" />}
        Install app
      </button>
      {hint && (
        <div className="absolute end-0 bottom-full z-30 mb-2 w-56 rounded-xl border border-border/60 bg-popover p-3 text-[12px] leading-relaxed text-muted-foreground shadow-xl">
          <button type="button" aria-label="Dismiss" onClick={() => setHint(false)} className="float-end ms-1 text-foreground/40">
            <XIcon className="size-3.5" />
          </button>
          Tap <ShareIcon className="mx-0.5 inline size-3" /> <b>Share</b>, then <b>Add to Home Screen</b>.
        </div>
      )}
    </div>
  );
}
