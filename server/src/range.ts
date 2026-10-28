// HTTP byte-range helpers shared by the file streamer and the proxies.
//
// Only single ranges are handled (`bytes=S-E`, `bytes=S-`, `bytes=-N`);
// multipart ranges and malformed headers fall back to a full 200 response,
// which is what RFC 9110 permits a server to do with any Range it cannot or
// chooses not to satisfy.

import { Transform, type TransformCallback } from 'stream';

export interface ByteRange { start: number; end: number }

export type ParsedRange = ByteRange | 'unsatisfiable' | null;

/**
 * Resolve a Range header against a known total size. Returns the inclusive
 * byte span, 'unsatisfiable' (answer 416), or null (ignore the header).
 */
export function parseByteRange(header: string | string[] | undefined, size: number): ParsedRange {
  if (typeof header !== 'string' || !Number.isFinite(size) || size < 0) return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m) return null; // multipart or malformed → serve the whole thing
  const [, startStr, endStr] = m;
  if (!startStr && !endStr) return null;

  if (!startStr) {
    // Suffix range: the last N bytes.
    const n = parseInt(endStr, 10);
    if (n === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }

  const start = parseInt(startStr, 10);
  if (start >= size) return 'unsatisfiable';
  const end = endStr ? Math.min(parseInt(endStr, 10), size - 1) : size - 1;
  if (end < start) return null;
  return { start, end };
}

export function contentRange(r: ByteRange, size: number): string {
  return `bytes ${r.start}-${r.end}/${size}`;
}

/**
 * Passes through only bytes [start, end] of its input, then ends. Emits
 * 'sliced' once the span is complete so the caller can stop the upstream
 * download instead of draining the rest of a large file.
 */
export class ByteSlice extends Transform {
  private offset = 0;
  private done = false;

  constructor(private readonly from: number, private readonly to: number) {
    super();
  }

  _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
    if (this.done) return cb();
    const chunkStart = this.offset;
    const chunkEnd = this.offset + chunk.length - 1;
    this.offset += chunk.length;
    if (chunkEnd < this.from) return cb();
    const lo = Math.max(0, this.from - chunkStart);
    const hi = Math.min(chunk.length, this.to - chunkStart + 1);
    if (hi > lo) this.push(chunk.subarray(lo, hi));
    if (chunkEnd >= this.to) {
      this.done = true;
      this.push(null);
      this.emit('sliced');
    }
    cb();
  }
}

/**
 * Strong-compare a client's If-Range validator with the upstream's current
 * ETag / Last-Modified. True when the client's copy is still current (or no
 * If-Range was sent), so a partial response is safe to synthesize.
 */
export function ifRangeMatches(ifRange: string | undefined, etag: string | undefined, lastModified: string | undefined): boolean {
  if (!ifRange) return true;
  const v = ifRange.trim();
  if (v.startsWith('"') || v.startsWith('W/')) {
    return !!etag && !v.startsWith('W/') && !etag.startsWith('W/') && v === etag.trim();
  }
  return !!lastModified && Date.parse(v) === Date.parse(lastModified);
}
