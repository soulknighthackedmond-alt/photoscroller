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
const COOKIE_NAME = 'ps_session';
const META_FILE = '.album.json';
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp']);

const isImage = (name) => IMAGE_EXT.has(path.extname(name).toLowerCase());

/* ------------------------------------------------------------------ *
 * storage helpers
 * ------------------------------------------------------------------ */

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

async function ensureDirs() {
  await fsp.mkdir(ALBUMS_DIR, { recursive: true });
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

const TMP_DIR = path.join(os.tmpdir(), 'photoscroller-uploads');
fs.mkdirSync(TMP_DIR, { recursive: true });
fs.mkdirSync(ALBUMS_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, TMP_DIR),
    filename: (_req, file, cb) =>
      cb(null, Date.now().toString(36) + '-' + crypto.randomBytes(6).toString('hex') + (path.extname(file.originalname) || '.jpg')),
  }),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 500 },
  fileFilter: (_req, file, cb) => cb(null, isImage(file.originalname)),
});

/* --- auth ---------------------------------------------------------- */

app.get('/api/session', (req, res) => res.json({ authed: isAuthed(req), requiresPassword: true }));

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
    res.json({ albums: await listAlbums() });
  } catch (err) {
    next(err);
  }
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

app.post('/api/albums/:slug/photos', requireAuth, upload.array('photos', 500), async (req, res, next) => {
  const files = req.files || [];
  try {
    if (!files.length) return res.status(400).json({ error: 'no images in request' });
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
      await fsp.rename(file.path, path.join(dir, target));
      saved.push(target);
    }
    res.json({ album: slug, saved: saved.length, files: saved });
  } catch (err) {
    next(err);
  } finally {
    for (const file of files) {
      fsp.rm(file.path, { force: true }).catch(() => {});
    }
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

/* --- static + pages -------------------------------------------------- */

app.use(
  express.static(path.join(__dirname, 'public'), {
    index: 'index.html',
    maxAge: '1h',
  })
);

app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, _req, res, _next) => {
  const status = err && err.code === 'LIMIT_FILE_SIZE' ? 413 : 500;
  if (status === 413) return res.status(413).json({ error: `file too large (max ${MAX_FILE_MB} MB)` });
  console.error(err);
  res.status(500).json({ error: 'server error' });
});

app.listen(PORT, () => {
  console.log(`photoscroller listening on :${PORT}`);
  console.log(`data dir: ${DATA_DIR}`);
  if (PASSWORD === 'admin') console.log('WARNING: using the default upload password "admin" — set UPLOAD_PASSWORD.');
});
