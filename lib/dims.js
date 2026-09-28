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

module.exports = { dims, decode, cache, CACHE_MAX };
