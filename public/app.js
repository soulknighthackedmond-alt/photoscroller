'use strict';

/* Photoscroller viewer: endless vertical feed + album list. */

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
const footerEl = $('#feedFooter');

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

/* prefetch the next page before the user reaches the bottom */
feedEl.addEventListener('scroll', () => {
  const nearEnd = feedEl.scrollTop + feedEl.clientHeight * 2.2 >= feedEl.scrollHeight;
  if (nearEnd) loadMore();
  updateHud();
});

function updateHud() {
  if (!state.photos.length) {
    hudEl.classList.add('hidden');
    return;
  }
  const idx = Math.min(currentIndex() + 1, state.photos.length);
  hudEl.textContent = `${idx} / ${state.total || state.photos.length} · scroll, or use ↑ ↓`;
  hudEl.classList.remove('hidden');
}

function currentIndex() {
  const h = feedEl.clientHeight || 1;
  return Math.round(feedEl.scrollTop / h);
}

function scrollToIndex(i) {
  const items = feedEl.querySelectorAll('.item');
  if (!items.length) return;
  const target = Math.max(0, Math.min(i, items.length - 1));
  items[target].scrollIntoView({ behavior: 'smooth', block: 'start' });
}

document.addEventListener('keydown', (e) => {
  if ($('#zoom').classList.contains('hidden') === false) {
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

function openZoom(photo) {
  const zoom = $('#zoom');
  $('#zoomImg').src = photo.url.replace('/i/', '/i/');
  zoom.classList.remove('hidden');
  $('#zoomImg').onclick = closeZoom;
}
function closeZoom() {
  $('#zoom').classList.add('hidden');
  $('#zoomImg').src = '';
}
$('#zoomClose').addEventListener('click', closeZoom);

/* ---------------- boot ---------------- */

$('#shuffleBtn').addEventListener('click', () => {
  state.seed = Math.floor(Math.random() * 1e9);
  state.album = null;
  feedEl.innerHTML = '';
  state.offset = 0;
  state.total = 0;
  state.done = false;
  const r = route();
  startFeed(r.album || null);
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
