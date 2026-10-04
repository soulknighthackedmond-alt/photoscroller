'use strict';

/* Photoscroller viewer: endless vertical feed + album list.

   Mobile: the PAGE is the scroller and the feed is driven by the browser's own
   scroll-snap — a swipe IS a scroll — so there are no custom swipe handlers to fight
   the browser, and iOS Safari collapses its address bar as you swipe, the way it does
   on rule34.pw. What a phone does need, and what this file adds: a touch-aware HUD
   hint, a caption that stays visible without hover (CSS), tap-to-zoom with
   swipe-down-to-close, and a re-snap to the same photo after rotating or resizing. */

const isTouch =
  (typeof window.matchMedia === 'function' &&
    window.matchMedia('(hover: none), (pointer: coarse)').matches) ||
  (navigator.maxTouchPoints || 0) > 0;

document.documentElement.classList.toggle('is-touch', isTouch);
document.documentElement.classList.toggle('is-hover', !isTouch);

const state = {
  albums: [],
  storage: null,
  photos: [],
  offset: 0,
  limit: 12,
  total: 0,
  album: null,
  /* 'upload' keeps the order the photos were uploaded in; 'shuffle' is the explicit
     "surprise me" mode. Restored from localStorage on boot. */
  order: 'upload',
  seed: Math.floor(Math.random() * 1e9),
  loading: false,
  done: false,
  /* 'grid' is the thumbnail wall (the default, and the Scrolller/rule34 feel);
     'feed' is one photo per screen. Restored from localStorage on boot. */
  layout: 'grid',
};

const $ = (sel) => document.querySelector(sel);
const feedEl = $('#feed');

/* ---------------- the scroller ----------------

   The PAGE scrolls, not a box inside it. The feed used to be its own scroller
   (`height: 100%; overflow-y: auto`), which makes the app a window inside a window:
   iOS Safari keeps its address bar on screen for an inner scroller, so the app never
   felt like a page and every photo lost a strip of height. The document scrolls now,
   exactly as rule34.pw's does, so every read and write of the scroll position goes
   through the five helpers below — nothing else in this file touches scrollTop. */

const topbarEl = document.querySelector('.topbar');

const scrollYNow = () => window.scrollY || document.documentElement.scrollTop || 0;
const viewportH = () => document.documentElement.clientHeight || window.innerHeight || 0;
const pageH = () => document.documentElement.scrollHeight;

function scrollToY(y, smooth = false) {
  const top = Math.max(0, Math.round(y));
  if (smooth) window.scrollTo({ top, behavior: 'smooth' });
  else window.scrollTo(0, top);
}
const scrollToTop = (smooth = false) => scrollToY(0, smooth);

/* One photo per screen in feed mode is a measured number: the visible height minus
   the sticky bar. That is also exactly what the snapport is (html.snap-feed's
   scroll-padding-top), so a snapped photo fills the screen instead of sitting under
   the bar or leaving a sliver of the next one. */
function screenH() {
  const bar = topbarEl ? topbarEl.offsetHeight : 0;
  return Math.max(120, viewportH() - bar);
}

/* Snapping belongs to the root scroller now, and only in feed mode: the grid must
   never snap, or a flick of the thumb gets pulled to a stop at every tile. */
function syncSnap(r = route()) {
  const on = r.view === 'feed' && !gridMode();
  document.documentElement.classList.toggle('snap-feed', on);
}
const chipsEl = $('#chips');
const hudEl = $('#hud');
const zoomEl = $('#zoom');
const zoomImg = $('#zoomImg');

/* Every value interpolated into innerHTML below goes through esc() first — album names come
   from the upload form, and photo names/urls are already restricted server-side to
   [a-zA-Z0-9._-]. Nothing unescaped ever reaches the DOM as markup. */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  /* the session can lapse while a tab sits open; send the browser to the form rather
     than showing an app that quietly loads nothing */
  if (res.status === 401) {
    location.replace('/login?next=' + encodeURIComponent(location.pathname + location.hash));
    throw new Error('password required');
  }
  if (!res.ok) throw new Error('request failed: ' + res.status);
  return res.json();
}

/* ---------------- storage problems ----------------

   A volume the app cannot write (typically /data not mounted, or owned by root)
   means there is genuinely nothing to show. Say so, with the fix, instead of the
   cheerful "No photos yet" that hides a broken deploy. */

const storageBroken = () => !!(state.storage && state.storage.ok === false);

function storageNoticeHtml() {
  const s = state.storage || {};
  /* Safe as markup: this is a fixed string plus esc()'d values — nothing the
     server sends reaches the DOM unescaped. */
  const detail = [s.error, s.path].filter(Boolean).map(esc).join(' · ');
  return (
    '<h2>Storage isn’t writable</h2>' +
    '<p>The app can’t read or save albums, so there is nothing to show. On Coolify, add a volume mounted at ' +
    '<code>/data</code>, set <code>DATA_DIR=/data</code>, and redeploy.</p>' +
    (detail ? '<p class="muted">' + detail + '</p>' : '')
  );
}

/* ---------------- routing ---------------- */

function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const parts = hash.split('/').filter(Boolean);
  if (parts[0] === 'albums') return { view: 'albums' };
  if (parts[0] === 'a' && parts[1]) return { view: 'feed', album: decodeURIComponent(parts[1]) };
  /* No route at all - a first visit, a reload of the bare address, or the installed app
     opening at start_url - lands on the album list: picking an album is the useful first
     move, and the Everything feed is one chip away. An explicit "#/" is still the
     Everything feed, so that chip is not swallowed by this default. */
  if (!location.hash || location.hash === '#') return { view: 'albums' };
  return { view: 'feed', album: null };
}

