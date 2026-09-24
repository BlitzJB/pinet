import { useConnectionState } from "../lib/context";

const LABELS: Record<string, { text: string; dot: string; label: string }> = {
  idle: { text: "text-mist-400", dot: "bg-mist-400", label: "idle" },
  connecting: { text: "text-warn-400", dot: "bg-warn-400 animate-pulse", label: "connecting" },
  connected: { text: "text-ok-400", dot: "bg-ok-400", label: "connected" },
  reconnecting: { text: "text-warn-400", dot: "bg-warn-400 animate-pulse", label: "reconnecting" },
  error: { text: "text-bad-400", dot: "bg-bad-400", label: "error" },
};

export function ConnectionBadge() {
  const state = useConnectionState();
  const style = LABELS[state.status] ?? LABELS.idle;
  return (
    <span className={`inline-flex items-center gap-2 text-xs font-medium ${style.text}`} title={state.error ?? undefined}>
      <span className={`h-2 w-2 rounded-full ${style.dot}`} />
      {style.label}
    </span>
  );
}
