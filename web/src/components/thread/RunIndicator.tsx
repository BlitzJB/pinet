import { CheckIcon, LoaderIcon } from "lucide-react";
import type { RunFeedback } from "../../lib/run-state";
import { ShimmerLabel } from "../ui/surfaces";

export function RunIndicator({ feedback }: { feedback: RunFeedback | null }) {
  if (!feedback) return null;
  if (feedback.error) {
    return (
      <div className="flex items-center gap-2 text-[13px] text-destructive" role="status">
        Couldn&apos;t send: {feedback.error}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 text-[13px] text-muted-foreground" role="status" aria-live="polite">
      {feedback.active ? (
        <LoaderIcon className="size-3.5 shrink-0 animate-spin text-blue-500 motion-reduce:animate-none" />
      ) : (
        <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />
      )}
      <ShimmerLabel active={feedback.active}>{feedback.label}</ShimmerLabel>
    </div>
  );
}
