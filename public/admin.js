'use strict';

/* Photoscroller admin: password gate + folder upload + album management.

   Mobile: iOS — and some Android browsers — cannot pick a *folder*
   (webkitdirectory is a desktop feature), so this page also offers a plain
   multi-photo picker from the photo library. Because there is no folder name in
   that path, the album name comes from the field (pre-filled with a dated
   default). Uploads go up in batches, so a dropped mobile connection loses one
   batch instead of the whole album, and the files that are left stay selected so
   Upload can just be pressed again. Anything the server refuses (HEIC, oversized)
   is reported instead of silently saving fewer photos than were chosen. */

const $ = (s) => document.querySelector(s);
/* Album names/slugs are the only untrusted strings rendered here, and every one of them is
   passed through esc() before it lands in innerHTML — so the markup stays markup. */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const IMAGE_RE = /\.(jpe?g|png|gif|webp|avif|bmp)$/i;
/* a video is accepted on the same terms as a photo, with its own size ceiling */
const VIDEO_RE = /\.(mp4|m4v|mov|webm|ogv)$/i;
const MEDIA_RE = /\.(?:jpe?g|png|gif|webp|avif|bmp|mp4|m4v|mov|webm|ogv)$/i;
const isVideoName = (name) => VIDEO_RE.test(name);
const HEIC_RE = /\.(heic|heif)$/i;
const BATCH_SIZE = 20;

const isTouch =
  (typeof window.matchMedia === 'function' &&
    window.matchMedia('(hover: none), (pointer: coarse)').matches) ||
  (navigator.maxTouchPoints || 0) > 0;

document.documentElement.classList.toggle('is-touch', isTouch);
document.documentElement.classList.toggle('is-hover', !isTouch);

/* A browser that cannot do folders still has a perfectly good photo picker. */
const canPickFolder = 'webkitdirectory' in document.createElement('input');

let selected = [];
let folderName = '';
let idleInfo = 'or click to browse for a folder';
let limits = { maxFileMb: 40, maxVideoMb: 300, maxFiles: 500 };

function msg(el, text, kind, details) {
  const node = $(el);
  node.className = 'msg' + (kind ? ' ' + kind : '');
  node.textContent = text || '';
  if (details && details.length) {
    const ul = document.createElement('ul');
    for (const d of details) {
      const li = document.createElement('li');
      li.textContent = d; /* textContent: names come from the file picker */
      ul.appendChild(li);
    }
    node.appendChild(ul);
  }
}

const slugifyClient = (s) =>
  String(s)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'album';

function defaultAlbumName() {
  const d = new Date();
  return `Photos ${d.getDate()} ${d.toLocaleString(undefined, { month: 'short' })} ${d.getFullYear()}`;
}

const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

/* ---------------- copy that matches the device ---------------- */

function applyCopy() {
  if (!canPickFolder) {
    idleInfo = 'nothing selected yet';
    $('#dzTitle').textContent = 'Tap to choose photos';
    $('#dzInfo').textContent = idleInfo;
    $('#albumLabel').textContent = 'Album name';
    $('#lead').textContent = 'Choose photos from your library — the name you type becomes the album.';
    $('#pickFolderBtn').classList.add('hidden');
  } else if (isTouch) {
    $('#dzTitle').textContent = 'Tap to choose a folder or photos';
    $('#albumLabel').textContent = 'Album name (defaults to the folder name)';
    $('#lead').textContent = 'Pick a folder or some photos — the name becomes the album.';
  }
  $('#sizeHint').textContent =
    `Photos (jpg, png, gif, webp, avif, bmp) up to ${limits.maxFileMb} MB and videos ` +
    `(mp4, m4v, mov, webm, ogv) up to ${limits.maxVideoMb} MB, ` +
    `${limits.maxFiles} per upload.`;
}

/* ---------------- auth ---------------- */

async function checkSession() {
  const res = await fetch('/api/session', { headers: { accept: 'application/json' } });
  const data = await res.json();
  setAuthed(data.authed);
  return data.authed;
}

function setAuthed(authed) {
  $('#loginCard').classList.toggle('hidden', authed);
  $('#uploadCard').classList.toggle('hidden', !authed);
  $('#manageCard').classList.toggle('hidden', !authed);
  $('#logoutBtn').classList.toggle('hidden', !authed);
  if (authed) loadAlbums();
}

$('#loginBtn').addEventListener('click', doLogin);
$('#pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

async function doLogin() {
  const password = $('#pw').value;
  if (!password) return msg('#loginMsg', 'Enter the password.', 'err');
  msg('#loginMsg', 'Checking…', 'work');
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (res.ok) {
    $('#pw').value = '';
    msg('#loginMsg', '');
    setAuthed(true);
  } else {
    const data = await res.json().catch(() => ({}));
    msg('#loginMsg', data.error || 'Wrong password.', 'err');
  }
}

$('#logoutBtn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.reload();
});

