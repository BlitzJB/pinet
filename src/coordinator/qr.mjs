// Browser-side QR rendering for otpauth links. Zero-dependency, returns an
// inline SVG string so the page makes no external requests.

import qrcode from "qrcode-generator";

export function qrSvg(text, { cellSize = 4, margin = 2 } = {}) {
  try {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize, margin });
  } catch {
    return "";
  }
}
