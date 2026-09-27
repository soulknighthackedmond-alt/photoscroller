'use strict';

/* Photoscroller viewer: endless vertical feed + album list.

   Mobile: the feed is driven by the browser's own scroll-snap — a swipe IS a
   scroll — so there are no custom swipe handlers to fight the browser. What a
   phone does need, and what this file adds: a touch-aware HUD hint, a caption
   that stays visible without hover (CSS), tap-to-zoom with swipe-down-to-close,
   and a re-snap to the same photo after rotating or resizing the screen. */

const isTouch =
  (typeof window.matchMedia === 'function' &&
    window.matchMedia('(hover: none), (pointer: coarse)').matches) ||
  (navigator.maxTouchPoints || 0) > 0;

document.documentElement.classList.toggle('is-touch', isTouch);
document.documentElement.classList.toggle('is-hover', !isTouch);

const state = {
  albums: [],
  photos: [],
  offset: 0,
  limit: 12,
  total: 0,
  album: null,
  seed: Math.floor(Math.random() * 1e9),
  loading: false,
  done: false,
};

const $ = (sel) => document.querySelector(sel);
const feedEl = $('#feed');
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
  if (!res.ok) throw new Error('request failed: ' + res.status);
  return res.json();
}

/* ---------------- routing ---------------- */

function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const parts = hash.split('/').filter(Boolean);
  if (parts[0] === 'albums') return { view: 'albums' };
  if (parts[0] === 'a' && parts[1]) return { view: 'feed', album: decodeURIComponent(parts[1]) };
  return { view: 'feed', album: null };
}

async function render() {
  const r = route();
  const albumsView = $('#albumsView');
  const feedView = $('#feedView');

  if (r.view === 'albums') {
    feedView.classList.add('hidden');
    albumsView.classList.remove('hidden');
    await renderAlbums();
  } else {
    albumsView.classList.add('hidden');
    feedView.classList.remove('hidden');
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
    grid.innerHTML = '<p class="muted">Nothing uploaded yet. <a href="/admin">Upload a folder</a> to get started.</p>';
    return;
  }
  for (const a of state.albums) {
    const card = document.createElement('a');
    card.className = 'album-card';
    card.href = '#/a/' + encodeURIComponent(a.slug);
    card.innerHTML =
      `<div class="thumb" style="background-image:url('${esc(a.cover)}')"></div>` +
      `<div class="info"><strong>${esc(a.name)}</strong><span>${a.count}</span></div>`;
    grid.appendChild(card);
  }
}

/* ---------------- feed ---------------- */

async function startFeed(album) {
  if (state.album === album && feedEl.children.length) {
    feedEl.scrollTop = 0;
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
  feedEl.scrollTop = 0;
  await loadMore();
  updateHud();
}

async function loadMore() {
  if (state.loading || state.done) return;
  state.loading = true;
  try {
    const params = new URLSearchParams({
      offset: String(state.offset),
      limit: String(state.limit),
      order: 'shuffle',
      seed: String(state.seed),
    });
    if (state.album) params.set('album', state.album);
    const data = await api('/api/feed?' + params.toString());
    state.total = data.total;
    state.photos.push(...data.photos);
    state.offset += data.photos.length;
    if (!data.photos.length || state.offset >= data.total) state.done = true;
    appendPhotos(data.photos);
    $('#feedEmpty').classList.toggle('hidden', state.total > 0);
  } catch (err) {
    console.error(err);
  } finally {
    state.loading = false;
    updateHud();
  }
}

function appendPhotos(photos) {
  const frag = document.createDocumentFragment();
  for (const p of photos) {
    const item = document.createElement('figure');
    item.className = 'item';
    item.dataset.album = p.album;

    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = p.name;
    img.dataset.src = p.url;
    img.addEventListener('load', () => img.classList.add('loaded'));
    img.addEventListener('error', () => img.classList.add('loaded'));
    img.addEventListener('click', () => openZoom(p));

    const meta = document.createElement('figcaption');
    meta.className = 'meta';
    meta.innerHTML = `<b>${esc(albumName(p.album))}</b><span class="name">${esc(p.name)}</span>`;

    item.append(img, meta);
    frag.appendChild(item);
  }
  feedEl.appendChild(frag);
  hydrateImages();
}

/* only fetch images near the viewport */
let imgObserver = null;
function hydrateImages() {
  if (!imgObserver) {
    imgObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const img = entry.target;
          if (img.dataset.src && !img.src) img.src = img.dataset.src;
          imgObserver.unobserve(img);
        }
      },
      { root: feedEl, rootMargin: '150% 0px' }
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
feedEl.addEventListener(
  'scroll',
  () => {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => {
      scrollQueued = false;
      if (feedEl.scrollTop + feedEl.clientHeight * 2.2 >= feedEl.scrollHeight) loadMore();
      updateHud();
    });
  },
  { passive: true }
);

