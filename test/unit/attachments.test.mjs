import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildContentParts,
  createAttachmentStore,
  looksLikeText,
  sanitizeFilename,
  sniffMime,
  stripMetadata,
  ATTACHMENT_ID_RE,
} from "../../src/host/attachments.mjs";

/** A minimal but structurally valid PNG, with a text chunk that must not survive. */
function png({ text } = {}) {
  const chunk = (type, body) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, "latin1");
    return Buffer.concat([head, body, Buffer.alloc(4)]); // CRC unused by the stripper
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", Buffer.alloc(13)),
    ...(text ? [chunk("tEXt", Buffer.from(text, "latin1"))] : []),
    chunk("IDAT", Buffer.from([1, 2, 3])),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A JPEG with an APP1 EXIF segment, which is where GPS lives. */
function jpegWithExif() {
  const segment = (marker, body) => {
    const head = Buffer.alloc(4);
    head[0] = 0xff;
    head[1] = marker;
    head.writeUInt16BE(body.length + 2, 2);
    return Buffer.concat([head, body]);
  };
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, Buffer.from("JFIF\0", "latin1")),
    segment(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), Buffer.from("GPS 51.5,-0.1", "latin1")])),
    segment(0xdb, Buffer.from([0, 1, 2])),
    Buffer.from([0xff, 0xda, 0x00, 0x02, 9, 9, 9]),
  ]);
}

describe("attachments: what the bytes are", () => {
  it("sniffs the type rather than trusting a claim", () => {
    expect(sniffMime(png())).toBe("image/png");
    expect(sniffMime(jpegWithExif())).toBe("image/jpeg");
    expect(sniffMime(Buffer.from("GIF89a...................."))).toBe("image/gif");
    expect(sniffMime(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]))).toBe("image/webp");
    expect(sniffMime(Buffer.from("hello world, definitely not an image"))).toBeUndefined();
  });

  it("recognises text without being fooled by binary", () => {
    expect(looksLikeText(Buffer.from("a log file\nwith lines\n"))).toBe(true);
    expect(looksLikeText(Buffer.from([0x00, 0x01, 0x02, 0x03]))).toBe(false);
    expect(looksLikeText(Buffer.alloc(0))).toBe(false);
  });

  it("takes only a name from a client, never a path", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("C:\\Windows\\system32\\config")).toBe("config");
    expect(sanitizeFilename("bad\u0000name\u001b.txt")).toBe("badname.txt");
    expect(sanitizeFilename("")).toBe("file");
    expect(sanitizeFilename("x".repeat(300))).toHaveLength(100);
  });
});

describe("attachments: stripping metadata", () => {
  it("removes the EXIF segment from a JPEG and keeps the image", () => {
    const before = jpegWithExif();
    const after = stripMetadata(before, "image/jpeg");
    expect(after.toString("latin1")).not.toContain("GPS 51.5");
    expect(after.toString("latin1")).not.toContain("Exif");
    // Still a JPEG, with its other segments and its scan data intact.
    expect(after[0]).toBe(0xff);
    expect(after[1]).toBe(0xd8);
    expect(after.toString("latin1")).toContain("JFIF");
    expect(after.length).toBeLessThan(before.length);
  });

  it("removes text chunks from a PNG and keeps the chunks that matter", () => {
    const before = png({ text: "Author: someone" });
    const after = stripMetadata(before, "image/png");
    expect(after.toString("latin1")).not.toContain("Author: someone");
    expect(after.toString("latin1")).toContain("IHDR");
    expect(after.toString("latin1")).toContain("IDAT");
    expect(after.toString("latin1")).toContain("IEND");
  });

  it("leaves a malformed file alone rather than throwing", () => {
    const junk = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xff]);
    expect(() => stripMetadata(junk, "image/png")).not.toThrow();
  });
});

describe("attachments: the store", () => {
  const withStore = (run) => {
    const dir = mkdtempSync(join(tmpdir(), "pinet-attach-"));
    try {
      return run(createAttachmentStore({ dir }), dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("takes an upload in pieces and keeps it", () => {
    withStore((store) => {
      const bytes = png({ text: "secret metadata" });
      const { id } = store.begin({ name: "shot.png", mime: "image/png", size: bytes.length });
      expect(id).toMatch(ATTACHMENT_ID_RE);
      store.chunk({ id, index: 0, data: bytes.subarray(0, 20).toString("base64") });
      store.chunk({ id, index: 1, data: bytes.subarray(20).toString("base64") });
      const record = store.end({ id });
      expect(record).toMatchObject({ kind: "image", mime: "image/png", name: "shot.png" });
      // Metadata is gone by the time it is on disk.
      const read = store.read(id);
      expect(read.bytes.toString("latin1")).not.toContain("secret metadata");
      expect(read.data).toBe(read.bytes.toString("base64"));
      expect(store.list().map((item) => item.id)).toContain(id);
    });
  });

  it("keeps a text file as text, and refuses what it cannot read", () => {
    withStore((store) => {
      const text = Buffer.from("a log\nwith two lines\n");
      const first = store.begin({ name: "run.log", mime: "text/plain", size: text.length });
      store.chunk({ id: first.id, index: 0, data: text.toString("base64") });
      expect(store.end({ id: first.id })).toMatchObject({ kind: "text", mime: "text/plain" });

      const binary = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]);
      const second = store.begin({ name: "blob.bin", mime: "application/octet-stream", size: binary.length });
      store.chunk({ id: second.id, index: 0, data: binary.toString("base64") });
      expect(store.end({ id: second.id }).error).toBe("unsupported_type");
    });
  });

  it("refuses a declared size over the cap, and one that grows past it", () => {
    withStore((store) => {
      expect(store.begin({ name: "big.png", size: 99 * 1024 * 1024 }).error).toBe("too_large");
      const { id } = store.begin({ name: "ok.png", size: 10 });
      const chunk = Buffer.alloc(1024).toString("base64");
      let firstError;
      for (let i = 0; i < 6_000 && !firstError; i += 1) firstError = store.chunk({ id, index: i, data: chunk }).error;
      expect(firstError).toBe("too_large");
      // A refused upload is dropped, not left half-written.
      expect(store.end({ id }).error).toBe("unknown_attachment");
    });
  });

  it("will not read by an id that is not one", () => {
    withStore((store) => {
      // The voice spool's traversal bug in one line: an id must be an id.
      expect(store.read("../../etc/passwd")).toBeUndefined();
      expect(store.read("/etc/passwd")).toBeUndefined();
      expect(store.read("nope")).toBeUndefined();
      expect(store.read(undefined)).toBeUndefined();
      expect(store.chunk({ id: "../escape", index: 0, data: "aGk=" }).error).toBe("unknown_attachment");
      expect(store.end({ id: "../escape" }).error).toBe("unknown_attachment");
    });
  });
});

describe("attachments: what the model receives", () => {
  it("sends an image as image content and anything else as text", () => {
    const parts = buildContentParts({
      text: "what is wrong here?",
      attachments: [
        { kind: "image", mime: "image/png", name: "shot.png", data: "AAAA" },
        { kind: "text", mime: "text/plain", name: "run.log", text: "boom" },
      ],
    });
    expect(parts[0]).toEqual({ type: "text", text: "what is wrong here?" });
    expect(parts[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } });
    expect(parts[2].text).toContain('name="run.log"');
    expect(parts[2].text).toContain("boom");
  });

  it("handles a message that is only an image", () => {
    const parts = buildContentParts({ text: "", attachments: [{ kind: "image", mime: "image/jpeg", name: "a.jpg", data: "BBBB" }] });
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe("image");
  });
});
