/**
 * Attachments: what a controller sends, and what the model receives.
 *
 * Three things are deliberate here.
 *
 * The bytes arrive as base64 inside ordinary signed commands rather than through a
 * new frame type. Commands are already sealed and AAD-bound to their session, epoch
 * and op, so the security properties come for free; the cost is a third more bytes
 * on the wire, which is why the client chunks well under the coordinator's frame cap.
 *
 * The file name is generated here, never supplied by the client. That is the exact
 * class of bug the adversarial review found in the voice spool — an unvalidated id
 * turning into an arbitrary path write — so an id is 24 hex characters and nothing
 * else, and every read re-checks it.
 *
 * Metadata is stripped before anything is written. A screenshot from a phone carries
 * the device, the timestamp and often the location, and none of that is the model's
 * business.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Per file. Images are the usual case and phone screenshots are a few hundred KB. */
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
/** Per message, counted by the caller. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;
/** Across one message. */
export const MAX_ATTACHMENT_TOTAL_BYTES = 16 * 1024 * 1024;
/** A non-image file is inlined into the prompt, so it has to stay modest. */
export const MAX_INLINE_TEXT_BYTES = 200 * 1024;
/** Guard against a client opening an unbounded number of uploads. */
export const MAX_PENDING = 8;

export const ATTACHMENT_ID_RE = /^[a-f0-9]{24}$/;

const IMAGE_EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp" };

const startsWith = (bytes, text) => {
  if (bytes.length < text.length) return false;
  for (let i = 0; i < text.length; i += 1) if (bytes[i] !== text.charCodeAt(i)) return false;
  return true;
};

const concat = (parts) => Buffer.concat(parts.map((part) => Buffer.from(part)));

/**
 * What the bytes actually are. The declared MIME type is a claim from a client; this
 * is not, which is why only a sniffed type is ever written to disk or handed on.
 */
export function sniffMime(bytes) {
  if (bytes.length < 12) return undefined;
  if (bytes[0] === 0x89 && startsWith(bytes.subarray(1), "PNG\r\n\x1a\n")) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (startsWith(bytes, "GIF87a") || startsWith(bytes, "GIF89a")) return "image/gif";
  if (startsWith(bytes, "RIFF") && startsWith(bytes.subarray(8), "WEBP")) return "image/webp";
  if (startsWith(bytes, "BM")) return "image/bmp";
  return undefined;
}

/** JPEG: walk the segments and drop the ones that carry metadata. */
function stripJpeg(bytes) {
  const out = [bytes.subarray(0, 2)];
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) break;
    const marker = bytes[i + 1];
    // Standalone markers have no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(bytes.subarray(i, i + 2));
      i += 2;
      continue;
    }
    // Start of scan: everything after this is image data.
    if (marker === 0xda) {
      out.push(bytes.subarray(i));
      return concat(out);
    }
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    const end = i + 2 + length;
    if (length < 2 || end > bytes.length) break;
    const body = bytes.subarray(i + 4, end);
    const metadata =
      (marker === 0xe1 && startsWith(body, "Exif\0\0")) || // EXIF, including GPS
      (marker === 0xe1 && startsWith(body, "http://ns.adobe.com/xap/")) || // XMP
      (marker === 0xed && startsWith(body, "Photoshop ")); // IPTC
    if (!metadata) out.push(bytes.subarray(i, end));
    i = end;
  }
  out.push(bytes.subarray(Math.min(i, bytes.length)));
  return concat(out);
}

/** PNG: drop the chunks that hold metadata. Each chunk carries its own CRC, so the
 *  survivors stay valid. */
function stripPng(bytes) {
  const drop = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME"]);
  const out = [bytes.subarray(0, 8)];
  let i = 8;
  while (i + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(i);
    const type = bytes.toString("latin1", i + 4, i + 8);
    const end = i + 12 + length;
    if (end > bytes.length) break;
    if (!drop.has(type)) out.push(bytes.subarray(i, end));
    i = end;
    if (type === "IEND") break;
  }
  if (i < bytes.length) out.push(bytes.subarray(i));
  return concat(out);
}

/** WebP: the metadata lives in RIFF chunks, and removing one means fixing the size. */
function stripWebp(bytes) {
  const drop = new Set(["EXIF", "XMP "]);
  const keep = [];
  let i = 12;
  while (i + 8 <= bytes.length) {
    const type = bytes.toString("latin1", i, i + 4);
    const size = bytes.readUInt32LE(i + 4);
    const end = i + 8 + size + (size % 2);
    if (end > bytes.length) break;
    if (!drop.has(type)) keep.push(bytes.subarray(i, end));
    i = end;
  }
  const body = concat(keep);
  const header = Buffer.from(bytes.subarray(0, 12));
  header.writeUInt32LE(body.length + 4, 4);
  return concat([header, body]);
}

/** Strip metadata from a recognised image. Unknown formats pass through untouched. */
export function stripMetadata(bytes, mime) {
  try {
    if (mime === "image/jpeg") return stripJpeg(bytes);
    if (mime === "image/png") return stripPng(bytes);
    if (mime === "image/webp") return stripWebp(bytes);
  } catch {
    /* a malformed file is not worth failing the send over */
  }
  return bytes;
}

