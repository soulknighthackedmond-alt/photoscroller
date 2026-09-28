# Photoscroller

A tiny self-hosted photo scroller in the spirit of Scrolller. Drop a **folder** of images in, it becomes an **album**, and every album is listed in a masonry grid you scroll endlessly — the rule34-scroller / Scrolller feel.

- **Everything is behind one password** — the pages, the API and the photos themselves (default `changeme`). Uploading and deleting use the same password, so there is one secret to change.
- **Opens on the album list** — a bare address, a reload and the installed app all land on **Albums**; the mixed **Everything** grid is one chip away.
- **Masonry grid, endless scroll** — the default view packs thumbnails into columns and never snaps, so a flick of the thumb crosses a screenful at a time. Tap any photo to open it full screen.
- **The page scrolls, not a box inside it** — the album list and the feed are ordinary pages with a sticky top bar, the way rule34.pw's are. That is what lets iOS Safari collapse its address bar as you swipe and hand the height back to the photos.
- **One photo per screen when you want it** — **Feed** in the top bar is the snap-scrolling viewer: one image per screen, arrow-key / `j` `k` / space navigation, pinch or double-tap to zoom.
- **Accurate zoom** — pinch, double-tap, drag and wheel zoom about the exact point under your fingers, on a photo laid out at its real pixel size.
- **Folder upload** — drag a folder onto the page (or pick one); the folder name becomes the album name.
- **In the order you uploaded them** — albums and photos run in the order they arrived, not by filename or mtime. **Shuffle** is one tap away when you want it.
- **Fill by default, fit on demand** — in Feed mode the photo fills the screen so a landscape shot is as big as the phone allows; tap **Fit** to see the whole photo, letterbox filled by its own blurred colours.
- **Blur mode** — one tap hides every thumbnail, feed photo and album cover; tap a photo to reveal that one.
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
APP_PASSWORD=changeme npm start
# → http://localhost:3000
```

The app asks for the password first; then open `/admin` and drop a folder of photos in.

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
   | `APP_PASSWORD` | your password — **change it from `changeme`**. Gates the pages, the API and the photos. `UPLOAD_PASSWORD` is still read as a fallback, so an existing deployment keeps working |
   | `SESSION_SECRET` | a long random string, e.g. `openssl rand -hex 32` |
   | `DATA_DIR` | `/data` |
   | `SESSION_TTL_HOURS` | optional, default `720` (30 days) — how long a login lasts |
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

## The grid (the default view)

The default view is a masonry wall of thumbnails — the Scrolller / rule34-scroller feel — and it is a different thing from the feed, not a restyled one:

- **No snapping.** A flick of the thumb crosses a screenful at a time instead of being pulled to a stop at every photo. **Feed** in the top bar (or `g`) switches to one photo per screen.
- **Columns by width, at rule34.pw's own breakpoints** — one full-width column on a phone, two from 768px, three from 1024px. The phone gets a single column because that is what the site this is modelled on does, and it is the better read: the photo is as wide as the screen and you scroll past it, instead of two thumbnails you have to squint at.
- **The other numbers are its too** — an 8px gutter, 6px corners, and a tile that shows the whole photo (`object-fit: contain`) rather than cropping it to the box. The gutter is not tightened on touch, because the original does not tighten it either.
- **Each photo goes into the shortest column**, which is what keeps the bottom edge even. CSS `columns` cannot do this: it reflows the whole set every time a page is appended, and throws the scroll position away with it.
- **The space is reserved before the photo arrives.** Each photo's width and height are read from its own file header (`lib/dims.js`) and sent with the feed, so a tile has the right shape before a byte of image lands and the columns never jump under your thumb. That read is a few hundred bytes, cached per file, and a photo whose header cannot be read simply corrects itself when it loads.
- **Endless scroll** — 40 photos per request, fetched as you approach the bottom.
- **Tap a photo** to open it full screen with the accurate zoom; tap a blurred one to reveal it first.
- Rotating the phone changes how many columns fit, so the photos are placed again from the list already in memory — nothing is refetched, and the scroll offset is kept.

## On a phone

The viewer is built for touch rather than shrunk from the desktop layout:

| Gesture | Action |
| --- | --- |
| Swipe up / down | next / previous photo (native scroll-snap, one photo per screen) |
| Tap a photo | open it. The photo takes no tap of its own, so a tap can never fight a drag |
| Tap a photo while blurred | reveal that one photo; a second tap opens it |

Inside the zoom overlay:

| Gesture | Action |
| --- | --- |
| Pinch | zoom about the point between your fingers, 100% to 800% |
| Double-tap | in to 250% about the tap, and back out to the whole photo |
| Drag | pan the photo, stopping at its edge instead of losing it off-screen |
| Swipe down at fit size | close the overlay |
| `+` / `−` / the read-out | zoom in, zoom out, back to the whole photo |
| Backdrop, Close or `Esc` | dismiss |
| Tap an album chip | jump between albums |

Details that matter on a handset:

- **The document is the scroller.** The feed used to be its own scroller (`height: 100%; overflow-y: auto`), which makes the app a window inside a window: iOS Safari keeps its address bar on screen for an inner scroller, so the page never felt like a page and every photo lost a strip of height. The document scrolls now, exactly as rule34.pw's does, with the top bar `position: sticky` and in the flow. The snap moved with it — `html.snap-feed` carries `scroll-snap-type` and `scroll-padding-top`, and app.js puts that class on `<html>` in feed mode only, so the grid can never be pulled to a stop mid-flick.
- **Height is measured, not guessed.** One number decides how tall a photo's screen is: the visible height minus the measured height of the sticky bar, published as `--screen`. iOS Safari resolves `100svh` and the visible viewport against different boxes, which used to make every photo slightly taller than the area showing it: a sliver of the next photo, a clipped bottom edge and mandatory snapping that jittered. It is also exactly the snapport (`scroll-padding-top`), so a snapped photo fills the screen instead of starting under the bar. Rotating the phone, or the address bar sliding in and out, re-measures and puts the same photo back.
- **A photo gets every pixel it can.** The `<img>` is `width: 100%; height: 100%` with `object-fit: contain`, so a 16:9 shot gets the full width of the screen and any letterboxing happens inside the element. On touch there is no padding at all — only the landscape notch inset — and the top bar drops to 48px. Anything pinned to an edge still respects the notch and home-indicator insets (`env(safe-area-inset-*)`).
- **The letterbox is the photo's own colours.** On a portrait phone a 16:9 shot can only ever be as wide as the screen — roughly a third of its height — and the rest used to be flat black, which made the photo read as small. That space is now filled with the same photo, blurred and darkened (`.item::before`, the same URL, so no extra request). It is hidden while thumbnails are blurred, so a privacy screen stays private.
- **Fill is the default; Fit is one tap away.** A 16:9 photo shown whole on a portrait phone is only as wide as the screen — about a quarter of its height, which is the strip you have to squint at — so the feed fills the screen unless you choose otherwise. `Fit` shows the whole photo at the largest size that fits, with the leftover space filled by its own blurred colours. The top-bar button switches between them, the choice is remembered, and `f` does the same from a keyboard.
- **Zooming is accurate, and it comes back.** The overlay opens showing the whole photo, and zooms about whatever point you touched — up to 800%, which for a 1920px-wide shot on a 390px screen is past its own pixels. Double-tap zooms in about the tap and back out again; a drag pans and stops at the photo edge.
- **The caption gets out of the way.** There is no hover on a phone, so the album/photo label is shown, then fades out a few seconds after a photo becomes current and comes back on the next one.
- **The zoom overlay is pinned to the visible viewport, and its arithmetic is exact.** A `position: fixed` element is sized against the *large* viewport on iOS Safari, which puts the bottom of the overlay — and its controls — below the fold. `--app-h` is the measured visible height instead. Inside it the photo is laid out at exactly its fit size in pixels and then moved by a single `transform`, so the photo point under your finger stays under your finger. Pinch, drag, wheel, double-tap and the buttons all go through the pure functions in `public/zoommath.js` — no DOM in that file, which is what lets the test harness check the arithmetic numerically: a zoom in and back out returns to the same pixel, and 500 random zooms drift by less than a thousandth of a pixel.
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
    .album.json      # { "name": "Tokyo 2026", "createdAt": "...", "order": [...] }
    DSC_0001.jpg
    DSC_0002.jpg
  camping/
    ...
```