/* ---------------- picking files ---------------- */

const dz = $('#dropzone');
const folderInput = $('#folderInput');
const photoInput = $('#photoInput');

/* Tapping the box opens whichever picker this device actually has. */
dz.addEventListener('click', () => (canPickFolder ? folderInput.click() : photoInput.click()));
$('#pickFolderBtn').addEventListener('click', () => folderInput.click());
$('#pickPhotosBtn').addEventListener('click', () => photoInput.click());

folderInput.addEventListener('change', (e) => {
  const all = [...e.target.files];
  folderName = ((all[0] && all[0].webkitRelativePath) || '').split('/')[0] || '';
  accept(all, 'folder');
});

photoInput.addEventListener('change', (e) => accept([...e.target.files], 'photos'));

['dragenter', 'dragover'].forEach((evt) =>
  dz.addEventListener(evt, (e) => { e.preventDefault(); dz.classList.add('over'); })
);
['dragleave', 'drop'].forEach((evt) =>
  dz.addEventListener(evt, (e) => { e.preventDefault(); dz.classList.remove('over'); })
);

dz.addEventListener('drop', async (e) => {
  const items = e.dataTransfer.items;
  if (items && items.length && items[0].webkitGetAsEntry) {
    const files = [];
    const roots = [];
    for (const item of items) {
      const entry = item.webkitGetAsEntry();
      if (entry) roots.push(entry);
    }
    if (roots.length === 1 && roots[0].isDirectory) folderName = roots[0].name;
    await Promise.all(roots.map((entry) => walk(entry, files)));
    accept(files, 'folder');
  } else {
    accept([...e.dataTransfer.files], 'drop');
  }
});

function walk(entry, out) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file((file) => { out.push(file); resolve(); }, resolve);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const all = [];
      const readBatch = () => reader.readEntries(async (batch) => {
        if (!batch.length) {
          for (const child of all) await walk(child, out);
          resolve();
          return;
        }
        all.push(...batch);
        readBatch();
      }, resolve);
      readBatch();
    } else resolve();
  });
}

/* Sorting the chosen files into "upload these", "too big" and "not an image". */
function accept(files, source) {
  const images = [];
  const tooBig = [];
  const rejected = [];

  for (const f of files) {
    if (!MEDIA_RE.test(f.name)) rejected.push(f.name);
    else if (f.size > (isVideoName(f.name) ? limits.maxVideoMb : limits.maxFileMb) * 1048576) tooBig.push(f.name);
    else images.push(f);
  }

  selected = images;
  if (folderName && !$('#albumName').value) $('#albumName').value = folderName;
  if (source === 'photos' && images.length && !$('#albumName').value) {
    $('#albumName').value = defaultAlbumName();
  }

  renderSelectionInfo();
  $('#uploadBtn').disabled = !images.length;
  $('#clearBtn').disabled = !images.length;

  const details = [];
  if (tooBig.length) {
    details.push(
      `${tooBig.length} file${tooBig.length === 1 ? '' : 's'} over its size limit: ` +
        tooBig.slice(0, 5).join(', ') + (tooBig.length > 5 ? ', …' : '')
    );
  }
  if (rejected.length) {
    const heic = rejected.filter((n) => HEIC_RE.test(n)).length;
    details.push(
      `${rejected.length} file${rejected.length === 1 ? '' : 's'} not an accepted format (photos and playable video): ` +
        rejected.slice(0, 5).join(', ') + (rejected.length > 5 ? ', …' : '')
    );
    if (heic) {
      details.push(
        'HEIC (iPhone) files are not readable outside Apple devices — on the phone set ' +
          'Settings → Camera → Formats → Most Compatible, or share the photos as JPEG.'
      );
    }
  }
  if (details.length) msg('#uploadMsg', 'Left out of this upload:', 'err', details);
  else msg('#uploadMsg', '');
}

function renderSelectionInfo() {
  const size = selected.reduce((n, f) => n + f.size, 0);
  $('#dzInfo').textContent = selected.length
    ? `${selected.length} image${selected.length === 1 ? '' : 's'} · ${mb(size)}`
    : idleInfo;
}

$('#clearBtn').addEventListener('click', () => {
  selected = [];
  folderName = '';
  folderInput.value = '';
  photoInput.value = '';
  accept([]);
});

/* ---------------- upload ---------------- */

