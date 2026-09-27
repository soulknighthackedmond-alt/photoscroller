'use strict';

/* Photoscroller admin: password gate + folder upload + album management. */

const $ = (s) => document.querySelector(s);
/* Album names/slugs are the only untrusted strings rendered here, and every one of them is
   passed through esc() before it lands in innerHTML — so the markup stays markup. */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const IMAGE_RE = /\.(jpe?g|png|gif|webp|avif|bmp)$/i;
let selected = [];
let folderName = '';

function msg(el, text, kind) {
  const node = $(el);
  node.textContent = text || '';
  node.className = 'msg' + (kind ? ' ' + kind : '');
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

/* ---------------- folder selection ---------------- */

const dz = $('#dropzone');
dz.addEventListener('click', () => $('#folderInput').click());
$('#folderInput').addEventListener('change', (e) => {
  const files = [...e.target.files].filter((f) => IMAGE_RE.test(f.name));
  folderName = (e.target.files[0] && e.target.files[0].webkitRelativePath || '').split('/')[0] || '';
  accept(files);
});

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
    await Promise.all(roots.map((entry) => walk(entry, files, '')));
    accept(files);
  } else {
    accept([...e.dataTransfer.files].filter((f) => IMAGE_RE.test(f.name)));
  }
});

function walk(entry, out, prefix) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file((file) => {
        if (IMAGE_RE.test(file.name)) out.push(file);
        resolve();
      }, resolve);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const all = [];
      const readBatch = () => reader.readEntries(async (batch) => {
        if (!batch.length) {
          for (const child of all) await walk(child, out, prefix + entry.name + '/');
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

function accept(files) {
  selected = files;
  const size = files.reduce((n, f) => n + f.size, 0);
  $('#dropInfo').textContent = files.length
    ? `${files.length} image${files.length === 1 ? '' : 's'} · ${(size / 1048576).toFixed(1)} MB`
    : 'or click to browse for a folder';
  if (folderName && !$('#albumName').value) $('#albumName').value = folderName;
  $('#uploadBtn').disabled = !files.length;
  $('#clearBtn').disabled = !files.length;
}

$('#clearBtn').addEventListener('click', () => {
  selected = [];
  folderName = '';
  $('#folderInput').value = '';
  accept([]);
});

/* ---------------- upload ---------------- */

$('#uploadBtn').addEventListener('click', () => {
  if (!selected.length) return;
  const name = ($('#albumName').value || folderName || 'album').trim();
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'album';

  const form = new FormData();
  form.append('name', name);
  for (const file of selected) form.append('photos', file, file.name);

  const bar = $('#bar');
  const fill = bar.querySelector('i');
  bar.classList.remove('hidden');
  fill.style.width = '0%';
  msg('#uploadMsg', `Uploading ${selected.length} photos to “${name}”…`, 'work');
  $('#uploadBtn').disabled = true;

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/albums/' + encodeURIComponent(slug) + '/photos');
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) fill.style.width = Math.round((e.loaded / e.total) * 100) + '%';
  };
  xhr.onload = () => {
    $('#uploadBtn').disabled = false;
    if (xhr.status >= 200 && xhr.status < 300) {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch {}
      fill.style.width = '100%';
      msg('#uploadMsg', `Done — ${data.saved || selected.length} photos saved to “${name}”.`, 'ok');
      selected = [];
      folderName = '';
      $('#folderInput').value = '';
      $('#albumName').value = '';
      accept([]);
      loadAlbums();
    } else {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch {}
      msg('#uploadMsg', data.error || 'Upload failed (' + xhr.status + ').', 'err');
    }
  };
  xhr.onerror = () => {
    $('#uploadBtn').disabled = false;
    msg('#uploadMsg', 'Network error during upload.', 'err');
  };
  xhr.send(form);
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
      `<div class="cover" style="background-image:url('${esc(a.cover)}')"></div>` +
      `<div class="grow"><strong>${esc(a.name)}</strong><small>${a.count} photo${a.count === 1 ? '' : 's'} · ${esc(a.slug)}</small></div>` +
      `<a class="btn small ghost" href="/#/a/${encodeURIComponent(a.slug)}">Open</a>` +
      `<button class="btn small danger" data-slug="${esc(a.slug)}" data-name="${esc(a.name)}">Delete</button>`;
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

checkSession();