The folder name is the slug (URL-safe); the display name and the photo order live in `.album.json`. Deleting the folder deletes the album.

`order` lists the filenames in the sequence they were uploaded, and the feed reads the album back in that sequence. It is recorded when each file is saved rather than worked out later, because neither mtime nor the filename can be trusted for it: one upload batch can share a millisecond, and a copy or restore rewrites mtimes wholesale. A photo with no recorded entry — an album made by hand, or one made before this existed — falls back to mtime and then filename, so the result is always deterministic. Deleting a photo removes it from the list.

Uploads are staged in `DATA_DIR/.uploads` and then moved into the album, so the move
stays on one filesystem — a `rename()` across a mount point fails with `EXDEV`, and
staging in `/tmp` would break every upload the moment you mount a volume. Anything
still staged at boot is an orphan from a container killed mid-upload, and is swept.

## API

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/login` | open | The password form — the only page served without a session |
| `POST` | `/api/login` | open | `{ "password": "..." }` → sets an HttpOnly cookie (30 days) |
| `POST` | `/api/logout` | open | Clears the cookie |
| `GET` | `/api/session` | open | Whether this browser is logged in |
| `GET` | `/api/health` | open | `200` when albums can be read *and* written; `503` with the path and the error when they cannot |
| `GET` | `/icons/*.png`, `/apple-touch-icon.png` | open | Home-screen icons — drawn and PNG-encoded in-process, never committed as files |
| `GET` | `/api/albums` | password | Every album: slug, name, photo count, cover URL — plus `storage: { ok, path, error }` |
| `GET` | `/api/feed?album=&offset=&limit=&order=upload\|shuffle\|recent&seed=` | password | Paged photo feed (all albums when `album` is omitted); each photo carries `w`/`h` read from its file header |
| `GET` | `/i/:album/:file` | password | The image itself |
| `GET` | `/api/config` | password | Upload limits the upload page needs: `{ maxFileMb, maxFiles }` |
| `POST` | `/api/albums` | password | `{ "name": "Tokyo 2026" }` → creates an empty album |
| `POST` | `/api/albums/:slug/photos` | password | multipart: `name` + many `photos` files → `{ saved, files, skipped }`; `skipped` names the files the server would not accept |
| `DELETE` | `/api/albums/:slug` | password | Deletes an album and its photos |
| `DELETE` | `/api/albums/:slug/photos/:file` | password | Deletes one photo |

Everything except those first six rows needs the session cookie. Without one, a page request is redirected to `/login?next=<where you were>` and an API call or an image gets a plain `401` — a redirect would be followed and then answered with HTML where JSON or a picture was expected.

`order=upload` is the default: albums oldest first, and inside each album the order the photos were uploaded in. `order=shuffle` uses a seeded shuffle, so paging through the feed stays stable instead of repeating images; `order=recent` sorts newest-first.

## Keyboard shortcuts (desktop)

| Key | Action |
| --- | --- |
| `↓` / `j` / `Space` | next photo |
| `↑` / `k` | previous photo |
| `Enter` / `o` | open the current photo |
| `Esc` | close zoom |
| `+` / `-` | zoom in / out about the middle of the screen (or scroll, or ctrl+scroll for a trackpad pinch) |
| `0` | back to the whole photo |
| `b` | blur / unblur every thumbnail |
| `f` | fit / fill the screen (Feed mode) |
| `g` | grid / feed |
| `s` | shuffle / back to uploaded order |

In the grid the arrow keys, space and the wheel are the browser's own — hijacking them would make a scroller that cannot be scrolled — so only the toggles above are bound.

## Security notes

- The password is compared in constant time; 10 failed attempts from one IP locks logins for 10 minutes.
- Uploads are restricted to image extensions (`.jpg .jpeg .png .gif .webp .avif .bmp` — no SVG, since it can carry script), filenames are sanitised, and photo paths are resolved with `path.basename` so `../` traversal can't escape an album folder.
- Login is an HMAC-signed HttpOnly cookie, not a session store, so the container stays stateless.
- **Change the default password.** It is only `changeme` because that is the documented default, and the server logs a warning at every boot while it is still set. On a host anyone can reach, leaving it means anyone can read every photo and upload more.
- It is one password on a cookie, not user accounts: whoever has it sees everything, and there is no way to grant someone read-only access.

## Files

```
server.js            Express app: password gate, albums, feed, uploads
public/index.html    Viewer shell (grid + feed + album list)
public/app.js        Grid, feed, routing, keyboard nav, zoom gestures
public/zoommath.js   The zoom arithmetic (no DOM, so it can be tested)
public/login.html    The password form — self-contained, served before anyone has a session
public/admin.html    Upload page
public/admin.js      Upload with progress, album management
public/styles.css    Dark theme (masonry grid, touch targets, safe-area insets)
public/manifest.webmanifest   Home-screen install metadata
public/sw.js         Service worker: caches the shell so the installed app opens offline
public/pwa.js        Install button, iOS "Add to Home Screen" hint, standalone detection
lib/dims.js          Photo width/height read from the file header, so the grid can reserve space
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