async function render() {
  const r = route();
  const albumsView = $('#albumsView');
  const feedView = $('#feedView');

  /* The two views are pages of one document now, so a view change starts at the top:
     without this the album list would open part-way down the feed that was just left. */
  scrollToTop();
  syncSnap(r);

  if (r.view === 'albums') {
    feedView.classList.add('hidden');
    albumsView.classList.remove('hidden');
    await renderAlbums();
  } else {
    albumsView.classList.add('hidden');
    feedView.classList.remove('hidden');
    /* the feed is display:none until now, so its height could only be measured here */
    syncScreen();
    await startFeed(r.album);
  }
  renderChips(r);
}

function renderChips(r) {
  chipsEl.querySelectorAll('.chip[data-album]').forEach((el) => el.remove());
  for (const a of state.albums) {
    const el = document.createElement('a');
    el.className = 'chip';
    el.dataset.album = a.slug;
    el.href = '#/a/' + encodeURIComponent(a.slug);
    /* safe: esc() escapes & < > " ' in the album name, and count is a number the
       server computed from the directory listing */
    el.innerHTML = esc(a.name) + '<span class="n">' + a.count + '</span>';
    chipsEl.appendChild(el);
  }
  chipsEl.querySelectorAll('.chip').forEach((el) => {
    const isActive = r.view === 'albums' ? el.dataset.route === 'albums' : r.view === 'feed' && (el.dataset.album || null) === r.album;
    el.classList.toggle('active', isActive);
  });
}

/* ---------------- albums ---------------- */

async function renderAlbums() {
  const grid = $('#albums');
  const total = state.albums.reduce((n, a) => n + a.count, 0);
  $('#albumsSub').textContent = state.albums.length
    ? `${state.albums.length} album${state.albums.length === 1 ? '' : 's'} · ${total} photo${total === 1 ? '' : 's'}`
    : '';

  grid.innerHTML = '';
  if (!state.albums.length) {
    grid.innerHTML = storageBroken()
      ? storageNoticeHtml()
      : '<p class="muted">Nothing uploaded yet. <a href="/admin">Upload a folder</a> to get started.</p>';
    return;
  }
  for (const a of state.albums) {
    const card = document.createElement('a');
    card.className = 'album-card';
    card.href = '#/a/' + encodeURIComponent(a.slug);
    card.innerHTML =
      (a.coverKind === 'video'
        ? `<video class="thumb" muted playsinline preload="metadata" src="${esc(a.cover)}#t=0.001"></video>`
        : `<div class="thumb" style="background-image:url('${esc(a.cover)}')"></div>`) +
      `<div class="info"><strong>${esc(a.name)}</strong><span>${a.count}</span></div>`;
    grid.appendChild(card);
  }
}

/* ---------------- feed ---------------- */

async function startFeed(album) {
  /* "already showing" is state.photos, not feedEl.children: in grid mode the columns
     are children even when they hold nothing, so an empty album would never load */
  if (state.album === album && state.photos.length) {
    scrollToTop();
    updateHud();
    return;
  }
  state.album = album;
  state.photos = [];
  state.offset = 0;
  state.total = 0;
  state.done = false;
  state.loading = false;
  feedEl.innerHTML = '';
  scrollToTop();
  captionIndex = -1;
  if (gridMode()) buildColumns(true);
  await loadMore();
  updateHud();
}

async function loadMore() {
  if (state.loading || state.done) return;
  state.loading = true;
  try {
    const params = new URLSearchParams({
      offset: String(state.offset),
      /* the grid wants more per page than the feed: twelve full screens is a lot of
         scrolling, twelve thumbnails is one row and a bit */
      limit: String(gridMode() ? GRID_PAGE : state.limit),
      order: state.order,
    });
    /* only a shuffle needs the seed: it keeps paging stable instead of repeating photos */
    if (state.order === 'shuffle') params.set('seed', String(state.seed));
    if (state.album) params.set('album', state.album);
    const data = await api('/api/feed?' + params.toString());
    state.total = data.total;
    state.photos.push(...data.photos);
    state.offset += data.photos.length;
    if (!data.photos.length || state.offset >= data.total) state.done = true;
    appendPhotos(data.photos);
    const empty = $('#feedEmpty');
    if (storageBroken()) {
      empty.innerHTML = storageNoticeHtml();
      empty.classList.remove('hidden');
    } else {
      empty.classList.toggle('hidden', state.total > 0);
    }
  } catch (err) {
    console.error(err);
  } finally {
    state.loading = false;
    updateHud();
  }
}

function appendPhotos(photos) {
  if (gridMode()) return appendToGrid(photos);
  const frag = document.createDocumentFragment();
  for (const p of photos) {
    const item = document.createElement('figure');
    item.className = 'item';
    item.dataset.album = p.album;

    let el;
    if (p.kind === 'video') {
      /* In the feed a video is already one per screen, so there is nothing to open:
         it plays in place, with its own controls, and the first tap only reveals it
         when blur mode has hidden it. */
      el = document.createElement('video');
      el.controls = true;
      el.playsInline = true;
      el.setAttribute('playsinline', '');
      el.preload = 'metadata';
      el.dataset.src = p.url + '#t=0.001';
      el.addEventListener('loadedmetadata', () => el.classList.add('loaded'));
      el.addEventListener('error', () => el.classList.add('loaded'));
      lazyMedia(el);
      item.classList.add('video');
      el.addEventListener('click', () => {
        if (blurOn() && !item.classList.contains('revealed')) item.classList.add('revealed');
      });
    } else {
      el = document.createElement('img');
      el.loading = 'lazy';
      el.decoding = 'async';
      el.alt = p.name;
      el.dataset.src = p.url;
      el.addEventListener('load', () => el.classList.add('loaded'));
      el.addEventListener('error', () => el.classList.add('loaded'));
      /* blurred: the first tap reveals this one photo; only a revealed photo opens in the
         zoom overlay, so a blurred picture can never be seen sharp by accident */
      el.addEventListener('click', () => {
        if (blurOn() && !item.classList.contains('revealed')) {
          item.classList.add('revealed');
          return;
        }
        openZoom(p);
      });
    }

    const meta = document.createElement('figcaption');
    meta.className = 'meta';
    meta.innerHTML = `<b>${esc(albumName(p.album))}</b><span class="name">${esc(p.name)}</span>`;

    item.append(el, meta);
    frag.appendChild(item);
  }
  feedEl.appendChild(frag);
  hydrateImages();
}

