'use strict';

/**
 * Photoscroller — a self-hosted, Scrolller-style photo feed.
 *
 * Public:   browse albums and scroll the feed.
 * Private:  uploading / deleting requires the upload password (default "admin").
 *
 * Storage is plain folders on disk:  <DATA_DIR>/albums/<album-slug>/*.jpg
 * Point DATA_DIR at a mounted volume so albums survive redeploys.
 */

const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const ALBUMS_DIR = path.join(DATA_DIR, 'albums');
const PASSWORD = String(process.env.UPLOAD_PASSWORD || 'admin');
const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  crypto.createHash('sha256').update('photoscroller::' + PASSWORD).digest('hex');
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_HOURS || 168) * 3600 * 1000;
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 40);
const MAX_FILES = Number(process.env.MAX_FILES || 500);
const COOKIE_NAME = 'ps_session';
const META_FILE = '.album.json';
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp']);

const isImage = (name) => IMAGE_EXT.has(path.extname(name).toLowerCase());

/* the home-screen icons are drawn and PNG-encoded in-process (lib/icons.js) rather
   than committed as binaries, so there is one reviewable source for every size */
const ICONS = require('./lib/icons');

/* ------------------------------------------------------------------ *
 * storage helpers
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * storage health
 *
 * A volume the process cannot write is the most common way a self-hosted
 * deploy of this app "breaks": /data arrives owned by root while the app runs
 * unprivileged. That must not kill the container — a crash-looping process
 * tells you nothing, whereas a server that starts and reports
 * "storage not writable" tells you exactly which setting to fix.
 * ------------------------------------------------------------------ */

const storage = { ok: false, path: DATA_DIR, albumsDir: ALBUMS_DIR, error: null, checkedAt: null };

function noteStorage(err) {
  storage.ok = false;
  storage.error = err ? `${err.code || 'ERROR'}: ${err.message}` : 'unknown storage error';
  storage.checkedAt = new Date().toISOString();
}

/* Writable check: creates the albums dir and writes a probe file, so a read-only
   mount is caught at boot rather than discovered at the first upload. */
function checkStorage() {
  const probe = path.join(DATA_DIR, `.write-probe-${process.pid}`);
  try {
    fs.mkdirSync(ALBUMS_DIR, { recursive: true });
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    storage.ok = true;
    storage.error = null;
  } catch (err) {
    noteStorage(err);
    try {
      fs.rmSync(probe, { force: true });
    } catch {
      /* nothing to clean up */
    }
  }
  storage.checkedAt = new Date().toISOString();
  return storage;
}

const storageSummary = () => ({ ok: storage.ok, path: storage.path, error: storage.error });

function slugify(input) {
  const slug = String(input || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'album-' + Date.now().toString(36);
}

function albumPath(slug) {
  const clean = slugify(slug);
  const full = path.join(ALBUMS_DIR, clean);
  if (path.dirname(full) !== ALBUMS_DIR) throw new Error('bad album path');
  return full;
}

function photoPath(slug, file) {
  const base = path.basename(String(file || ''));
  if (!base || base === META_FILE || !isImage(base)) throw new Error('bad photo name');
  const full = path.join(albumPath(slug), base);
  if (path.dirname(full) !== albumPath(slug)) throw new Error('bad photo path');
  return full;
}

/* Reads must never throw on a broken volume: the list comes back empty and
   /api/health explains why, instead of the page 500ing. */
async function ensureDirs() {
  try {
    await fsp.mkdir(ALBUMS_DIR, { recursive: true });
  } catch (err) {
    noteStorage(err);
  }
}

async function readMeta(slug) {
  try {
    const raw = await fsp.readFile(path.join(albumPath(slug), META_FILE), 'utf8');
    const meta = JSON.parse(raw);
    return { name: String(meta.name || slug), createdAt: meta.createdAt || null };
  } catch {
    return { name: slug, createdAt: null };
  }
}

async function listPhotos(slug) {
  const dir = albumPath(slug);
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const photos = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isImage(entry.name) || entry.name === META_FILE) continue;
    let stat = null;
    try {
      stat = await fsp.stat(path.join(dir, entry.name));
    } catch {
      continue;
    }
    photos.push({
      album: slugify(slug),
      name: entry.name,
      url: '/i/' + encodeURIComponent(slugify(slug)) + '/' + encodeURIComponent(entry.name),
      size: stat.size,
      mtime: stat.mtimeMs,
    });
  }
  photos.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return photos;
}

