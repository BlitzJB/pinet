// Generate the PWA icons (crisp, self-contained, no image deps).
// Run: node web/scripts/generate-icons.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");
const BRAND = [77, 141, 246];
const WHITE = [255, 255, 255];

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

const inRoundRect = (px, py, w, h, r) => {
  const dx = Math.max(r - px, 0, px - (w - r));
  const dy = Math.max(r - py, 0, py - (h - r));
  return dx * dx + dy * dy <= r * r;
};
const inCircle = (px, py, cx, cy, r) => (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
function distToSegment(px, py, x0, y0, x1, y1) {
  const vx = x1 - x0;
  const vy = y1 - y0;
  const wx = px - x0;
  const wy = py - y0;
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy)));
  return Math.hypot(px - (x0 + t * vx), py - (y0 + t * vy));
}

function renderIcon(size) {
  const ss = 3; // supersample
  const s = size * ss;
  const buffer = Buffer.alloc(s * s * 4);

  const paint = (x, y, colour) => {
    const i = (y * s + x) * 4;
    buffer[i] = colour[0];
    buffer[i + 1] = colour[1];
    buffer[i + 2] = colour[2];
    buffer[i + 3] = 255;
  };

  const radius = s * 0.22;
  const lineThickness = s * 0.03;
  const nodeRadius = s * 0.095;
  const a = [s * 0.36, s * 0.36];
  const b = [s * 0.64, s * 0.64];

  for (let y = 0; y < s; y += 1) {
    for (let x = 0; x < s; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      if (!inRoundRect(px, py, s, s, radius)) continue;
      paint(x, y, BRAND);
      if (distToSegment(px, py, a[0], a[1], b[0], b[1]) <= lineThickness) paint(x, y, WHITE);
      if (inCircle(px, py, a[0], a[1], nodeRadius) || inCircle(px, py, b[0], b[1], nodeRadius)) paint(x, y, WHITE);
    }
  }

  // box downsample
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let bl = 0;
      let al = 0;
      for (let dy = 0; dy < ss; dy += 1) {
        for (let dx = 0; dx < ss; dx += 1) {
          const i = ((y * ss + dy) * s + (x * ss + dx)) * 4;
          r += buffer[i];
          g += buffer[i + 1];
          bl += buffer[i + 2];
          al += buffer[i + 3];
        }
      }
      const n = ss * ss;
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(bl / n);
      out[o + 3] = Math.round(al / n);
    }
  }
  return encodePng(size, size, out);
}

mkdirSync(OUT, { recursive: true });
for (const [name, size] of [
  ["icon-192.png", 192],
  ["icon-512.png", 512],
  ["apple-touch-icon.png", 180],
  ["favicon-32.png", 32],
]) {
  writeFileSync(resolve(OUT, name), renderIcon(size));
  console.log(`wrote ${name} (${size}x${size})`);
}