/* ---------------- the grid (masonry) ----------------

   Scrolller / rule34-scroller behaviour: thumbnails in columns, endless, and no
   snapping. Each photo goes into whichever column is currently shortest, which is what
   keeps the bottom edge even — and the height each one contributes comes from the file
   header the feed API sends (lib/dims.js), so the space is reserved before the photo
   arrives and the columns never jump. */

const LAYOUT_KEY = 'ps-layout';
const GRID_PAGE = 40; /* photos per request in grid mode */

const grid = { cols: [], heights: [] };

const gridMode = () => document.documentElement.classList.contains('grid-mode');

/* Columns by width — and these are rule34.pw's own breakpoints, taken from its
   stylesheet rather than guessed at: ONE full-width column on a phone, two from 768px,
   three from 1024px. A phone gets a single column because that is what the site this is
   modelled on does, and it is the better read anyway: the photo is as wide as the screen
   and you scroll past it, instead of two thumbnails you have to squint at. */
function gridColumnCount() {
  const w = feedEl.clientWidth || window.innerWidth || 390;
  if (w < 768) return 1;
  if (w < 1024) return 2;
  return 3;
}

function buildColumns(force) {
  const n = gridColumnCount();
  if (!force && grid.cols.length === n) return;
  feedEl.classList.add('grid');
  feedEl.innerHTML = '';
  grid.cols = [];
  grid.heights = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const col = document.createElement('div');
    col.className = 'gcol';
    feedEl.appendChild(col);
    grid.cols.push(col);
  }
}

/* The shortest column wins, measured in units of column width — so the comparison still
   holds whether the number came from a file header or from a measured element. */
function shortestColumn() {
  let best = 0;
  for (let i = 1; i < grid.heights.length; i++) {
    if (grid.heights[i] < grid.heights[best]) best = i;
  }
  return best;
}

function rebuildHeights() {
  const unit = (grid.cols[0] && grid.cols[0].clientWidth) || 1;
  grid.cols.forEach((col, i) => {
    grid.heights[i] = col.offsetHeight / unit;
  });
}

function appendToGrid(photos) {
/* A grid of forty videos must not be forty downloads: a <video> has no loading="lazy",
   so its source is only handed over once the tile comes near the viewport. */
const lazyMedia = (() => {
  if (typeof IntersectionObserver !== 'function') {
    return (el) => { if (el.dataset.src) el.src = el.dataset.src; };
  }
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target;
      io.unobserve(el);
      if (el.dataset.src) el.src = el.dataset.src;
    }
  }, { rootMargin: '1200px 0px' });
  return (el) => io.observe(el);
})();

  if (!grid.cols.length) buildColumns(true);
  for (const p of photos) {
    const known = !!(p.w && p.h);
    const isVid = p.kind === 'video';
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'tile';
    tile.dataset.album = p.album;
    tile.style.aspectRatio = known ? p.w + ' / ' + p.h : (isVid ? '16 / 9' : '4 / 3');
    tile.title = albumName(p.album) + ' · ' + p.name;

    let el;
    if (isVid) {
      /* A video tile is the video's own first frame: there is no thumbnail to make,
         so the browser is asked for the frame at 0.001s — without that fragment an
         iOS <video> sits there as a black rectangle. Muted and never autoplaying: a
         wall of forty autoplaying videos is a data bill, not a gallery. */
      el = document.createElement('video');
      el.muted = true;
      el.loop = true;
      el.playsInline = true;
      el.setAttribute('playsinline', '');
      el.setAttribute('muted', '');
      el.preload = 'metadata';
      el.dataset.src = p.url + '#t=0.001';
      tile.classList.add('video');
      lazyMedia(el);
      el.addEventListener('loadedmetadata', () => {
        tile.classList.add('loaded');
        if (!known && el.videoWidth && el.videoHeight) {
          tile.style.aspectRatio = el.videoWidth + ' / ' + el.videoHeight;
          rebuildHeights();
        }
      });
      el.addEventListener('error', () => tile.classList.add('loaded'));
    } else {
      el = document.createElement('img');
      el.loading = 'lazy';
      el.decoding = 'async';
      el.alt = p.name;
      el.src = p.url;
      el.addEventListener('load', () => {
        tile.classList.add('loaded');
        /* a photo whose header could not be read still gets its true shape — it just
           corrects itself a moment later instead of reserving the space up front */
        if (!known && el.naturalWidth && el.naturalHeight) {
          tile.style.aspectRatio = el.naturalWidth + ' / ' + el.naturalHeight;
          rebuildHeights();
        }
      });
      el.addEventListener('error', () => tile.classList.add('loaded'));
    }

    /* the same rule as the feed: a blurred thumbnail is revealed by the first tap, and
       only a revealed one opens in the zoom overlay */
    tile.addEventListener('click', () => {
      if (blurOn() && !tile.classList.contains('revealed')) {
        tile.classList.add('revealed');
        return;
      }
      openZoom(p);
    });

    tile.appendChild(el);
    const col = shortestColumn();
    grid.cols[col].appendChild(tile);
    grid.heights[col] += known ? p.h / p.w : 0.75;
  }
  rebuildHeights();
}

