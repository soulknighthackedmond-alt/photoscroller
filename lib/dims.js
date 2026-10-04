'use strict';

/* Photo dimensions, read from the file header.

   The masonry grid needs every photo's aspect ratio *before* the image loads: without
   it a column is a guess until the bytes arrive, the grid reflows as pictures land, and
   the page jumps under your thumb. The ratio cannot be guessed and is not worth a
   download — the header of every format this app accepts carries the width and height,
   so a few hundred bytes of the file answer it.

   Read in two steps: 4 KB covers the common case (JPEG SOF, PNG IHDR, GIF, BMP, WebP),
   and only a file that did not answer there is read again, up to 128 KB — which is what
   a JPEG with a large embedded EXIF thumbnail needs. */

const fsp = require('fs/promises');

const FIRST_BYTES = 4 * 1024;
const HEAD_BYTES = 128 * 1024;
/* An index box bigger than this is not worth reading into memory: a normal moov is
   kilobytes, a long recording's runs to a few megabytes, and past that something is
   wrong with the file rather than large. */
const MOOV_MAX = 24 * 1024 * 1024;
const CACHE_MAX = 5000;

/* "album/name|mtime|size" -> {w,h} | null. Keyed on mtime and size as well as the
   name, so a file replaced by an upload of the same name is re-read rather than
   reported with the old photo's shape. */
const cache = new Map();

/* ------------------------------------------------------------------ *
 * header decoders — each takes the start of the file, returns {w,h} or null
 * ------------------------------------------------------------------ */

function jpeg(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1];
    /* padding, and the markers that carry no length field */
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    /* start of scan: the frame header would have come before it */
    if (marker === 0xd9 || marker === 0xda) return null;
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return null;
    /* SOF0-15 except the four that are not frame headers (DHT, JPG, DAC) */
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

