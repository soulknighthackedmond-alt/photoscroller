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
2. **How the app gets reached** — the container listens on `3000` (`EXPOSE 3000`), but Coolify does **not** publish that port on the host by default; it routes through its own Traefik proxy by domain. Pick one:
   - **Use the domain (the default):** put a hostname in the resource's **Domains** field (`photos.example.com`, or a `<name>.<server-ip>.sslip.io` name if you have no DNS) and open the app there on port 80/443.
   - **Or publish the port:** Advanced → **Ports Mappings** → `3000:3000`, which makes `http://<server-ip>:3000` work directly.

   Skip both and `http://<server-ip>:3000` is refused (`ERR_CONNECTION_REFUSED`) even though the container is running happily — the port is only open inside Docker.
3. **Storages → Add volume**: mount a persistent volume at `/data`. Without this, albums disappear on every redeploy — this is the one step people forget. The image's entrypoint fixes ownership of the mount before it drops to the unprivileged user, so a normal bind mount works without a manual `chown`.
4. **Environment Variables**:

   | Key | Value |
   | --- | --- |
   | `UPLOAD_PASSWORD` | your password — **change it from `admin`** |
   | `SESSION_SECRET` | a long random string, e.g. `openssl rand -hex 32` |
   | `DATA_DIR` | `/data` |
   | `MAX_FILE_MB` | optional, default `40` |
   | `MAX_FILES` | optional, default `500` — most photos in one upload request |
   | `PUID` / `PGID` | optional, default `1000` — the uid/gid that should own a bind-mounted `/data` |

5. Deploy, then hit the domain Coolify gives you. `/admin` is where you upload.

The health check hits `/api/health`, which answers `200` only when albums can be read **and** written — so a container whose volume is wrong shows up as unhealthy in Coolify instead of green-but-broken.

## Troubleshooting

**`ERR_CONNECTION_REFUSED` on `http://<server-ip>:3000`.** Nothing is listening on that port *on the host*. Coolify routes apps through Traefik by domain and only publishes container ports when you ask it to (see step 2 above). Either open the app on the domain from the resource's **Domains** field, or add a port mapping `3000:3000`. Traefik answering on port 80 is a good sign — the server is up, the app is simply not routed on the bare IP.

**The container is unhealthy or restarting.** Open its logs. `STORAGE NOT WRITABLE` means `/data` is not writable by the app's user: add a volume at `/data` (Storages → Add volume) and set `DATA_DIR=/data`. The entrypoint takes ownership of the mount before dropping privileges, so a plain bind mount normally just works; if the folder is owned by another uid, set `PUID`/`PGID` to match.

**The page loads but says "Storage isn't writable".** The app is running, the volume is not. Same fix. `GET /api/health` returns `503` with the exact path and error, and the app recovers by itself — no restart — once the volume is writable.

**Uploads report "no accepted images".** HEIC/HEIF from an iPhone; see the phone section above.

**Nothing loads on a phone.** The service worker needs https (or localhost). Coolify gives you https on the domain, not on a raw `ip:port`.

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
| Tap a photo while blurred | reveal that one photo; a second tap zooms it |
| Tap an album chip | jump between albums |

Details that matter on a handset:

- **Height is measured, not guessed.** One number decides how tall a photo's screen is — the measured height of the scroll container, published as `--screen`. iOS Safari resolves `100svh` and the `html, body { height: 100% }` chain against different boxes, which used to make every photo slightly taller than the area showing it: a sliver of the next photo, a clipped bottom edge and mandatory snapping that jittered. Rotating the phone, or the address bar sliding in and out, re-measures and puts the same photo back.
- **A photo fills the box it is given.** The `<img>` is `width: 100%; height: 100%` with `object-fit: contain`, so a 16:9 shot gets the full width of the screen and any letterboxing happens inside the element. On touch there is no padding at all — only the landscape notch inset — and the top bar drops to 48px, so the picture gets every pixel going. Anything pinned to an edge still respects the notch and home-indicator insets (`env(safe-area-inset-*)`).
- **The caption gets out of the way.** There is no hover on a phone, so the album/photo label is shown, then fades out a few seconds after a photo becomes current and comes back on the next one.
- **The zoom overlay is pinned to the visible viewport.** A `position: fixed` element is sized against the *large* viewport on iOS Safari, which puts the bottom of the overlay — and its Close button — below the fold. `--app-h` is the measured visible height instead.
- **Tap targets** are 44px on touch screens, and text fields are 16px so iOS does not zoom the page when the password box is focused.

