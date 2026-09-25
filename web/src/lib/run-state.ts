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
  /** True when `label` is a generic placeholder and the UI should rotate phrases. */
  generic?: boolean;
  error?: string;
}

/**
 * Derive the status line shown at the bottom of the transcript.
 *
 * `sending`/`delivered`/`queued` come from the local send + host ack; `working`
 * from the host's run lifecycle. While a run is in flight the indicator stays up
 * for the whole turn (with a generic label the UI rotates through) so it doesn't
 * vanish the instant the first block of the reply arrives.
 */
export function deriveRunFeedback({
  outbox,
  running,
  compacting = false,
}: {
  outbox?: Outbox | null;
  running: boolean;
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

  // `running` is the host's own run lifecycle, so it is authoritative: the
  // indicator stays up for the whole turn and clears when the host goes idle.
  if (running) return { label: "Working…", active: true, generic: true };
  return null;
}