/* A different column count means every photo has to be placed again — from the list the
   viewer already holds, so nothing is fetched twice. */
function relayoutGrid() {
  const photos = state.photos.slice();
  buildColumns(true);
  appendToGrid(photos);
}

/* ---------------- grid / feed ---------------- */

const layoutBtn = $('#layoutBtn');

function applyLayout(mode, save = true) {
  const want = mode === 'grid';
  document.documentElement.classList.toggle('grid-mode', want);
  feedEl.classList.toggle('grid', want);
  state.layout = want ? 'grid' : 'feed';
  syncSnap();
  if (layoutBtn) {
    layoutBtn.textContent = want ? 'Grid' : 'Feed';
    layoutBtn.setAttribute('aria-pressed', want ? 'true' : 'false');
    layoutBtn.title = want
      ? 'Thumbnails in columns, endless — tap for one photo per screen'
      : 'One photo per screen — tap for the thumbnail grid';
  }
  if (save) {
    try {
      localStorage.setItem(LAYOUT_KEY, state.layout);
    } catch {
      /* private mode: the setting just doesn't survive the visit */
    }
  }
}

/* Switching layout throws the feed away and starts it again: the two modes build
   different DOM, and splicing one into the other mid-list would leave both on screen. */
function setLayout(mode) {
  applyLayout(mode);
  state.photos = [];
  state.offset = 0;
  state.total = 0;
  state.done = false;
  state.loading = false;
  feedEl.innerHTML = '';
  captionIndex = -1;
  grid.cols = [];
  grid.heights = [];
  if (route().view === 'feed') startFeed(state.album);
  else updateHud();
}

if (layoutBtn) layoutBtn.addEventListener('click', () => setLayout(gridMode() ? 'feed' : 'grid'));

/* only fetch images near the viewport */
let imgObserver = null;
function hydrateImages() {
  if (!imgObserver) {
    imgObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const img = entry.target;
          if (img.dataset.src && !img.src) {
            img.src = img.dataset.src;
            /* The letterbox backdrop is the same URL, so it costs no extra request.
               The path is server-generated (/i/<slug>/<file>) with both parts
               encodeURIComponent'd, so it cannot break out of the url() token. */
            const item = img.closest('.item');
            if (item) {
              item.style.setProperty('--bg', 'url("' + img.dataset.src + '")');
              item.classList.add('ready');
            }
          }
          imgObserver.unobserve(img);
        }
      },
      /* root: null is the viewport, which is the only scroller there is now */
      { root: null, rootMargin: '150% 0px' }
    );
  }
  feedEl.querySelectorAll('img[data-src]').forEach((img) => {
    if (img.src) return;
    imgObserver.observe(img);
  });
}

const albumName = (slug) => (state.albums.find((a) => a.slug === slug) || { name: slug }).name;

/* prefetch the next page before the user reaches the bottom.
   Throttled to one layout read per frame — a phone fires scroll at 60fps. */
let scrollQueued = false;
window.addEventListener(
  'scroll',
  () => {
    /* the album list is a different page of the same document: its scroll must not
       drive the feed */
    if (route().view !== 'feed') return;
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => {
      scrollQueued = false;
      if (scrollYNow() + viewportH() * 2.2 >= pageH()) loadMore();
      updateHud();
      refreshCaption();
    });
  },
  { passive: true }
);

function updateHud() {
  if (!state.photos.length) {
    hudEl.classList.add('hidden');
    return;
  }
  const total = state.total || state.photos.length;
  const how = blurOn() ? 'tap a photo to reveal it' : isTouch ? 'swipe up' : 'scroll, or use ↑ ↓';
  /* the grid has no "current" photo — you are looking at a dozen at once, so the count
     of what is loaded is the honest number */
  const idx = gridMode() ? state.photos.length : Math.min(currentIndex() + 1, state.photos.length);
  hudEl.textContent = `${idx} / ${total} · ${how}`;
  hudEl.classList.remove('hidden');
}

/* On a phone the caption sits on top of the photo, so it fades out a few seconds after
   a photo becomes current and comes back on the next one. */
let captionIndex = -1;
let captionTimer = null;
function refreshCaption() {
  /* the feed only: a grid thumbnail has no caption sitting on it to fade */
  if (!isTouch || gridMode()) return;
  const index = currentIndex();
  if (index === captionIndex) return;
  captionIndex = index;
  clearTimeout(captionTimer);
  feedEl.querySelectorAll('.item.dim').forEach((el) => el.classList.remove('dim'));
  const item = feedEl.querySelectorAll('.item')[index];
  if (!item) return;
  captionTimer = setTimeout(() => item.classList.add('dim'), 3000);
}

function currentIndex() {
  const first = feedEl.querySelector('.item');
  const h = (first && first.offsetHeight) || screenH() || 1;
  /* Photo i snaps at y = i * height: the snapport starts one bar below the top of the
     viewport and so does the first photo, so the two cancel out and this division is
     exact rather than approximate. */
  return Math.round(scrollYNow() / h);
}

/* Snapping by index rather than scrollIntoView keeps the landing position an exact
   multiple of the photo height — on iOS scrollIntoView can walk up and move the page
   in ways this file cannot see. */
function scrollToIndex(i, smooth = true) {
  const items = feedEl.querySelectorAll('.item');
  if (!items.length) return;
  const target = Math.max(0, Math.min(i, items.length - 1));
  scrollToY(target * items[0].offsetHeight, smooth);
}