/** Text-ish, judged by the absence of NUL bytes and a sane proportion of controls. */
export function looksLikeText(bytes) {
  const sample = bytes.subarray(0, 8_192);
  if (sample.length === 0) return false;
  let controls = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 9 || (byte > 13 && byte < 32)) controls += 1;
  }
  return controls / sample.length < 0.02;
}

/** A display name only: no path, no control characters, bounded. */
export function sanitizeFilename(name) {
  const base = String(name ?? "")
    .split(/[/\\]/)
    .pop()
    ?.replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  if (!base) return "file";
  return base.length > 100 ? base.slice(0, 100) : base;
}

/**
 * The parts handed to the model. Images keep their bytes; anything else is inlined as
 * text, because that is the only form a model can read a PDF-less, image-less file in.
 */
export function buildContentParts({ text, attachments = [] }) {
  const parts = [];
  if (text) parts.push({ type: "text", text });
  for (const attachment of attachments) {
    if (attachment.kind === "image") {
      parts.push({ type: "image", source: { type: "base64", media_type: attachment.mime, data: attachment.data } });
    } else {
      parts.push({ type: "text", text: `<attachment name="${attachment.name}">\n${attachment.text}\n</attachment>` });
    }
  }
  return parts;
}

/**
 * Uploads in flight, and the finished files. Pending state is in memory: an upload
 * that a restart interrupts is simply gone, which is the right outcome for something
 * the user can resend in a second.
 */
export function createAttachmentStore({ dir = join(homedir(), ".pinet", "attachments"), maxBytes = MAX_ATTACHMENT_BYTES } = {}) {
  const pending = new Map();

  function ensureDir() {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  return {
    /** Reserve an id for an upload the client is about to send. */
    begin({ name, mime, size } = {}) {
      if (pending.size >= MAX_PENDING) return { error: "too_many_pending" };
      const declared = Number(size);
      if (!Number.isFinite(declared) || declared <= 0) return { error: "bad_size" };
      if (declared > maxBytes) return { error: "too_large" };
      const id = randomBytes(12).toString("hex");
      pending.set(id, { name: sanitizeFilename(name), declared, chunks: [], received: 0 });
      return { id, maxBytes };
    },

    /** One slice of the file. Out-of-order and repeated indices are tolerated. */
    chunk({ id, index, data } = {}) {
      const entry = pending.get(String(id ?? ""));
      if (!entry) return { error: "unknown_attachment" };
      if (typeof data !== "string" || data.length === 0) return { error: "empty_chunk" };
      const bytes = Buffer.from(data, "base64");
      const slot = Number(index);
      if (!Number.isInteger(slot) || slot < 0 || slot > 10_000) return { error: "bad_index" };
      const previous = entry.chunks[slot];
      entry.received += bytes.length - (previous?.length ?? 0);
      if (entry.received > maxBytes) {
        pending.delete(String(id));
        return { error: "too_large" };
      }
      entry.chunks[slot] = bytes;
      return { ok: true, received: entry.received };
    },

    /** Validate, clean and keep. The type written is the sniffed one, never the claim. */
    end({ id } = {}) {
      const key = String(id ?? "");
      const entry = pending.get(key);
      if (!entry) return { error: "unknown_attachment" };
      pending.delete(key);
      const bytes = Buffer.concat(entry.chunks.filter(Boolean));
      if (bytes.length === 0) return { error: "empty_attachment" };
      const sniffed = sniffMime(bytes);
      const isImage = Boolean(sniffed);
      if (!isImage && !looksLikeText(bytes)) return { error: "unsupported_type" };
      if (!isImage && bytes.length > MAX_INLINE_TEXT_BYTES) return { error: "text_too_large" };
      const cleaned = isImage ? stripMetadata(bytes, sniffed) : bytes;
      const extension = isImage ? IMAGE_EXTENSIONS[sniffed] : "txt";
      ensureDir();
      writeFileSync(join(dir, `${key}.${extension}`), cleaned, { mode: 0o600 });
      const record = {
        id: key,
        name: entry.name,
        mime: sniffed ?? "text/plain",
        size: cleaned.length,
        originalSize: bytes.length,
        kind: isImage ? "image" : "text",
        at: Date.now(),
      };
      writeFileSync(join(dir, `${key}.json`), JSON.stringify(record), { mode: 0o600 });
      return record;
    },

    /** Read one back, for a controller that did not send it. */
    read(id) {
      const key = String(id ?? "");
      if (!ATTACHMENT_ID_RE.test(key)) return undefined;
      try {
        const record = JSON.parse(readFileSync(join(dir, `${key}.json`), "utf8"));
        const extension = record.kind === "image" ? IMAGE_EXTENSIONS[record.mime] : "txt";
        const bytes = readFileSync(join(dir, `${key}.${extension}`));
        return { ...record, bytes, data: bytes.toString("base64") };
      } catch {
        return undefined;
      }
    },

    /** Everything kept for this machine, newest first. */
    list() {
      try {
        return readdirSync(dir)
          .filter((file) => file.endsWith(".json"))
          .map((file) => {
            try {
              const record = JSON.parse(readFileSync(join(dir, file), "utf8"));
              return { id: record.id, name: record.name, mime: record.mime, size: record.size, kind: record.kind, at: record.at };
            } catch {
              return undefined;
            }
          })
          .filter(Boolean)
          .sort((a, b) => b.at - a.at)
          .slice(0, 200);
      } catch {
        return [];
      }
    },
  };
}
