// Tracks the last sequence number seen per session/epoch so the controller can
// detect gaps (a lost durable frame) and trigger a resync.

export function createSeqTracker() {
  const state = new Map(); // sessionId -> { epoch, seq }

  return {
    observe(sessionId, epoch, seq) {
      const prev = state.get(sessionId);
      if (typeof seq !== "number") return { gap: false, reset: false };
      if (!prev || prev.epoch !== epoch) {
        state.set(sessionId, { epoch, seq });
        return { gap: false, reset: true };
      }
      const gap = seq > prev.seq + 1;
      state.set(sessionId, { epoch, seq });
      return { gap, reset: false };
    },
    reset(sessionId) {
      state.delete(sessionId);
    },
  };
}
