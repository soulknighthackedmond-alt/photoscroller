# Photoscroller

A tiny self-hosted photo scroller in the spirit of Scrolller. Drop a **folder** of images in, it becomes an **album**, and every album is listed for anyone to open in an endless vertical feed.

- **Public browsing** — anyone with the link can scroll the feed and open albums.
- **Password-gated uploads** — adding or deleting albums needs the upload password (default `admin`).
- **Folder upload** — drag a folder onto the page (or pick one); the folder name becomes the album name.
- **Scrolller-style feed** — one image per screen, snap scrolling, arrow-key / `j` `k` / space navigation, click to zoom.
- **Installs as an app** — add it to a phone's home screen and it opens full screen with its own icon, and keeps working when the signal drops.
- **Uploads that survive a phone signal** — photos go up in batches, and anything the server refuses (HEIC, oversized) is named instead of quietly dropped.
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
   | `MAX_FILES` | optional, default `500` — most photos in one upload request |

5. Deploy, then hit the domain Coolify gives you. `/admin` is where you upload.

The health check hits `/api/albums`, so Coolify will mark the container healthy once it can read the albums folder.

## Install it as an app

Open the site on a phone and add it to the home screen. It then launches full screen with no browser bars and its own icon, and it opens again with no signal.

- **iPhone / iPad, Safari:** tap **Share**, then **Add to Home Screen**. Safari never offers an install prompt, so the viewer shows a one-time hint pointing at the button — dismiss it and it stays dismissed. Safari is the only iOS browser that can do this; Chrome and Firefox on iOS cannot.
- **Android / desktop Chrome:** an **Install** button appears in the top bar whenever the browser offers one (its own menu has *Install app* too).

What makes it behave like an app instead of a bookmark:

| Piece | What it does |
| --- | --- |
| `public/manifest.webmanifest` | `display: standalone`, `start_url` and `scope` of `/`, and the icon set: 192px, 512px, a maskable 512px and the 180px apple-touch icon |
| `public/sw.js` | Service worker — caches the shell so the app opens offline, and Chrome will not offer to install a site without one |
| `public/pwa.js` | Registers the worker, wires up the install button, shows the iOS hint, and flags standalone mode |
| Apple meta tags + `apple-touch-icon` | What iOS reads when it builds the home-screen icon and launches the app full screen |

Worth knowing:

- The icons are **drawn in code and encoded to PNG at runtime** (`lib/icons.js`, served from `/icons/*.png`) so the repo carries no binary blobs. `GET /apple-touch-icon.png` answers too, because that is the path iOS probes when it builds the icon.
- The service worker is **network-first** and never touches `/api/` or `/i/`: a redeploy is picked up on the next load, and the feed and uploads always go to the server. It needs https (or localhost) — on a plain-http origin the browser skips it and everything else still works.
- `sw.js`, the HTML, the CSS and the JS are served `no-cache`, so a redeploy can never be stuck behind a cached copy on a phone; photos keep their one-year immutable cache.

## On a phone

The viewer is built for touch rather than shrunk from the desktop layout:

| Gesture | Action |
| --- | --- |
| Swipe up / down | next / previous photo (native scroll-snap, one photo per screen) |
| Tap a photo | zoom in; tap again for full size; swipe down, tap Close, or tap the backdrop to dismiss |
| Tap an album chip | jump between albums |

Details that matter on a handset:

- **Height** is `100svh`, so a photo always fits while the browser's address bar slides in and out, and everything pinned to an edge respects the notch and home-indicator insets (`env(safe-area-inset-*)`).
- **Captions stay visible** — there is no hover on a phone, so the album/photo label is shown rather than waiting for a mouse.
- **Tap targets** are 44px on touch screens, and text fields are 16px so iOS does not zoom the page when the password box is focused.
- **Rotating the phone re-snaps** to the photo you were on instead of leaving the feed stranded between two images.

Uploading from a phone:

- iOS — and some Android browsers — cannot pick a **folder** (`webkitdirectory` is desktop-only), so the upload page also offers **Choose photos**, straight from the camera roll. The album name then comes from the field, pre-filled as `Photos 27 Sep 2026`.
- Where folder picking does work (desktop, Android Chrome) both buttons are shown.
- Photos upload in **batches of 20**. If the connection drops, the batches that made it are saved, the rest stay selected, and pressing Upload again continues from there.
- Files the server cannot accept are reported rather than silently dropped: oversized ones before the upload starts, wrong-format ones in the server's reply. **HEIC** from an iPhone is the usual case, and the page says what to change (Settings → Camera → Formats → Most Compatible).
- **Add to home screen** to run it full-screen: Safari → Share → Add to Home Screen, Chrome → ⋮ → Add to Home screen. `manifest.webmanifest` and the icons are included.

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
| `GET` | `/icons/*.png`, `/apple-touch-icon.png` | public | Home-screen icons — drawn and PNG-encoded in-process, never committed as files |
| `GET` | `/api/session` | public | Whether this browser is logged in |
| `GET` | `/api/config` | public | Upload limits the upload page needs: `{ maxFileMb, maxFiles }` |
| `POST` | `/api/login` | — | `{ "password": "..." }` → sets an HttpOnly cookie (7 days) |
| `POST` | `/api/logout` | — | Clears the cookie |
| `POST` | `/api/albums` | password | `{ "name": "Tokyo 2026" }` → creates an empty album |
| `POST` | `/api/albums/:slug/photos` | password | multipart: `name` + many `photos` files → `{ saved, files, skipped }`; `skipped` names the files the server would not accept |
| `DELETE` | `/api/albums/:slug` | password | Deletes an album and its photos |
| `DELETE` | `/api/albums/:slug/photos/:file` | password | Deletes one photo |

`order=shuffle` uses a seeded shuffle, so paging through the feed stays stable instead of repeating images.

## Keyboard shortcuts (desktop)

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
public/admin.js      Password gate, folder/photo upload with progress, album management
public/styles.css    Dark theme (touch targets, safe-area insets, dynamic viewport units)
public/manifest.webmanifest   Home-screen install metadata
public/icons/        Home-screen icons (192 + apple-touch 180)
Dockerfile           Production image (node:20-alpine, volume at /data)
docker-compose.yml   Local run
```

## License

MIT — see [LICENSE](LICENSE).
