/**
 * Attachments on the way out.
 *
 * Files are read here, chunked, and sent as base64 inside ordinary sealed commands —
 * the same envelope every other command uses, so the hub relays ciphertext and nothing
 * else. Chunks are sized well under the coordinator's frame cap, and the host decides
 * the type, the name and what metadata survives: none of that is settled here.
 */
import type { PiNetConnection } from "./pinet";

/** Raw bytes per chunk. Base64 inflates by a third, so this stays under the cap. */
const CHUNK_BYTES = 32 * 1024;

export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;

export interface AttachmentRef {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: "image" | "text";
  /** Local object URL, so the sender sees what they sent without a round trip. */
  preview?: string;
}

export interface PendingAttachment extends AttachmentRef {
  status: "uploading" | "ready" | "error";
  progress: number;
  error?: string;
}

/**
 * Object URLs for attachments this browser sent, so a message can show its own
 * picture without asking the host for bytes it already has. Cleared on unload.
 */
const previews = new Map<string, string>();

export function rememberPreview(id: string, file: File): string {
  const existing = previews.get(id);
  if (existing) return existing;
  const url = URL.createObjectURL(file);
  previews.set(id, url);
  return url;
}

export function previewFor(id: string): string | undefined {
  return previews.get(id);
}

/** What the composer should refuse before wasting a round trip. */
export function checkFile(file: File): string | undefined {
  if (file.size === 0) return `${file.name} is empty`;
  if (file.size > MAX_ATTACHMENT_BYTES) return `${file.name} is larger than 4 MB`;
  return undefined;
}

export function isImageFile(file: File): boolean {
  return /^image\//.test(file.type);
}

async function toBase64(file: File, start: number, end: number): Promise<string> {
  const slice = file.slice(start, end);
  const buffer = await slice.arrayBuffer();
  // Chunked conversion: a single spread over a large buffer overflows the stack.
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * Send one file, reporting progress as it goes. The host validates the bytes, strips
 * metadata and stores it under a name it chose; the id that comes back is the only
 * handle anyone gets.
 */
export async function uploadAttachment(
  connection: PiNetConnection,
  sessionId: string,
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<AttachmentRef> {
  const problem = checkFile(file);
  if (problem) throw new Error(problem);

  const ack = (await connection.attachBegin(sessionId, { name: file.name, mime: file.type, size: file.size })) as
    | { accepted?: boolean; error?: string; data?: { id?: string } }
    | undefined;
  const id = ack?.data?.id;
  if (!id) throw new Error(ack?.error ?? "could not start the upload");

  const chunks = Math.max(1, Math.ceil(file.size / CHUNK_BYTES));
  for (let index = 0; index < chunks; index += 1) {
    const start = index * CHUNK_BYTES;
    const data = await toBase64(file, start, Math.min(file.size, start + CHUNK_BYTES));
    const sent = (await connection.attachChunk(sessionId, { id, index, data })) as { accepted?: boolean; error?: string } | undefined;
    if (sent && sent.accepted === false) throw new Error(sent.error ?? "upload failed");
    onProgress?.((index + 1) / chunks);
  }

  const done = (await connection.attachEnd(sessionId, { id })) as
    | { accepted?: boolean; error?: string; data?: { attachment?: Omit<AttachmentRef, "preview"> } }
    | undefined;
  const attachment = done?.data?.attachment;
  if (!attachment) throw new Error(done?.error ?? "the upload was refused");

  return { ...attachment, preview: isImageFile(file) ? rememberPreview(id, file) : undefined };
}