document.addEventListener('keydown', (e) => {
  if (!zoomEl.classList.contains('hidden')) {
    if (e.key === 'Escape') closeZoom();
    else if (!videoMode() && (e.key === '+' || e.key === '=')) { e.preventDefault(); zoomAt(centre(), 1.25); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomAt(centre(), 1 / 1.25); }
    else if (e.key === '0') { e.preventDefault(); resetZoom(); }
    return;
  }
  const r = route();
  if (r.view !== 'feed') return;
  /* In the grid, the arrow keys, space, PageUp/Down and the wheel belong to the browser:
     hijacking them would make a scroller that cannot be scrolled. Only the toggles are
     ours, and 'g' switches back to the one-per-screen feed. */
  if (gridMode()) {
    if (e.key === 'b' || e.key === 'B') {
      e.preventDefault();
      setBlur(!blurOn());
    } else if (e.key === 's' || e.key === 'S') {
      e.preventDefault();
      setShuffle(!shuffleOn());
    } else if (e.key === 'g' || e.key === 'G') {
      e.preventDefault();
      setLayout('feed');
    }
    return;
  }
  if (['ArrowDown', 'j', 'PageDown'].includes(e.key)) {
    e.preventDefault();
    scrollToIndex(currentIndex() + 1);
  } else if (['ArrowUp', 'k', 'PageUp'].includes(e.key)) {
    e.preventDefault();
    scrollToIndex(currentIndex() - 1);
  } else if (e.key === ' ') {
    e.preventDefault();
    scrollToIndex(currentIndex() + (e.shiftKey ? -1 : 1));
  } else if (e.key === 'Home') {
    e.preventDefault();
    scrollToIndex(0);
  } else if (e.key === 'b' || e.key === 'B') {
    e.preventDefault();
    setBlur(!blurOn());
  } else if (e.key === 'f' || e.key === 'F') {
    e.preventDefault();
    setMode(fillOn() ? 'fit' : 'fill');
  } else if (e.key === 's' || e.key === 'S') {
    e.preventDefault();
    setShuffle(!shuffleOn());
  } else if (e.key === 'g' || e.key === 'G') {
    e.preventDefault();
    setLayout('grid');
  } else if (e.key === 'o' || e.key === 'Enter') {
    const p = state.photos[currentIndex()];
    if (p) openZoom(p);
  }
});

/* ---------------- blur thumbnails ----------------

   An opt-in privacy screen: every thumbnail is blurred, and one tap reveals the photo
   you are looking at. The choice is remembered across visits. */

const BLUR_KEY = 'ps-blur';

const blurOn = () => document.documentElement.classList.contains('blur-thumbs');

function setBlur(on, save = true) {
  document.documentElement.classList.toggle('blur-thumbs', on);
  const btn = $('#blurBtn');
  if (btn) {
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.title = on ? 'Stop blurring thumbnails' : 'Blur all thumbnails';
  }
  /* switching it on re-hides anything already revealed */
  if (on) feedEl.querySelectorAll('.item.revealed, .tile.revealed').forEach((el) => el.classList.remove('revealed'));
  if (save) {
    try {
      localStorage.setItem(BLUR_KEY, on ? '1' : '0');
    } catch {
      /* private mode: the setting just doesn't survive the visit */
    }
  }
  updateHud();
}

$('#blurBtn').addEventListener('click', () => setBlur(!blurOn()));

/* ---------------- fit / fill ----------------

   How much of the screen a photo takes. 'fit' shows all of it, as large as the screen
   allows — on a portrait phone a 16:9 shot is only ever as wide as the screen, so about
   a third of its height. 'fill' covers the screen and crops the edges, which is the only
   way a landscape photo gets bigger on a portrait screen. Fill is the default — a 16:9
   photo shown whole on a portrait phone is a strip a quarter of the screen tall, which
   is not worth opening the app for — and the choice is remembered across visits. */

const MODE_KEY = 'ps-mode';

const fillOn = () => document.documentElement.classList.contains('fill-mode');

function setMode(mode, save = true) {
  const fill = mode === 'fill';
  document.documentElement.classList.toggle('fill-mode', fill);
  const btn = $('#modeBtn');
  if (btn) {
    btn.textContent = fill ? 'Fill' : 'Fit';
    btn.setAttribute('aria-pressed', fill ? 'true' : 'false');
    btn.title = fill
      ? 'Filling the screen, so the edges are cropped — tap for the whole photo'
      : 'Showing the whole photo — tap to fill the screen';
  }
  if (save) {
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      /* private mode: the setting just doesn't survive the visit */
    }
  }
}

$('#modeBtn').addEventListener('click', () => setMode(fillOn() ? 'fit' : 'fill'));

/* ---------------- zoom ----------------

   Accurate zooming. Pinch, drag, wheel, double-tap, the +/- buttons and the keyboard
   all move the same two numbers — a scale and a translate — through the pure functions
   in zoommath.js, so what is on screen is exactly what the arithmetic says.

   The photo is laid out at its "fit" size in pixels rather than with object-fit, so the
   <img> box IS the picture and a zoom can be anchored on any point of it. With
   object-fit the element box stays the size of the overlay while the picture floats
   inside it, so every anchor would land in the empty letterbox instead of on the photo.
   transform-origin is the element's centre, which is the overlay's centre, which is the
   C that zoommath.js works in. */

const ZM = window.ZoomMath;

/* The overlay shows a photo or a video, never both. index.html ships both elements;
   a page cached from a build older than this file has no #zoomVideo, and then
   everything below behaves exactly as it did before videos existed. */
