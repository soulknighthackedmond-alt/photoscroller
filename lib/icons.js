'use strict';

/* Photoscroller's home-screen icons, drawn in code and PNG-encoded at runtime.

   Why generated instead of committed as files: the icon has to exist at four sizes
   (192, 512, 512-maskable and 180 for apple-touch-icon), and a binary blob in a repo
   is a blob nobody can review. The drawing is deterministic, so all four sizes are
   the same picture produced by the same code — and the smoke test decodes the bytes
   this module returns, so a broken icon fails the build instead of shipping.

   The motif mirrors the SVG logo in the page header: a viewfinder hump and a lens
   ring on the accent purple. The maskable variant shrinks the motif into the middle
   so Android's circle mask cannot clip it. */

const zlib = require('zlib');

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BG = [0x6c, 0x5c, 0xe7]; // #6c5ce7 — the same fill as the logo in the header

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function encodePng(w, h, rgba) {
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- the motif ---------- */

const LENS = { cx: 0.5, cy: 0.53125, r: 0.21875, half: 0.0390625 };
const HUMP = { x0: 0.28125, y0: 0.21875, x1: 0.53125, y1: 0.34375, r: 0.046875 };

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function inMotif(x, y) {
  const d = Math.hypot(x - LENS.cx, y - LENS.cy);
  if (Math.abs(d - LENS.r) <= LENS.half) return true;
  return inRoundRect(x, y, HUMP.x0, HUMP.y0, HUMP.x1, HUMP.y1, HUMP.r);
}

/* 3x3 supersampling of one pixel. The sub-samples live *inside* that pixel, so the
   step is 1/(3*size) of the unit square — not 1/3 of it (averaging over a whole unit
   square would blend the entire motif into every pixel). */
function motifCoverage(px, py, size, scale) {
  let hit = 0;
  for (let sy = 0; sy < 3; sy++) {
    for (let sx = 0; sx < 3; sx++) {
      const u = (px + (sx + 0.5) / 3) / size;
      const v = (py + (sy + 0.5) / 3) / size;
      if (scale === 1) {
        if (inMotif(u, v)) hit++;
      } else {
        const mu = (u - 0.5) / scale + 0.5;
        const mv = (v - 0.5) / scale + 0.5;
        if (mu >= 0 && mu <= 1 && mv >= 0 && mv <= 1 && inMotif(mu, mv)) hit++;
      }
    }
  }
  return hit / 9;
}

function render(size, motifScale) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      /* a flat background keeps the PNG small (a few KB rather than tens) */
      const cov = motifCoverage(px, py, size, motifScale);
      const i = (py * size + px) * 4;
      rgba[i] = Math.round(BG[0] + (255 - BG[0]) * cov);
      rgba[i + 1] = Math.round(BG[1] + (255 - BG[1]) * cov);
      rgba[i + 2] = Math.round(BG[2] + (255 - BG[2]) * cov);
      rgba[i + 3] = 255;
    }
  }
  return encodePng(size, size, rgba);
}

/* ---------- what the manifest and the pages ask for ---------- */

const SIZES = {
  'icon-192.png': { size: 192, scale: 1 },
  'icon-512.png': { size: 512, scale: 1 },
  'icon-maskable-512.png': { size: 512, scale: 0.72 },
  'apple-touch-icon.png': { size: 180, scale: 1 },
};

const cache = new Map();

const has = (name) => Object.prototype.hasOwnProperty.call(SIZES, name);
const names = () => Object.keys(SIZES);
const spec = (name) => (has(name) ? SIZES[name] : null);

/* rendered once, then served from memory */
function get(name) {
  if (!has(name)) return null;
  if (!cache.has(name)) {
    const { size, scale } = SIZES[name];
    cache.set(name, render(size, scale));
  }
  return cache.get(name);
}

module.exports = { get, has, names, spec, render, encodePng, SIG, BG };