function png(buf) {
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function gif(buf) {
  return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
}

function bmp(buf) {
  return { w: Math.abs(buf.readInt32LE(18)), h: Math.abs(buf.readInt32LE(22)) };
}

function webp(buf) {
  const fourcc = buf.toString('ascii', 12, 16);
  if (fourcc === 'VP8X') {
    /* extended: 24-bit canvas size, minus one */
    return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
  }
  if (fourcc === 'VP8 ') {
    /* lossy: 3-byte frame tag, 3-byte sync code, then 14-bit width and height */
    return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
  }
  if (fourcc === 'VP8L') {
    /* lossless: one signature byte, then 14 bits of width-1 and 14 of height-1 */
    const bits = buf.readUInt32LE(21);
    return { w: 1 + (bits & 0x3fff), h: 1 + ((bits >> 14) & 0x3fff) };
  }
  return null;
}

/* Dispatch on the magic bytes rather than trying each decoder in turn: a JPEG scan
   over a PNG's bytes would be wasted work and could find a false 0xFF. */
function decode(buf) {
  if (!buf || buf.length < 26) return null;
  let out = null;
  if (buf[0] === 0xff && buf[1] === 0xd8) out = jpeg(buf);
  else if (buf.readUInt32BE(0) === 0x89504e47) out = png(buf);
  else if (buf.toString('ascii', 0, 3) === 'GIF') out = gif(buf);
  else if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') out = webp(buf);
  else if (buf[0] === 0x42 && buf[1] === 0x4d) out = bmp(buf);
  /* a plausible-looking header that decodes to nonsense is treated as unknown: the
     viewer falls back to a placeholder ratio and corrects itself when the photo loads */
  if (!out || !(out.w > 0) || !(out.h > 0) || out.w > 100000 || out.h > 100000) return null;
  return out;
}

async function readHead(file, bytes) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/* Returns {w,h} or null — never throws: a photo the app cannot measure is a photo
   that falls back to a default shape, not a request that fails. */
async function dims(file, key) {
  if (cache.has(key)) return cache.get(key);
  let out = null;
  try {
    const head = await readHead(file, FIRST_BYTES);
    out = decode(head);
    if (!out && head.length === FIRST_BYTES) out = decode(await readHead(file, HEAD_BYTES));
  } catch {
    out = null;
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, out);
  return out;
}

/* ------------------------------------------------------------------ *
 * video dimensions — the same idea, in two different containers
 * ------------------------------------------------------------------ */

const TAIL_BYTES = 1024 * 1024;

/* MP4 / MOV / M4V is a tree of boxes. The picture size is the last eight bytes of
   moov -> trak -> tkhd, as 16.16 fixed point; an audio track carries 0 there, so the
   largest track wins. A recording that was never "faststart"-ed keeps moov at the
   END of the file, which is why the tail is read as well as the head. */
function boxes(buf, start, end) {
  const out = [];
  let i = start;
  while (i + 8 <= end) {
    let size = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    let head = 8;
    if (size === 1) {
      if (i + 16 > end) break;
      const big = buf.readBigUInt64BE(i + 8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) break;
      size = Number(big);
      head = 16;
    } else if (size === 0) {
      size = end - i;
    }
    if (size < head || i + size > end) break;
    out.push({ type: type, start: i + head, end: i + size });
    i += size;
  }
  return out;
}

function moovByFourcc(buf) {
  const at = buf.indexOf('moov', 0, 'latin1');
  if (at < 4) return null;
  const size = buf.readUInt32BE(at - 4);
  const start = at - 4;
  if (size < 8 || start + size > buf.length) return null;
  return { type: 'moov', start: start + 8, end: start + size };
}

function mp4(buf, fromStart) {
  let moov = null;
  if (fromStart) {
    for (const b of boxes(buf, 0, buf.length)) if (b.type === 'moov') moov = b;
  }
  if (!moov) moov = moovByFourcc(buf);
  if (!moov) return null;
  let best = null;
  for (const trak of boxes(buf, moov.start, moov.end)) {
    if (trak.type !== 'trak') continue;
    let tkhd = null;
    for (const b of boxes(buf, trak.start, trak.end)) if (b.type === 'tkhd') tkhd = b;
    if (!tkhd) continue;
    /* version 1 has 64-bit timestamps, so the fields shift by 12 bytes */
    const off = tkhd.start + (buf[tkhd.start] === 1 ? 88 : 76);
    if (off + 8 > tkhd.end) continue;
    const w = buf.readUInt32BE(off) / 65536;
    const h = buf.readUInt32BE(off + 4) / 65536;
    if (w > 0 && h > 0 && (!best || w * h > best.w * best.h)) best = { w: w, h: h };
  }
  if (!best) return null;
  /* The running time is in moov -> mvhd: a timescale and a duration counted in it.
     Version 1 widens both timestamps to 64 bits, which shifts every field after them. */
  for (const b of boxes(buf, moov.start, moov.end)) {
    if (b.type !== 'mvhd') continue;
    const v1 = buf[b.start] === 1;
    const at = b.start + (v1 ? 20 : 12);
    if (at + (v1 ? 12 : 8) > b.end) break;
    const timescale = buf.readUInt32BE(at);
    const units = v1 ? Number(buf.readBigUInt64BE(at + 4)) : buf.readUInt32BE(at + 4);
    if (!timescale) break;
    /* 0xffffffff is the "unknown" a fragmented recording writes there */
    const seconds = units / timescale;
    if (Number.isFinite(seconds) && seconds > 0 && units !== 0xffffffff) {
      best.duration = Math.round(seconds * 10) / 10;
    }
    break;
  }
  return best;
}

/* WebM / Matroska is EBML: every element is an ID and a size, each a variable-length
   integer whose first byte says how many bytes it takes. Only the elements on the
   path to the picture size are descended into, and a size of "all ones" (a live
   stream) is read as "to the end of what we have". */
function vint(buf, i) {
  if (i >= buf.length) return null;
  const first = buf[i];
  if (!first) return null;
  let len = 1, mask = 0x80;
  while (len <= 8 && !(first & mask)) { mask >>= 1; len += 1; }
  if (len > 8 || i + len > buf.length) return null;
  let value = first & (mask - 1);
  let unknown = (first & (mask - 1)) === mask - 1;
  /* The bytes as they stand, marker bit and all. An element ID is compared against its
     canonical form (0x1a45dfa3, not the stripped 0x0a45dfa3); a size is the value with
     the marker bit taken off. Getting these two the same way is the classic EBML bug. */
  let raw = first;
  for (let k = 1; k < len; k += 1) {
    value = value * 256 + buf[i + k];
    raw = raw * 256 + buf[i + k];
    if (buf[i + k] !== 0xff) unknown = false;
  }
  return { value: value, raw: raw, len: len, unknown: unknown };
}

/* EBML, Segment, Tracks, TrackEntry, Video — plus Info, which is where a WebM keeps
   its duration. Nothing else is descended into. */
const EBML_MASTER = new Set([0x1a45dfa3, 0x18538067, 0x1654ae6b, 0xae, 0xe0, 0x1549a966]);

function ebml(buf, start, end, depth) {
  const out = {};
  let i = start;
  while (i + 2 <= end && depth < 8) {
    const id = vint(buf, i);
    if (!id || id.len > 4) break;
    const size = vint(buf, i + id.len);
    if (!size) break;
    const from = i + id.len + size.len;
    const to = size.unknown ? end : Math.min(end, from + size.value);
    if (to < from || to <= i) break;
    if (id.raw === 0xb0 || id.raw === 0xba) {
      const n = Math.min(to, from + 8) - from;
      let v = 0;
      for (let k = 0; k < n; k += 1) v = v * 256 + buf[from + k];
      if (id.raw === 0xb0) out.w = v; else out.h = v;
    } else if (id.raw === 0x4489) {
      /* Duration is the one element on this path that is a float, not an integer */
      const n = to - from;
      if (n === 4) out.dur = buf.readFloatBE(from);
      else if (n === 8) out.dur = buf.readDoubleBE(from);
    } else if (id.raw === 0x2ad7b1) {
      /* TimestampScale: nanoseconds per tick, 1000000 unless a muxer said otherwise */
      const n = Math.min(to, from + 8) - from;
      let v = 0;
      for (let k = 0; k < n; k += 1) v = v * 256 + buf[from + k];
      if (v > 0) out.scale = v;
    } else if (EBML_MASTER.has(id.raw)) {
      const sub = ebml(buf, from, to, depth + 1);
      if (sub.w) out.w = sub.w;
      if (sub.h) out.h = sub.h;
      if (sub.dur) out.dur = sub.dur;
      if (sub.scale) out.scale = sub.scale;
    }
    i = to;
  }
  return out;
}

/* Returns {w,h} or null. A container the reader cannot make sense of is not an
   error: the tile falls back to 16:9 and corrects itself when the video loads. */
function decodeVideo(buf, fromStart) {
  if (!buf || buf.length < 32) return null;
  const iso = buf.toString('latin1', 4, 8) === 'ftyp';
  let out = null;
  if (iso) out = mp4(buf, fromStart);
  else if (fromStart && buf.readUInt32BE(0) === 0x1a45dfa3) out = webm(buf);
  /* a tail read has no signature to go on, so the moov fourcc is the only thing left */
  else if (!fromStart) out = mp4(buf, false);
  if (!out || !(out.w > 0) || !(out.h > 0) || out.w > 20000 || out.h > 20000) return null;
  const shape = { w: Math.round(out.w), h: Math.round(out.h) };
  /* The length is a bonus, not a requirement: a file whose duration cannot be read
     still gets its shape, and the tile simply carries no time badge. */
  if (out.duration > 0 && out.duration < 86400) shape.duration = Math.round(out.duration * 10) / 10;
  return shape;
}

/* Returns {w,h,duration} or null. A WebM duration is counted in ticks of the segment's
   TimestampScale, which is nanoseconds and defaults to one millisecond. */
function webm(buf) {
  const got = ebml(buf, 0, buf.length, 0);
  if (!(got.w > 0) || !(got.h > 0)) return null;
  const out = { w: got.w, h: got.h };
  if (got.dur > 0 && Number.isFinite(got.dur)) {
    const seconds = (got.dur * (got.scale || 1000000)) / 1e9;
    if (seconds > 0) out.duration = Math.round(seconds * 10) / 10;
  }
  return out;
}

async function readTail(file, bytes) {
  const fh = await fsp.open(file, 'r');
  try {
    const stat = await fh.stat();
    const size = Math.min(bytes, stat.size);
    const buf = Buffer.alloc(size);
    const { bytesRead } = await fh.read(buf, 0, size, Math.max(0, stat.size - size));
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

async function readRange(file, start, size) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(size);
    const { bytesRead } = await fh.read(buf, 0, size, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/* Every moov box a buffer can see that is *bigger* than that buffer, as file offsets.
   A box that fits was already decoded by decodeVideo, so the only interesting ones are
   the cut-off ones. The fourcc is searched rather than assumed at offset 4 because a
   tail read starts mid-file, and each hit is taken at most once. */
function moovCandidates(buf, base) {
  const found = [];
  let at = buf.indexOf('moov', 0, 'latin1');
  let tries = 0;
  while (at >= 4 && found.length < 4 && tries < 64) {
    tries += 1;
    const start = at - 4;
    let size = buf.readUInt32BE(start);
    let header = 8;
    if (size === 1 && start + 16 <= buf.length) {
      const big = buf.readBigUInt64BE(start + 8);
      if (big <= BigInt(MOOV_MAX)) size = Number(big);
      header = 16;
    }
    if (size >= header && size <= MOOV_MAX && start + size > buf.length) {
      found.push({ start: base + start, size: size });
    }
    at = buf.indexOf('moov', at + 1, 'latin1');
  }
  return found;
}

/* The shape and length of a video, read from its header — never throws, and never
   downloads the video: two reads of 128 KB at most, plus the index box itself when
   that box is larger than a read. */
async function videoDims(file, key) {
  if (cache.has(key)) return cache.get(key);
  let out = null;
  try {
    const size = (await fsp.stat(file)).size;
    const head = await readHead(file, HEAD_BYTES);
    out = decodeVideo(head, true);
    /* An index bigger than the read. A long recording keeps a moov of megabytes, so it
       arrives cut off and both readers refuse it — and the tail read cannot rescue a
       faststart-ed file, because its index sits at the front. The box declares its own
       size, so read exactly that much and decode the whole box instead of guessing at a
       larger buffer. */
    if (!out) {
      for (const box of moovCandidates(head, 0)) {
        out = decodeVideo(await readRange(file, box.start, box.size), false);
        if (out) break;
      }
    }
    /* Still nothing: the index is at the end, or past the first read entirely. */
    if (!out && size > head.length) {
      const tail = await readTail(file, TAIL_BYTES);
      out = decodeVideo(tail, false);
      if (!out) {
        for (const box of moovCandidates(tail, size - tail.length)) {
          out = decodeVideo(await readRange(file, box.start, box.size), false);
          if (out) break;
        }
      }
    }
  } catch {
    out = null;
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, out);
  return out;
}

module.exports = { dims, videoDims, decode, decodeVideo, cache, CACHE_MAX };
