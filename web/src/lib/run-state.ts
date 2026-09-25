export type OutboxStatus = "sending" | "delivered" | "queued" | "working" | "error";

export interface Outbox {
  status: OutboxStatus;
  /** Admission mode reported by the host: immediate | steer | followUp. */
  mode?: string;
  /** When the prompt was sent (ms). */
  at: number;
  error?: string;
  /** True once a host run started after this prompt. */
  sawRun?: boolean;
  /** Transcript length at send time, to detect the first incoming block. */
  entriesAt?: number;
}

export interface RunFeedback {
  label: string;
  active: boolean;
  error?: string;
}

/**
 * Derive the waiting/status indicator shown until the first block arrives.
 * `sending`/`delivered`/`queued` come from the local send + host ack;
 * `working` comes from the host's run lifecycle.
 */
export function deriveRunFeedback({
  outbox,
  running,
  runningTools = 0,
  entryCount = 0,
  compacting = false,
}: {
  outbox?: Outbox | null;
  running: boolean;
  runningTools?: number;
  entryCount?: number;
  compacting?: boolean;
}): RunFeedback | null {
  if (compacting) return { label: "Compacting context…", active: true };
  if (outbox?.status === "error") return { label: "Couldn't send", active: false, error: outbox.error ?? "error" };
  if (outbox && (outbox.status === "sending" || outbox.status === "delivered" || outbox.status === "queued")) {
    const label =
      outbox.status === "sending"
        ? "Sending…"
        : outbox.status === "delivered"
          ? "Delivered"
          : `Queued${outbox.mode ? ` · ${outbox.mode}` : ""}`;
    return { label, active: false };
  }

  const hasContent = outbox ? entryCount > (outbox.entriesAt ?? 0) : false;
  if ((outbox?.status === "working" || running) && runningTools === 0 && !hasContent) {
    return { label: "Working…", active: true };
  }
  return null;
}
