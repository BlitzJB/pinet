import { useEffect, useState } from "react";
import { CheckIcon } from "lucide-react";
import type { RunFeedback } from "../../lib/run-state";
import { ShimmerLabel } from "../ui/surfaces";
import { DotMatrix } from "./DotMatrix";

/** Rotated while the model works, in the spirit of Claude Code's status line. */
const PHRASES = [
  "Thinking…",
  "Pondering…",
  "Deliberating…",
  "Mulling it over…",
  "Noodling…",
  "Percolating…",
  "Cogitating…",
  "Ruminating…",
  "Tinkering…",
  "Scheming…",
  "Brewing…",
  "Hatching a plan…",
];

const PHRASE_MS = 2800;

function useRotatingPhrase(active: boolean): string {
  const [index, setIndex] = useState(() => Math.floor(Math.random() * PHRASES.length));
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setIndex((value) => (value + 1) % PHRASES.length), PHRASE_MS);
    return () => clearInterval(timer);
  }, [active]);
  return PHRASES[index];
}

export function RunIndicator({ feedback }: { feedback: RunFeedback | null }) {
  const rotating = Boolean(feedback?.generic && feedback.active);
  const phrase = useRotatingPhrase(rotating);

  if (!feedback) return null;
  if (feedback.error) {
    return (
      <div className="flex items-center gap-2 text-[13px] text-destructive" role="status">
        Couldn&apos;t send: {feedback.error}
      </div>
    );
  }

  const label = feedback.generic ? phrase : feedback.label;

  return (
    <div className="flex items-center gap-2 text-[13px] text-muted-foreground" role="status" aria-live="polite">
      {feedback.active ? <DotMatrix /> : <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />}
      <span key={label} className="fade-in animate-in duration-300 motion-reduce:animate-none">
        <ShimmerLabel active={feedback.active}>{label}</ShimmerLabel>
      </span>
    </div>
  );
}
