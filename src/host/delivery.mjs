// How a command is delivered to pi. Immediate delivery is the default: when
// pi is running, a remote prompt is injected as a steering message on receipt,
// exactly like a local user steering the active turn.

export const DELIVERY_IMMEDIATE = "immediate";
export const DELIVERY_STEER = "steer";
export const DELIVERY_FOLLOW_UP = "followUp";

export function resolveDelivery({ isIdle, requested } = {}) {
  if (isIdle) return { deliverAs: null, mode: DELIVERY_IMMEDIATE };
  if (requested === DELIVERY_FOLLOW_UP) return { deliverAs: DELIVERY_FOLLOW_UP, mode: DELIVERY_FOLLOW_UP };
  return { deliverAs: DELIVERY_STEER, mode: DELIVERY_STEER };
}