async function listAlbums() {
  await ensureDirs();
  let entries = [];
  try {
    entries = await fsp.readdir(ALBUMS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const albums = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const slug = entry.name;
    const photos = await listPhotos(slug);
    if (!photos.length) continue;
    const meta = await readMeta(slug);
    albums.push({
      slug,
      name: meta.name,
      createdAt: meta.createdAt,
      count: photos.length,
      cover: photos[0].url,
      updatedAt: Math.max(...photos.map((p) => p.mtime)),
    });
  }
  albums.sort((a, b) => b.updatedAt - a.updatedAt);
  return albums;
}

async function uniqueFileName(dir, original) {
  const parsed = path.parse(path.basename(original));
  const safeBase =
    parsed.name
      .normalize('NFKD')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'photo';
  const ext = IMAGE_EXT.has(parsed.ext.toLowerCase()) ? parsed.ext.toLowerCase() : '.jpg';
  let candidate = safeBase + ext;
  let i = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await fsp.access(path.join(dir, candidate));
      candidate = `${safeBase}-${i++}${ext}`;
    } catch {
      return candidate;
    }
  }
}

/* ------------------------------------------------------------------ *
 * session tokens (stateless HMAC cookie)
 * ------------------------------------------------------------------ */

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sign = (payload) => crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');

function makeToken() {
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = b64url(JSON.stringify({ exp }));
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return false;
  const [payload, mac] = token.split('.');
  const expected = sign(payload);
  const a = Buffer.from(mac || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof data.exp === 'number' && data.exp > Date.now();
  } catch {
    return false;
  }
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

const isAuthed = (req) => verifyToken(parseCookies(req)[COOKIE_NAME]);

/* simple per-IP login throttle */
const attempts = new Map();
function throttled(ip) {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > 10 * 60 * 1000) {
    attempts.delete(ip);
    return false;
  }
  return rec.count >= 10;
}
function noteFailure(ip) {
  const rec = attempts.get(ip) || { first: Date.now(), count: 0 };
  rec.count += 1;
  attempts.set(ip, rec);
}

function requireAuth(req, res, next) {
  if (!isAuthed(req)) return res.status(401).json({ error: 'password required' });
  next();
}

/* ------------------------------------------------------------------ *
 * app
 * ------------------------------------------------------------------ */

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '64kb' }));

/* Uploads are staged and then *moved* into the album folder. rename() only works
   inside a single filesystem, and DATA_DIR is normally a mounted volume — a
   different device from /tmp — so staging there fails with EXDEV. Stage inside
   DATA_DIR when it is writable, fall back to the OS temp dir when it is not;
   moveFile() below copes with either. */
function pickTempDir() {
  const preferred = path.join(DATA_DIR, '.uploads');
  try {
    fs.mkdirSync(preferred, { recursive: true });
    return preferred;
  } catch {
    const fallback = path.join(os.tmpdir(), 'photoscroller-uploads');
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}
const TMP_DIR = pickTempDir();

/* Any file still staged at boot is an orphan from a container that was killed
   mid-upload — nothing can be in flight before this process starts. Only sweep our
   own dir under DATA_DIR; the OS temp fallback may be shared with another instance. */
function sweepStaleUploads() {
  if (!TMP_DIR.startsWith(DATA_DIR + path.sep)) return;
  try {
    for (const entry of fs.readdirSync(TMP_DIR, { withFileTypes: true })) {
      if (entry.isFile()) fs.rmSync(path.join(TMP_DIR, entry.name), { force: true });
    }
  } catch {
    /* a missing or unreadable staging dir is not fatal */
  }
}
sweepStaleUploads();

/* Staged files are removed before the response is sent, so a temp file can never
   outlive the request that created it. */
const cleanupStaged = (files) =>
  Promise.all(files.map((file) => fsp.rm(file.path, { force: true }).catch(() => {})));

/* rename() cannot cross a filesystem boundary, so fall back to copy + unlink.
   Without this, every upload into a mounted volume 500s with EXDEV. */
async function moveFile(src, dest) {
  try {
    await fsp.rename(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await fsp.copyFile(src, dest);
    await fsp.rm(src, { force: true });
  }
}

/* Deliberately not fatal: a root-owned or read-only /data must not stop the
   container from starting — see the storage health note above. */
checkStorage();

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, TMP_DIR),
    filename: (_req, file, cb) =>
      cb(null, Date.now().toString(36) + '-' + crypto.randomBytes(6).toString('hex') + (path.extname(file.originalname) || '.jpg')),
  }),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: MAX_FILES },
  /* multer skips a rejected file silently, so note it: a phone uploading HEIC
     photos would otherwise just get "fewer photos than you chose" with no reason. */
  fileFilter: (req, file, cb) => {
    const ok = isImage(file.originalname);
    if (!ok) {
      if (!req.skippedFiles) req.skippedFiles = [];
      req.skippedFiles.push(String(file.originalname || '').slice(0, 120));
    }
    cb(null, ok);
  },
});