const zoomVideo = $('#zoomVideo');
const videoMode = () => !!(zoomVideo && zoomEl.classList.contains('video'));
const MIN_SCALE = 1;      /* fit — the whole photo; the viewer never goes below it */
const MAX_SCALE = 8;
const DBL_TAP_SCALE = 2.5;
const SWIPE_CLOSE_PX = 70;
const TAP_MS = 320;       /* two taps closer together than this are one double tap */
const TAP_SLOP_PX = 12;   /* and a "tap" that travelled further than this was a drag */

/* the whole view state: one scale and one translate */
const view = { W: 0, H: 0, VW: 0, VH: 0, s: 1, t: { x: 0, y: 0 } };

const pointers = new Map();   /* live pointers, in overlay coordinates */
let pan = null;               /* the single-pointer drag in progress */
let pinch = null;             /* the two-pointer pinch in progress */
let lastTap = 0;
let lastTapAt = { x: 0, y: 0 };

const centre = () => ({ x: view.VW / 2, y: view.VH / 2 });
const zoomOpen = () => !zoomEl.classList.contains('hidden');
const listOf = () => Array.from(pointers.values());
const midOf = (l) => ({ x: (l[0].x + l[1].x) / 2, y: (l[0].y + l[1].y) / 2 });
const distOf = (l) => Math.hypot(l[0].x - l[1].x, l[0].y - l[1].y);
const localPoint = (e) => {
  const r = zoomEl.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
};

/* Lay the photo out at exactly its fit size, so the element box and the picture are
   the same rectangle. Runs when the photo decodes and whenever the overlay resizes. */
function layoutZoom() {
  view.VW = zoomEl.clientWidth || window.innerWidth || 0;
  view.VH = zoomEl.clientHeight || window.innerHeight || 0;
  const fit = ZM.fitSize(zoomImg.naturalWidth, zoomImg.naturalHeight, view.VW, view.VH);
  if (!fit.w || !fit.h) return false;
  view.W = fit.w;
  view.H = fit.h;
  zoomImg.style.width = fit.w + 'px';
  zoomImg.style.height = fit.h + 'px';
  return true;
}

function applyZoom() {
  zoomImg.style.transform =
    'translate(' + view.t.x + 'px, ' + view.t.y + 'px) scale(' + view.s + ')';
  const badge = $('#zoomScale');
  if (!badge) return;
  badge.textContent = Math.round(view.s * 100) + '%';
  /* the honest second number: how much of the photo's own pixels you are seeing */
  const natural = zoomImg.naturalWidth;
  badge.title = natural
    ? Math.round(((view.s * view.W) / natural) * 100) + '% of the photo\u2019s own pixels'
    : 'Tap to fit the whole photo';
}

/* The only place the scale changes: the point under the anchor stays under it. */
function setScale(s1, anchor) {
  const s = ZM.clampScale(s1, MIN_SCALE, MAX_SCALE);
  if (s === view.s) return;
  const t = ZM.zoomAbout(anchor, centre(), view.t, view.s, s);
  view.t = ZM.clampTranslate(t, s, view.W, view.H, view.VW, view.VH);
  view.s = s;
  applyZoom();
}

function resetZoom() {
  view.s = MIN_SCALE;
  view.t = { x: 0, y: 0 };
  applyZoom();
}

function zoomAt(anchor, factor) {
  setScale(view.s * factor, anchor);
}

/* Re-measure and re-clamp: after a rotation, a window resize, or the photo decoding. */
function refitZoom() {
  if (!zoomOpen()) return;
  if (!layoutZoom()) return;
  view.t = ZM.clampTranslate(view.t, view.s, view.W, view.H, view.VW, view.VH);
  applyZoom();
}

/* The overlay covers the page, but a pinch that slips off the photo would still
   scroll the document behind it, so the root is locked while it is open. */
let lockedY = 0;
function lockScroll(on) {
  if (on) lockedY = scrollYNow();
  document.documentElement.classList.toggle('zoom-open', on);
  /* a browser that drops the scroll position when the root stops scrolling gets it
     back here, so closing the overlay never lands you somewhere else */
  if (!on && Math.abs(scrollYNow() - lockedY) > 1) scrollToY(lockedY);
}

function openZoom(photo) {
  const isVid = photo.kind === 'video' && !!zoomVideo;
  /* the class is what turns the overlay's zoom gestures off and hides the +/-
     buttons: a video has its own controls, and a pinch over them fights them */
  zoomEl.classList.toggle('video', isVid);
  lockScroll(true);
  /* un-hide before measuring: a display:none overlay has no client size */
  zoomEl.classList.remove('hidden');
  zoomImg.style.transform = '';
  zoomImg.style.width = '';
  zoomImg.style.height = '';
  view.s = MIN_SCALE;
  view.t = { x: 0, y: 0 };
  zoomImg.alt = photo.name;
  zoomImg.src = photo.url;
  if (isVid) {
    zoomImg.removeAttribute('src');
    zoomImg.classList.add('hidden');
    zoomVideo.classList.remove('hidden');
    zoomVideo.src = photo.url;
    /* this runs inside the tap that opened it, so iOS lets it play unprompted */
    const started = zoomVideo.play();
    if (started && started.catch) started.catch(() => {});
  } else if (zoomVideo) {
    zoomVideo.pause();
    zoomVideo.removeAttribute('src');
    zoomVideo.classList.add('hidden');
    zoomImg.classList.remove('hidden');
  }
  $('#zoomHint').textContent = isTouch
    ? 'Pinch or double-tap to zoom · drag to pan · swipe down to close'
    : 'Scroll or double-click to zoom · drag to pan · Esc to close';
  if (isVid) $('#zoomHint').textContent = 'Playing with its own controls \u00b7 tap Close or swipe down to dismiss';
  /* a cached photo is already decoded, so measure now; a new one fires load */
  if (zoomImg.complete && zoomImg.naturalWidth) refitZoom();
}

