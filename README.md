# Photoscroller

A tiny self-hosted photo scroller in the spirit of Scrolller. Drop a **folder** of images in, it becomes an **album**, and every album is listed for anyone to open in an endless vertical feed.

- **Public browsing** — anyone with the link can scroll the feed and open albums.
- **Password-gated uploads** — adding or deleting albums needs the upload password (default `admin`).
- **Folder upload** — drag a folder onto the page (or pick one); the folder name becomes the album name.
- **Scrolller-style feed** — one image per screen, snap scrolling, arrow-key / `j` `k` / space navigation, click to zoom.
- **No database** — albums are plain folders under `DATA_DIR/albums/<slug>/`.
- **One container, no build step** — Node + Express + a static frontend, so it deploys on Coolify (or anywhere Docker runs) in one go.

## Quick start

### Docker Compose (local)

```bash
git clone https://github.com/soulknighthackedmond-alt/photoscroller.git
cd photoscroller
docker compose up --build
# → http://localhost:3000
```

### Plain Node

```bash
npm install
UPLOAD_PASSWORD=admin npm start
# → http://localhost:3000
```

Then open `/admin`, unlock with the password, and drop a folder of photos in.

## Deploying on Coolify

1. **New Resource → Public Repository**, paste the repo URL:
   `https://github.com/soulknighthackedmond-alt/photoscroller`
   Branch `main`, **Build Pack: Dockerfile** (Coolify picks it up automatically).
2. **Ports**: expose `3000` (the Dockerfile already declares `EXPOSE 3000`).
3. **Storages → Add volume**: mount a persistent volume at `/data`. Without this, albums disappear on every redeploy — this is the one step people forget.
4. **Environment Variables**:

   | Key | Value |
   | --- | --- |
   | `UPLOAD_PASSWORD` | your password — **change it from `admin`** |
   | `SESSION_SECRET` | a long random string, e.g. `openssl rand -hex 32` |
   | `DATA_DIR` | `/data` |
   | `MAX_FILE_MB` | optional, default `40` |

5. Deploy, then hit the domain Coolify gives you. `/admin` is where you upload.

The health check hits `/api/albums`, so Coolify will mark the container healthy once it can read the albums folder.

## How it works

```
data/albums/
  tokyo-2026/
    .album.json      # { "name": "Tokyo 2026", "createdAt": "..." }
    DSC_0001.jpg
    DSC_0002.jpg
  camping/
    ...
```

The folder name is the slug (URL-safe); the display name lives in `.album.json`. Deleting the folder deletes the album.

## API

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/albums` | public | Every album: slug, name, photo count, cover URL |
| `GET` | `/api/feed?album=&offset=&limit=&order=shuffle\|recent&seed=` | public | Paged photo feed (all albums when `album` is omitted) |
| `GET` | `/i/:album/:file` | public | The image itself |
| `GET` | `/api/session` | public | Whether this browser is logged in |
| `POST` | `/api/login` | — | `{ "password": "..." }` → sets an HttpOnly cookie (7 days) |
| `POST` | `/api/logout` | — | Clears the cookie |
| `POST` | `/api/albums` | password | `{ "name": "Tokyo 2026" }` → creates an empty album |
| `POST` | `/api/albums/:slug/photos` | password | multipart: `name` + many `photos` files |
| `DELETE` | `/api/albums/:slug` | password | Deletes an album and its photos |
| `DELETE` | `/api/albums/:slug/photos/:file` | password | Deletes one photo |

`order=shuffle` uses a seeded shuffle, so paging through the feed stays stable instead of repeating images.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `↓` / `j` / `Space` | next photo |
| `↑` / `k` | previous photo |
| `Enter` / `o` | zoom the current photo |
| `Esc` | close zoom |

## Security notes

- The upload password is compared in constant time; 10 failed attempts from one IP locks logins for 10 minutes.
- Uploads are restricted to image extensions (`.jpg .jpeg .png .gif .webp .avif .bmp` — no SVG, since it can carry script), filenames are sanitised, and photo paths are resolved with `path.basename` so `../` traversal can't escape an album folder.
- Login is an HMAC-signed HttpOnly cookie, not a session store, so the container stays stateless.
- **Change the default password.** It is only `admin` because that's the documented default; leaving it set on a public host means anyone can upload.

## Files

```
server.js            Express app: auth, albums, feed, uploads
public/index.html    Viewer shell (feed + album grid)
public/app.js        Feed, routing, keyboard nav, zoom
public/admin.html    Upload page
public/admin.js      Password gate, folder upload with progress, album management
public/styles.css    Dark theme
Dockerfile           Production image (node:20-alpine, volume at /data)
docker-compose.yml   Local run
```

## License

MIT — see [LICENSE](LICENSE).