/* --- auth ---------------------------------------------------------- */

app.get('/api/session', (req, res) => res.json({ authed: isAuthed(req), requiresPassword: true }));

/* what the upload page needs to know before it starts sending bytes */
app.get('/api/config', (_req, res) => res.json({ maxFileMb: MAX_FILE_MB, maxFiles: MAX_FILES }));

app.post('/api/login', (req, res) => {
  const ip = req.ip || 'unknown';
  if (throttled(ip)) return res.status(429).json({ error: 'too many attempts, try again in a few minutes' });
  const given = String((req.body && req.body.password) || '');
  const a = Buffer.from(given);
  const b = Buffer.from(PASSWORD);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) {
    noteFailure(ip);
    return res.status(401).json({ error: 'wrong password' });
  }
  attempts.delete(ip);
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${makeToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  );
  res.json({ ok: true });
});

app.post('/api/logout', (_req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});

/* --- read (public) -------------------------------------------------- */

app.get('/api/albums', async (_req, res, next) => {
  try {
    res.json({ albums: await listAlbums(), storage: storageSummary() });
  } catch (err) {
    next(err);
  }
});

/* Health: 200 only when albums can actually be read *and* written, so Coolify
   shows an unhealthy container instead of a green one whose uploads all fail. */
app.get('/api/health', (_req, res) => {
  /* re-probe only while broken, so a fixed volume recovers without a restart
     and a healthy volume is not written to on every health check */
  if (!storage.ok) checkStorage();
  res.status(storage.ok ? 200 : 503).json({
    ok: storage.ok,
    storage: storageSummary(),
    uptime: Math.round(process.uptime()),
  });
});

app.get('/api/feed', async (req, res, next) => {
  try {
    const album = req.query.album ? slugify(req.query.album) : null;
    const limit = Math.min(Number(req.query.limit || 24), 100);
    const offset = Math.max(Number(req.query.offset || 0), 0);
    const order = String(req.query.order || 'shuffle');
    const seed = Number(req.query.seed || 1);

    let photos;
    if (album) {
      photos = await listPhotos(album);
    } else {
      const albums = await listAlbums();
      photos = [];
      for (const entry of albums) photos.push(...(await listPhotos(entry.slug)));
    }

    if (order === 'shuffle') {
      // deterministic shuffle so paging is stable for a given seed
      let state = (seed || 1) >>> 0;
      const rand = () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 4294967296;
      };
      for (let i = photos.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [photos[i], photos[j]] = [photos[j], photos[i]];
      }
    } else {
      photos.sort((x, y) => y.mtime - x.mtime);
    }

    const page = photos.slice(offset, offset + limit);
    res.json({ photos: page, total: photos.length, offset, limit });
  } catch (err) {
    next(err);
  }
});

app.get('/i/:album/:file', async (req, res, next) => {
  try {
    const full = photoPath(req.params.album, req.params.file);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(full, (err) => {
      if (err && !res.headersSent) res.status(err.status || 404).end();
    });
  } catch {
    res.status(400).json({ error: 'bad photo path' });
  }
});

/* --- write (password) ----------------------------------------------- */

