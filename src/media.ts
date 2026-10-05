import { createHash } from "node:crypto";
import { LIMITS, type MediaKind } from "./contract.js";

export type Sniffed = { mime: string; kind: MediaKind };

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0) =>
  bytes.length >= offset + signature.length && signature.every((byte, index) => bytes[offset + index] === byte);
const ascii = (bytes: Uint8Array, text: string, offset = 0) =>
  startsWith(bytes, [...text].map((char) => char.charCodeAt(0)), offset);

/**
 * Identifies an allowed media type by its magic bytes, never by the file name.
 * SVG and every other type are rejected: the panel serves these bytes from the BB origin.
 */
export function sniffMedia(bytes: Uint8Array): Sniffed | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: "image/png", kind: "image" };
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { mime: "image/jpeg", kind: "image" };
  if (ascii(bytes, "RIFF") && ascii(bytes, "WEBP", 8)) return { mime: "image/webp", kind: "image" };
  if (ascii(bytes, "GIF87a") || ascii(bytes, "GIF89a")) return { mime: "image/gif", kind: "image" };
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return { mime: "video/webm", kind: "video" };
  // ISO base media also carries HEIC/AVIF stills and QuickTime; accept only MP4 major brands browsers play.
  if (ascii(bytes, "ftyp", 4) && bytes.length >= 12
    && /^(isom|iso[2-9]|mp4[12]|avc1|dash|M4V |mmp4)$/.test(String.fromCharCode(...bytes.subarray(8, 12)))) {
    return { mime: "video/mp4", kind: "video" };
  }
  return null;
}

export function maxBytesFor(kind: MediaKind): number {
  return kind === "image" ? LIMITS.imageBytes : LIMITS.videoBytes;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Validates one file for upload and returns its type and content hash. */
export function inspectUpload(bytes: Uint8Array, filename: string): Sniffed & { sha256: string } {
  const sniffed = sniffMedia(bytes);
  if (!sniffed) throw new Error(`${filename}: not an allowed type. Use PNG, JPEG, WebP, GIF, WebM or MP4.`);
  const limit = maxBytesFor(sniffed.kind);
  if (bytes.length > limit) throw new Error(`${filename}: ${formatBytes(bytes.length)} exceeds the ${formatBytes(limit)} limit for ${sniffed.kind}s.`);
  if (bytes.length === 0) throw new Error(`${filename}: file is empty.`);
  return { ...sniffed, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** Browser-rendered thumbnails and annotated copies: raster images only, small. */
export function inspectRaster(base64: string, maxBytes: number, label: string): { bytes: Buffer; mime: string } {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error(`${label}: invalid base64.`);
  const bytes = Buffer.from(base64, "base64");
  const sniffed = sniffMedia(bytes);
  if (!sniffed || sniffed.kind !== "image" || sniffed.mime === "image/gif") throw new Error(`${label}: expected PNG, JPEG or WebP.`);
  if (bytes.length > maxBytes) throw new Error(`${label}: ${formatBytes(bytes.length)} exceeds ${formatBytes(maxBytes)}.`);
  return { bytes, mime: sniffed.mime };
}

/** Parses a single-range `Range: bytes=…` header. Returns null for absent or unsupported ranges (serve the whole file). */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return null;
  let start: number;
  let end: number;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (suffix === 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}
