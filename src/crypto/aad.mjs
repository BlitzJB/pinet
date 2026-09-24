// AAD builders shared by the host and generic clients. Portable (no runtime deps).

import { aadFrom } from "../common/canonical.mjs";

export function frameAad({ sessionId, epoch, seq, type }) {
  return aadFrom({ sessionId, epoch, seq, type });
}

export function commandAad({ sessionId, commandId, epoch, op, deviceId }) {
  return aadFrom({ sessionId, commandId, epoch, op, deviceId });
}