app.post('/api/albums', requireAuth, async (req, res, next) => {
  try {
    const name = String((req.body && req.body.name) || '').trim();
    if (!name) return res.status(400).json({ error: 'album name required' });
    const slug = slugify(name);
    const dir = albumPath(slug);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      path.join(dir, META_FILE),
      JSON.stringify({ name: name.slice(0, 80), createdAt: new Date().toISOString() }, null, 2)
    );
    res.json({ slug, name: name.slice(0, 80) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/albums/:slug/photos', requireAuth, upload.array('photos', MAX_FILES), async (req, res, next) => {
  const files = req.files || [];
  try {
    if (!files.length) {
      const skipped = req.skippedFiles || [];
      return res.status(400).json({
        error: skipped.length
          ? `no accepted images in that request (${skipped.length} file(s) skipped: ${skipped.slice(0, 3).join(', ')})`
          : 'no images in request',
        skipped,
      });
    }
    const slug = slugify(req.params.slug);
    const dir = albumPath(slug);
    await fsp.mkdir(dir, { recursive: true });

    let metaExists = true;
    try {
      await fsp.access(path.join(dir, META_FILE));
    } catch {
      metaExists = false;
    }
    if (!metaExists) {
      const displayName = String((req.body && req.body.name) || req.params.slug);
      await fsp.writeFile(
        path.join(dir, META_FILE),
        JSON.stringify({ name: displayName.slice(0, 80), createdAt: new Date().toISOString() }, null, 2)
      );
    }

    const saved = [];
    for (const file of files) {
      const target = await uniqueFileName(dir, file.originalname);
      await moveFile(file.path, path.join(dir, target));
      saved.push(target);
    }
    await cleanupStaged(files);
    res.json({ album: slug, saved: saved.length, files: saved, skipped: req.skippedFiles || [] });
  } catch (err) {
    await cleanupStaged(files);
    next(err);
  }
});

app.delete('/api/albums/:slug', requireAuth, async (req, res, next) => {
  try {
    await fsp.rm(albumPath(req.params.slug), { recursive: true, force: true });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/albums/:slug/photos/:file', requireAuth, async (req, res, next) => {
  try {
    await fsp.rm(photoPath(req.params.slug, req.params.file), { force: true });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* --- icons (generated, not committed) -------------------------------- */

function sendIcon(res, name) {
  const buf = ICONS.get(name);
  if (!buf) return false;
  /* deterministic bytes, so a day of caching is safe and free */
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Content-Length', String(buf.length));
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.end(buf);
  return true;
}

app.get('/icons/:name', (req, res) => {
  if (!sendIcon(res, req.params.name)) res.status(404).json({ error: 'no such icon' });
});

/* iOS looks for these two paths at the root when it builds a home-screen icon */
app.get('/apple-touch-icon.png', (_req, res) => sendIcon(res, 'apple-touch-icon.png'));
app.get('/apple-touch-icon-precomposed.png', (_req, res) => sendIcon(res, 'apple-touch-icon.png'));

/* browsers ask for /favicon.ico unprompted; without this the SPA catch-all
   below answers that request with a page of HTML */
app.get('/favicon.ico', (_req, res) => {
  if (!sendIcon(res, 'icon-192.png')) res.status(404).end();
});

/* --- static + pages -------------------------------------------------- */

app.use(
  express.static(path.join(__dirname, 'public'), {
    index: 'index.html',
    maxAge: '1h',
    /* name the web manifest's type explicitly instead of trusting the mime table:
       a wrong content type makes browsers ignore the manifest and refuse to install */
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.webmanifest')) res.setHeader('Content-Type', 'application/manifest+json');
      /* the shell and the service worker must never be served stale, or a redeploy can
         leave a phone running last week's JS — and a cached sw.js can't update itself */
      if (/\.(?:html|js|css|webmanifest)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, _req, res, _next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `file too large (max ${MAX_FILE_MB} MB)` });
  }
  if (err && (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE')) {
    return res.status(400).json({ error: `too many files in one upload (max ${MAX_FILES})` });
  }
  /* a read-only or full volume is a configuration problem, so name it instead
     of returning a bare 500 that says nothing */
  if (err && ['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'ENOTDIR'].includes(err.code)) {
    console.error(err);
    return res.status(507).json({
      error:
        `storage not writable (${err.code}) at ${DATA_DIR} — mount a writable volume there ` +
        'and set DATA_DIR to it',
      storage: storageSummary(),
    });
  }
  console.error(err);
  res.status(500).json({ error: 'server error' });
});

app.listen(PORT, () => {
  console.log(`photoscroller listening on :${PORT}`);
  console.log(`data dir: ${DATA_DIR} (${storage.ok ? 'writable' : 'NOT WRITABLE'})`);
  console.log(`upload staging: ${TMP_DIR}`);
  if (!storage.ok) {
    console.error(
      `STORAGE NOT WRITABLE: ${storage.error}\n` +
        `  albums cannot be saved. Mount a writable volume at ${DATA_DIR} ` +
        '(on Coolify: Storages → add a volume at /data, and set DATA_DIR=/data), then restart.'
    );
  }
  if (PASSWORD === 'admin') console.log('WARNING: using the default upload password "admin" — set UPLOAD_PASSWORD.');
});