### Blurring thumbnails

The **Blur** button in the top bar hides every thumbnail behind a blur — feed photos and album covers alike. Tap a photo to reveal that one; tap it again to zoom. A blurred photo can never reach the zoom overlay, so nothing is revealed by accident. The setting is remembered across visits, and `b` toggles it from the keyboard.

This is a privacy screen, not access control: the images are still served normally to anyone with the URL. It stops a photo appearing on screen before you ask for it, and nothing more.

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

Uploads are staged in `DATA_DIR/.uploads` and then moved into the album, so the move
stays on one filesystem — a `rename()` across a mount point fails with `EXDEV`, and
staging in `/tmp` would break every upload the moment you mount a volume. Anything
still staged at boot is an orphan from a container killed mid-upload, and is swept.

## API

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/albums` | public | Every album: slug, name, photo count, cover URL — plus `storage: { ok, path, error }` |
| `GET` | `/api/feed?album=&offset=&limit=&order=shuffle\|recent&seed=` | public | Paged photo feed (all albums when `album` is omitted) |
| `GET` | `/i/:album/:file` | public | The image itself |
| `GET` | `/icons/*.png`, `/apple-touch-icon.png` | public | Home-screen icons — drawn and PNG-encoded in-process, never committed as files |
| `GET` | `/api/session` | public | Whether this browser is logged in |
| `GET` | `/api/config` | public | Upload limits the upload page needs: `{ maxFileMb, maxFiles }` |
| `GET` | `/api/health` | public | `200` when albums can be read *and* written; `503` with the path and the error when they cannot |
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
| `b` | blur / unblur every thumbnail |

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
public/sw.js         Service worker: caches the shell so the installed app opens offline
public/pwa.js        Install button, iOS "Add to Home Screen" hint, standalone detection
lib/icons.js         Home-screen icons, drawn and PNG-encoded at runtime (no binaries in the repo)
docker-entrypoint.js Makes the mounted volume writable, then drops to the unprivileged user
Dockerfile           Production image (node:20-alpine, volume at /data)
docker-compose.yml   Local run
```

## Reaching the app from your network

Coolify puts every app behind its own Traefik proxy and routes by **hostname**, not by published host ports. Two consequences are worth knowing before blaming the container:

- `<server-ip>:3000` refuses even while the app is running healthy, because nothing is published on the host by default.
- The auto-generated domain (`<random>.<ip>.sslip.io`) embeds the **server IP stored in Coolify** (Servers -> your server -> IP address). If that address is not your current WAN IP, the domain points somewhere else entirely and the request never reaches your network. Residential WAN IPs change, so a `sslip.io` name baked from one is a name that expires.

### On your own network (simplest)

Resource -> **Advanced -> Ports Mappings** -> add `3000:3000`, redeploy, then open `http://<server-lan-ip>:3000`. This bypasses Traefik and needs no DNS.

### From the internet

1. Point a name you control at your WAN IP. DuckDNS works well here, and it needs an updater because the IP changes.
2. Put that name in the resource's **Domains** field instead of the generated `sslip.io` one.
3. Forward WAN `80` -> `<server-lan-ip>:80` (and `443` for https) on your router. Some ISPs block inbound 80/443 on residential lines, so if the app still does not answer after forwarding, that is the likely reason.
4. Turn on NAT loopback on the router if you also want the public name to work from inside the house.

### https without opening any ports

Put a Cloudflare Tunnel in front (Coolify ships it as a service template). You get an https hostname with no forwarded ports, and the tunnel hands plain HTTP to Traefik.

### The home-screen app over plain http

Icons, `apple-touch-icon` and the standalone meta tags all work over plain http, so Share -> Add to Home Screen still gives you a full-screen app on iOS. The **service worker does not** - it needs a secure context, so over `http://<lan-ip>:3000` there is no offline caching and Chrome will not offer its install dialog. Serve it over https (tunnel or domain) for the complete PWA.

## License

MIT — see [LICENSE](LICENSE).