function updateHud() {
  if (!state.photos.length) {
    hudEl.classList.add('hidden');
    return;
  }
  const idx = Math.min(currentIndex() + 1, state.photos.length);
  const total = state.total || state.photos.length;
  hudEl.textContent = isTouch ? `${idx} / ${total} · swipe up` : `${idx} / ${total} · scroll, or use ↑ ↓`;
  hudEl.classList.remove('hidden');
}

function currentIndex() {
  const first = feedEl.querySelector('.item');
  const h = (first && first.offsetHeight) || feedEl.clientHeight || 1;
  return Math.round(feedEl.scrollTop / h);
}

/* Snapping by index rather than scrollIntoView keeps the scroll container the
   feed itself — on iOS scrollIntoView can walk up and move the page instead. */
function scrollToIndex(i, smooth = true) {
  const items = feedEl.querySelectorAll('.item');
  if (!items.length) return;
  const target = Math.max(0, Math.min(i, items.length - 1));
  const top = target * items[0].offsetHeight;
  if (smooth) feedEl.scrollTo({ top, behavior: 'smooth' });
  else feedEl.scrollTop = top;
}

document.addEventListener('keydown', (e) => {
  if (!zoomEl.classList.contains('hidden')) {
    if (e.key === 'Escape') closeZoom();
    return;
  }
  const r = route();
  if (r.view !== 'feed') return;
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
  } else if (e.key === 'o' || e.key === 'Enter') {
    const p = state.photos[currentIndex()];
    if (p) openZoom(p);
  }
});

/* ---------------- zoom ---------------- */

/* One tap fits the photo to the screen, another tap shows it at full size; the
   backdrop, the Close button, Esc or a swipe down dismisses it. No tap timers,
   so a tap never has to wait to find out whether a second one is coming. */
function openZoom(photo) {
  zoomImg.src = photo.url;
  zoomImg.alt = photo.name;
  setZoomScale('fit');
  zoomEl.classList.remove('hidden');
  $('#zoomHint').textContent = isTouch
    ? 'Tap the photo to zoom in · swipe down to close'
    : 'Click the photo to zoom in · Esc to close';
}

function closeZoom() {
  zoomEl.classList.add('hidden');
  zoomEl.classList.remove('actual');
  zoomImg.classList.remove('actual');
  zoomImg.removeAttribute('src');
}

function setZoomScale(mode) {
  const actual = mode === 'actual';
  zoomEl.classList.toggle('actual', actual);
  zoomImg.classList.toggle('actual', actual);
  if (actual) {
    requestAnimationFrame(() => {
      zoomEl.scrollLeft = Math.max(0, (zoomImg.offsetWidth - zoomEl.clientWidth) / 2);
      zoomEl.scrollTop = Math.max(0, (zoomImg.offsetHeight - zoomEl.clientHeight) / 2);
    });
  } else {
    zoomEl.scrollTop = 0;
    zoomEl.scrollLeft = 0;
  }
}

zoomImg.addEventListener('click', () => {
  setZoomScale(zoomEl.classList.contains('actual') ? 'fit' : 'actual');
});
zoomEl.addEventListener('click', (e) => {
  if (e.target === zoomEl) closeZoom();
});
$('#zoomClose').addEventListener('click', closeZoom);

/* swipe down to dismiss — only while the photo fits; at full size the overlay is
   a scroll surface, so a drag has to pan it instead */
let zoomTouchY = null;
zoomEl.addEventListener(
  'touchstart',
  (e) => {
    zoomTouchY = zoomEl.classList.contains('actual') ? null : e.touches[0].clientY;
  },
  { passive: true }
);
zoomEl.addEventListener(
  'touchmove',
  (e) => {
    if (zoomTouchY === null) return;
    if (e.touches[0].clientY - zoomTouchY > 70) {
      zoomTouchY = null;
      closeZoom();
    }
  },
  { passive: true }
);
zoomEl.addEventListener('touchend', () => { zoomTouchY = null; }, { passive: true });

/* ---------------- rotation / resize ---------------- */

/* A photo is exactly one viewport tall, so rotating the phone (or the mobile URL
   bar changing height) moves the snap point — put the same photo back. */
let resizeTimer = null;
function resnap() {
  if (route().view !== 'feed') return;
  scrollToIndex(currentIndex(), false);
  updateHud();
}
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(resnap, 180);
});
window.addEventListener('orientationchange', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(resnap, 320);
});

/* ---------------- boot ---------------- */

$('#shuffleBtn').addEventListener('click', () => {
  state.seed = Math.floor(Math.random() * 1e9);
  state.album = null;
  state.photos = [];
  feedEl.innerHTML = '';
  state.offset = 0;
  state.total = 0;
  state.done = false;
  state.loading = false;
  startFeed(route().album || null);
});

window.addEventListener('hashchange', render);

(async function boot() {
  try {
    const data = await api('/api/albums');
    state.albums = data.albums;
  } catch (err) {
    console.error(err);
  }
  await render();
})();