function sendBatch(files, name, slug, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('name', name);
    for (const file of files) form.append('photos', file, file.name);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/albums/' + encodeURIComponent(slug) + '/photos');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || 'server returned ' + xhr.status));
    };
    xhr.onerror = () => reject(new Error('the connection dropped'));
    xhr.ontimeout = () => reject(new Error('the upload timed out'));
    xhr.send(form);
  });
}

$('#uploadBtn').addEventListener('click', async () => {
  if (!selected.length) return;

  const name = ($('#albumName').value || folderName || defaultAlbumName()).trim();
  const slug = slugifyClient(name);
  const queue = selected.slice();
  const total = queue.length;

  const bar = $('#bar');
  const fill = bar.querySelector('i');
  bar.classList.remove('hidden');
  fill.style.width = '0%';
  $('#uploadBtn').disabled = true;

  let savedTotal = 0;
  let refused = [];

  for (let i = 0; i < queue.length; i += BATCH_SIZE) {
    const batch = queue.slice(i, i + BATCH_SIZE);
    msg('#uploadMsg', `Uploading ${i + 1}–${Math.min(i + BATCH_SIZE, total)} of ${total} to “${name}”…`, 'work');
    try {
      const data = await sendBatch(batch, name, slug, (loaded, len) => {
        const withinBatch = len ? loaded / len : 0;
        fill.style.width = Math.round(((i + withinBatch * batch.length) / total) * 100) + '%';
      });
      savedTotal += typeof data.saved === 'number' ? data.saved : batch.length;
      if (Array.isArray(data.skipped)) refused = refused.concat(data.skipped);
    } catch (err) {
      /* keep the un-uploaded files selected so Upload can be pressed again */
      selected = queue.slice(i);
      renderSelectionInfo();
      $('#uploadBtn').disabled = false;
      fill.style.width = '0%';
      loadAlbums();
      msg(
        '#uploadMsg',
        `Stopped after ${savedTotal} of ${total} files — ${err.message}. ` +
          `${selected.length} still selected: press Upload again to continue.`,
        'err'
      );
      return;
    }
  }

  fill.style.width = '100%';
  $('#uploadBtn').disabled = false;

  const details = refused.length
    ? [`${refused.length} file${refused.length === 1 ? '' : 's'} refused by the server: ${refused.slice(0, 5).join(', ')}`]
    : [];
  msg('#uploadMsg', `Done — ${savedTotal} file${savedTotal === 1 ? '' : 's'} saved to “${name}”.`, 'ok', details);

  selected = [];
  folderName = '';
  folderInput.value = '';
  photoInput.value = '';
  $('#albumName').value = '';
  accept([]);
  loadAlbums();
});

/* ---------------- album management ---------------- */

async function loadAlbums() {
  const list = $('#albumList');
  const res = await fetch('/api/albums', { headers: { accept: 'application/json' } });
  const { albums } = await res.json();
  if (!albums.length) {
    list.innerHTML = '<li class="muted">No albums yet.</li>';
    return;
  }
  list.innerHTML = '';
  for (const a of albums) {
    const li = document.createElement('li');
    li.innerHTML =
      (a.coverKind === 'video'
        ? `<video class="cover" muted playsinline preload="metadata" src="${esc(a.cover)}#t=0.001"></video>`
        : `<div class="cover" style="background-image:url('${esc(a.cover)}')"></div>`) +
      `<div class="grow"><strong>${esc(a.name)}</strong><small>${a.count} item${a.count === 1 ? '' : 's'}${a.videos ? ' · ' + a.videos + ' video' + (a.videos === 1 ? '' : 's') : ''} · ${esc(a.slug)}</small></div>` +
      `<div class="actions">` +
      `<a class="btn small ghost" href="/#/a/${encodeURIComponent(a.slug)}">Open</a>` +
      `<button class="btn small danger" data-slug="${esc(a.slug)}" data-name="${esc(a.name)}">Delete</button>` +
      `</div>`;
    list.appendChild(li);
  }
  list.querySelectorAll('button[data-slug]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const slug = btn.dataset.slug;
      if (!confirm(`Delete album “${btn.dataset.name}” and all its photos? This cannot be undone.`)) return;
      const res = await fetch('/api/albums/' + encodeURIComponent(slug), { method: 'DELETE' });
      if (res.ok) {
        msg('#manageMsg', 'Album deleted.', 'ok');
        loadAlbums();
      } else {
        msg('#manageMsg', 'Could not delete album.', 'err');
      }
    });
  });
}

/* ---------------- boot ---------------- */

(async function boot() {
  try {
    const res = await fetch('/api/config', { headers: { accept: 'application/json' } });
    if (res.ok) limits = await res.json();
  } catch (err) {
    console.error(err);
  }
  applyCopy();
  checkSession();
})();