function closeZoom() {
  zoomEl.classList.remove('video');
  /* stop it before hiding it: a video left playing behind a hidden overlay keeps
     its audio running */
  if (zoomVideo) {
    zoomVideo.pause();
    zoomVideo.removeAttribute('src');
    zoomVideo.classList.add('hidden');
  }
  zoomImg.classList.remove('hidden');
  zoomEl.classList.add('hidden');
  lockScroll(false);
  zoomImg.style.transform = '';
  zoomImg.style.width = '';
  zoomImg.style.height = '';
  zoomImg.removeAttribute('src');
  pointers.clear();
  pan = null;
  pinch = null;
  lastTap = 0;
}

zoomImg.addEventListener('load', refitZoom);

/* ---------------- zoom gestures ----------------

   Pointer events cover touch, pen and mouse in one path, so there is no separate
   touch handler to fall out of step with the mouse one. Two fingers pinch about their
   midpoint; one finger (or the mouse) drags; a wheel zooms about the cursor; two quick
   taps zoom about the tap. touch-action: none on the overlay means the browser hands
   the whole gesture over instead of scrolling or page-zooming behind it. */

zoomEl.addEventListener('pointerdown', (e) => {
  if (e.target.closest && e.target.closest('.zoom-ui')) return;   /* buttons are their own */
  /* a video plays with its own controls: no pan, no pinch, no tap-to-zoom over them */
  if (videoMode()) return;
  pointers.set(e.pointerId, localPoint(e));
  if (zoomEl.setPointerCapture) {
    try {
      zoomEl.setPointerCapture(e.pointerId);
    } catch {
      /* a pointer that already went away is not worth an error */
    }
  }
  const l = listOf();
  if (l.length >= 2) {
    pinch = { d: distOf(l), mid: midOf(l), t0: { x: view.t.x, y: view.t.y }, s0: view.s };
    pan = null;
  } else {
    pinch = null;
    pan = {
      id: e.pointerId,
      start: l[0],
      last: l[0],
      t0: { x: view.t.x, y: view.t.y },
      moved: 0,
      at: Date.now(),
    };
  }
});

zoomEl.addEventListener('pointermove', (e) => {
  if (videoMode()) return;
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, localPoint(e));
  const l = listOf();

  if (pinch && l.length >= 2) {
    const s = ZM.clampScale(pinch.s0 * (distOf(l) / pinch.d), MIN_SCALE, MAX_SCALE);
    const t = ZM.pinchAbout(pinch.mid, midOf(l), centre(), pinch.t0, pinch.s0, s);
    view.s = s;
    view.t = ZM.clampTranslate(t, s, view.W, view.H, view.VW, view.VH);
    applyZoom();
    return;
  }

  if (pan && e.pointerId === pan.id) {
    const p = l[0];
    pan.last = p;
    const dx = p.x - pan.start.x;
    const dy = p.y - pan.start.y;
    pan.moved = Math.max(pan.moved, Math.hypot(dx, dy));
    if (view.s <= MIN_SCALE + 1e-6) {
      /* at fit size there is nothing to pan, so a downward drag is the swipe-to-close
         gesture — and it moves, so the gesture has feedback */
      view.s = MIN_SCALE;
      view.t = { x: 0, y: dy > 0 ? dy : 0 };
      applyZoom();
      return;
    }
    view.t = ZM.clampTranslate(
      { x: pan.t0.x + dx, y: pan.t0.y + dy },
      view.s, view.W, view.H, view.VW, view.VH
    );
    applyZoom();
  }
});

function endPointer(e) {
  if (videoMode()) return;
  if (!pointers.delete(e.pointerId)) return;
  const l = listOf();
  if (l.length < 2) pinch = null;
  if (l.length === 1) {
    /* a finger left after a pinch: keep dragging from where it is, and never treat
       what is left of that gesture as a tap */
    pan = {
      id: Array.from(pointers.keys())[0],
      start: l[0],
      last: l[0],
      t0: { x: view.t.x, y: view.t.y },
      moved: TAP_SLOP_PX + 1,
      at: Date.now(),
    };
    return;
  }
  if (l.length || !pan) return;

  const p = pan.last;
  const dy = p.y - pan.start.y;
  const quick = Date.now() - pan.at < TAP_MS;
  const still = pan.moved <= TAP_SLOP_PX;
  pan = null;

  if (view.s <= MIN_SCALE + 1e-6 && dy > SWIPE_CLOSE_PX) {
    closeZoom();
    return;
  }
  if (still && quick) {
    handleTap(p);
    return;
  }
  /* a short drag at fit size springs back to the centre */
  if (view.s <= MIN_SCALE + 1e-6 && view.t.y !== 0) resetZoom();
}

zoomEl.addEventListener('pointerup', endPointer);
zoomEl.addEventListener('pointercancel', endPointer);

/* double-tap: in to 2.5x about the tap, and back out again if already zoomed */
function handleTap(p) {
  const now = Date.now();
  if (now - lastTap < TAP_MS && Math.hypot(p.x - lastTapAt.x, p.y - lastTapAt.y) <= TAP_SLOP_PX * 2) {
    lastTap = 0;
    if (view.s > MIN_SCALE + 0.01) resetZoom();
    else setScale(DBL_TAP_SCALE, p);
    return;
  }
  lastTap = now;
  lastTapAt = p;
}

/* a trackpad pinch arrives as ctrl+wheel; deltaMode 1 is lines, 2 is pages */
zoomEl.addEventListener(
  'wheel',
  (e) => {
    if (!zoomOpen() || videoMode()) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? view.VH : 1;
    zoomAt(localPoint(e), Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.0015)));
  },
  { passive: false }
);

$('#zoomIn').addEventListener('click', () => zoomAt(centre(), 1.5));
$('#zoomOut').addEventListener('click', () => zoomAt(centre(), 1 / 1.5));
$('#zoomScale').addEventListener('click', resetZoom);
$('#zoomClose').addEventListener('click', closeZoom);
zoomEl.addEventListener('click', (e) => {
  if (e.target === zoomEl) closeZoom();
});

/* ---------------- screen height / rotation ---------------- */

/* One number decides how tall a photo's screen is: the measured visible height minus
   the measured height of the sticky bar. iOS Safari resolves 100svh and the visible
   viewport against different boxes, which made every item slightly taller than the
   area showing it — a sliver of the next photo, a clipped bottom edge and jittery
   mandatory snapping. */
function syncScreen() {
  const root = document.documentElement;
  const appH = viewportH();
  if (appH) root.style.setProperty('--app-h', appH + 'px');
  const screen = screenH();
  if (appH) root.style.setProperty('--screen', screen + 'px');
}

/* Rotating the phone, or the URL bar growing and shrinking, changes that height, so
   measure and then put the same photo back. The index is read BEFORE measuring:
   scrollTop is in pixels, and a pixel means a different photo once the screen changes
   height. */
let resizeTimer = null;
function resnap() {
  const inFeed = route().view === 'feed';
  /* the index is read BEFORE measuring: scrollTop is in pixels, and a pixel means a
     different photo once the screen changes height */
  const index = inFeed && !gridMode() ? currentIndex() : -1;
  syncScreen();
  if (inFeed && gridMode()) {
    /* a rotation changes how many columns fit, so every photo is placed again — and the
       scroll offset is carried over, so you stay roughly where you were */
    if (grid.cols.length !== gridColumnCount()) {
      const keep = scrollYNow();
      relayoutGrid();
      scrollToY(keep);
    }
    updateHud();
    return;
  }
  if (index < 0) return;
  scrollToIndex(index, false);
  updateHud();
}
function scheduleResnap(delay) {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    /* the overlay is sized in pixels too, so it has to be re-measured as well */
    refitZoom();
    resnap();
  }, delay);
}
window.addEventListener('resize', () => scheduleResnap(180));
window.addEventListener('orientationchange', () => scheduleResnap(320));
/* visualViewport is the most reliable signal for the iOS URL bar moving */
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => scheduleResnap(180));
}

/* ---------------- boot ---------------- */

const SHUFFLE_KEY = 'ps-shuffle';

const shuffleOn = () => state.order === 'shuffle';

function syncShuffleButton() {
  const btn = $('#shuffleBtn');
  if (!btn) return;
  const on = shuffleOn();
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.title = on ? 'Back to the order the photos were uploaded' : 'Reshuffle the feed';
}

/* Switching order rebuilds the feed from the top: paging with a different order
   part-way through would splice two orderings together. */
function setShuffle(on, save = true) {
  state.order = on ? 'shuffle' : 'upload';
  if (on) state.seed = Math.floor(Math.random() * 1e9);
  syncShuffleButton();
  if (save) {
    try {
      localStorage.setItem(SHUFFLE_KEY, on ? '1' : '0');
    } catch {
      /* private mode: the setting just doesn't survive the visit */
    }
  }
  state.photos = [];
  feedEl.innerHTML = '';
  state.offset = 0;
  state.total = 0;
  state.done = false;
  state.loading = false;
  captionIndex = -1;
  startFeed(route().album || null);
}

$('#shuffleBtn').addEventListener('click', () => {
  setShuffle(!shuffleOn());
  /* On the album list the feed is off screen, so a reshuffle would look like nothing
     happened: take the tap as "show me the feed". Inside an album the view stays put. */
  if (route().view === 'albums') location.hash = '#/';
});

window.addEventListener('hashchange', render);

/* The session cookie is what the server checks, so logging out is a request, not just a
   navigation — otherwise the browser would go back to a page it can still load. */
$('#logoutBtn').addEventListener('click', async () => {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } catch {
    /* offline: the cookie still expires on its own */
  }
  location.replace('/login');
});

(async function boot() {
  /* measure before the first photo is created, so the very first screen is right */
  syncScreen();
  try {
    setMode(localStorage.getItem(MODE_KEY) === 'fill' ? 'fill' : 'fit', false);
  } catch {
    /* private mode: the default is "fit" — the whole photo */
  }
  /* The grid is the default, and the class is already on <html> from the inline script
     in index.html; this only has to line the button and the state up with it. No reload
     here: render() below is what starts the feed, once the album list is in. */
  try {
    applyLayout(localStorage.getItem(LAYOUT_KEY) === 'feed' ? 'feed' : 'grid', false);
  } catch {
    /* private mode: the default is the grid */
  }
  try {
    /* fill is the default: on a portrait phone a 16:9 photo shown whole is only as wide
       as the screen, so "fit" is the strip you have to squint at */
    setMode(localStorage.getItem(MODE_KEY) === 'fit' ? 'fit' : 'fill', false);
  } catch {
    /* private mode: the default is "fill" */
  }
  try {
    state.order = localStorage.getItem(SHUFFLE_KEY) === '1' ? 'shuffle' : 'upload';
  } catch {
    /* private mode: the default is the order the photos were uploaded in */
  }
  syncShuffleButton();
  try {
    const data = await api('/api/albums');
    state.albums = data.albums;
    state.storage = data.storage || null;
  } catch (err) {
    console.error(err);
  }
  await render();
  syncScreen();
  syncSnap();
})();
