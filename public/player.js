'use strict';

/* The video player.

   One overlay, built to feel like the player everyone already knows: the still frame
   first, a big play button, controls that get out of the way after a few seconds, a
   scrub bar with the buffered part drawn behind the played part, a double tap either
   side to skip ten seconds, and the position remembered so closing it by accident is
   not a loss.

   Everything here is pointer events, so a finger, a pen and a mouse take exactly the
   same path and there is no second touch handler to fall out of step with the first.
   The element is inline on iOS (playsinline), so it is never handed to the system
   player, which would take the controls away.

   The overlay is fixed and the page behind it is held still by the caller (app.js owns
   the one scroll lock, and is told to release it through onClose). */

window.VideoPlayer = (function () {
  const KEY_RATE = 'ps-rate';
  const KEY_VOL = 'ps-vol';
  const KEY_MUTE = 'ps-muted';
  const KEY_POS = 'ps-vpos';

  const SKIP = 10;              /* seconds a double tap moves */
  const RATES = [1, 1.25, 1.5, 2, 0.5];
  const IDLE_MS = 3000;         /* how long the controls stay up while playing */
  const TAP_MS = 300;           /* two taps closer together than this are one double tap */
  const TAP_SLOP = 14;          /* and a tap that travelled further was a drag */
  const POS_KEEP = 400;         /* how many positions this device remembers */

  const el = {};
  let built = false;

  const state = {
    photo: null,
    next: null,
    onClose: null,
    open: false,
    idle: 0,
    poked: 0,
    saved: 0,
    scrubbing: false,
    scrubAt: 0,
    tap: null,
    lastTap: 0,
    wake: null,
  };

  const v = () => el.video;

  /* ---------------------------------------------------------------- *
   * small helpers
   * ---------------------------------------------------------------- */

  /* 12:34, or 1:02:03 when it runs past the hour. Empty for an unknown length. */
  function fmt(seconds) {
    const total = Math.round(Number(seconds) || 0);
    if (!(total > 0)) return '0:00';
    const h = Math.floor(total / 3600);
    const m = Math.floor(total / 60) % 60;
    const s = total % 60;
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
  }

  function readNum(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return fallback;
      const n = Number(raw);
      return Number.isFinite(n) ? n : fallback;
    } catch {
      return fallback;
    }
  }

  function readFlag(key) {
    try {
      return localStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  }

  /* One device's memory of where it got to, keyed album/name. Not a watch history and
     not sent anywhere; it exists so a thumbnail can draw the red line and the player can
     pick up where the last session stopped. */
  function readPositions() {
    try {
      const all = JSON.parse(localStorage.getItem(KEY_POS) || '{}');
      return all && typeof all === 'object' ? all : {};
    } catch {
      return {};
    }
  }

  function savePosition(photo, at, duration) {
    if (!photo) return;
    try {
      const all = readPositions();
      const key = photo.album + '/' + photo.name;
      /* the last few seconds are the end card, and the first few are the opening: a
         position there would open the video on a frame nobody chose */
      if (!(duration > 0) || at < 5 || at > duration - 10) delete all[key];
      else all[key] = { t: Math.round(at), d: Math.round(duration) };
      const keys = Object.keys(all);
      if (keys.length > POS_KEEP) {
        for (const old of keys.slice(0, keys.length - POS_KEEP)) delete all[old];
      }
      localStorage.setItem(KEY_POS, JSON.stringify(all));
    } catch {
      /* private mode: the position simply does not survive the visit */
    }
  }

  function resumeAt(photo) {
    if (!photo) return 0;
    const hit = readPositions()[photo.album + '/' + photo.name];
    return hit && hit.t > 0 ? hit.t : 0;
  }

  /* How much of this video has been watched here, 0..1. The thumbnail draws its red
     line from this, which is why it lives in the player rather than in the feed. */
  function watched(photo, duration) {
    if (!photo) return 0;
    const hit = readPositions()[photo.album + '/' + photo.name];
    if (!hit || !hit.t) return 0;
    const d = duration || hit.d;
    if (!(d > 0)) return 0;
    return Math.max(0, Math.min(1, hit.t / d));
  }

  /* ---------------------------------------------------------------- *
   * building and wiring
   * ---------------------------------------------------------------- */

  function build() {
    if (built) return;
    built = true;
    el.root = document.getElementById('player');
    el.video = document.getElementById('playerVideo');
    if (!el.root || !el.video) return;

    el.top = document.getElementById('plTop');
    el.title = document.getElementById('plTitle');
    el.sub = document.getElementById('plSub');
    el.close = document.getElementById('plClose');
    el.big = document.getElementById('plBig');
    el.spin = document.getElementById('plSpin');
    el.nextBtn = document.getElementById('plNext');
    el.flash = document.getElementById('plFlash');
    el.resume = document.getElementById('plResume');
    el.err = document.getElementById('plError');
    el.bar = document.getElementById('plBar');
    el.play = document.getElementById('plPlay');
    el.time = document.getElementById('plTime');
    el.dur = document.getElementById('plDur');
    el.track = document.getElementById('plTrack');
    el.buf = document.getElementById('plBuf');
    el.fill = document.getElementById('plFill');
    el.knob = document.getElementById('plKnob');
    el.tip = document.getElementById('plTip');
    el.mute = document.getElementById('plMute');
    el.vol = document.getElementById('plVol');
    el.volFill = document.getElementById('plVolFill');
    el.rate = document.getElementById('plRate');
    el.pip = document.getElementById('plPip');
    el.full = document.getElementById('plFull');

    wire();
    syncPrefs();
  }

  function wire() {
    const video = el.video;

    el.close.addEventListener('click', () => api.close());
    el.play.addEventListener('click', toggle);
    el.big.addEventListener('click', toggle);
    el.mute.addEventListener('click', () => setMuted(!video.muted));
    el.rate.addEventListener('click', cycleRate);
    el.full.addEventListener('click', toggleFull);
    if (el.pip) el.pip.addEventListener('click', togglePip);
    if (el.nextBtn) {
      el.nextBtn.addEventListener('click', () => {
        const go = state.next;
        api.close();
        if (go) go();
      });
    }

    video.addEventListener('play', syncPlay);
    video.addEventListener('pause', syncPlay);
    video.addEventListener('ended', onEnded);
    video.addEventListener('waiting', () => spin(true));
    video.addEventListener('playing', () => spin(false));
    video.addEventListener('canplay', () => spin(false));
    video.addEventListener('error', onError);
    video.addEventListener('loadedmetadata', () => {
      el.dur.textContent = fmt(video.duration);
      draw();
    });
    video.addEventListener('timeupdate', () => {
      draw();
      remember();
    });
    video.addEventListener('progress', draw);
    video.addEventListener('volumechange', () => {
      drawVolume();
      persistPrefs();
    });

    /* the bar: one pointer path for a finger, a mouse drag and a plain click */
    el.track.addEventListener('pointerdown', trackDown);
    el.track.addEventListener('pointermove', trackMove);
    el.track.addEventListener('pointerup', trackUp);
    el.track.addEventListener('pointercancel', trackUp);
    el.track.addEventListener('pointerleave', () => {
      if (!state.scrubbing && el.tip) el.tip.classList.add('hidden');
    });

    el.vol.addEventListener('pointerdown', volDown);
    el.vol.addEventListener('pointermove', volMove);
    el.vol.addEventListener('pointerup', volUp);
    el.vol.addEventListener('pointercancel', volUp);

    /* the picture: a tap shows the controls, a double tap either side skips */
    video.addEventListener('pointerdown', surfaceDown);
    video.addEventListener('pointerup', surfaceUp);
    video.addEventListener('pointercancel', () => {
      state.tap = null;
    });

    el.root.addEventListener('pointermove', poke);
    document.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', syncFull);
    document.addEventListener('webkitfullscreenchange', syncFull);
  }

  /* ---------------------------------------------------------------- *
   * the controls
   * ---------------------------------------------------------------- */

  function show() {
    el.root.classList.remove('idle');
    clearTimeout(state.idle);
    /* the controls never hide while the video is paused: nothing is moving, so there is
       nothing to get out of the way of */
    if (!el.video.paused) state.idle = setTimeout(() => el.root.classList.add('idle'), IDLE_MS);
  }

  /* a pointer moving over the player brings the controls back, but the check is throttled
     so a mouse crossing the screen is not sixty class reads a second */
  function poke() {
    if (!state.open) return;
    if (!el.root.classList.contains('idle') && Date.now() - state.poked < 900) return;
    state.poked = Date.now();
    show();
  }

  function spin(on) {
    if (el.spin) el.spin.classList.toggle('hidden', !on);
  }

  function flash(text) {
    if (!el.flash) return;
    el.flash.textContent = text;
    el.flash.classList.remove('hidden', 'go');
    /* reading a layout property forces the reflow that restarts the animation */
    void el.flash.offsetWidth;
    el.flash.classList.add('go');
  }

  function syncPlay() {
    const paused = el.video.paused;
    el.root.classList.toggle('paused', paused);
    el.root.classList.toggle('playing', !paused);
    if (el.play) {
      el.play.textContent = paused ? 'Play' : 'Pause';
      el.play.setAttribute('aria-label', paused ? 'Play' : 'Pause');
      el.play.setAttribute('aria-pressed', String(!paused));
    }
    show();
  }

  function toggle() {
    const video = el.video;
    if (video.paused) {
      const started = video.play();
      /* a rejected play() is not worth an error message: the big play button is still
         there, and on iOS a refused autoplay is normal */
      if (started && started.catch) started.catch(() => {});
    } else {
      video.pause();
    }
    show();
  }

  function skip(seconds) {
    const video = el.video;
    const d = video.duration;
    if (!(d > 0)) return;
    video.currentTime = Math.max(0, Math.min(d - 0.25, video.currentTime + seconds));
    flash((seconds > 0 ? '+' : '-') + Math.abs(seconds) + 's');
    draw();
    show();
  }

  function draw() {
    const video = el.video;
    const d = video.duration;
    const known = Number.isFinite(d) && d > 0;
    const at = state.scrubbing ? state.scrubAt : video.currentTime;
    const pct = known ? Math.max(0, Math.min(1, at / d)) * 100 : 0;

    el.fill.style.width = pct + '%';
    el.knob.style.left = pct + '%';
    el.time.textContent = fmt(at);
    el.dur.textContent = known ? fmt(d) : '--:--';
    el.track.setAttribute('aria-valuenow', String(Math.round(pct)));
    el.track.setAttribute('aria-valuetext', fmt(at) + ' of ' + (known ? fmt(d) : 'unknown'));

    /* the buffered part: the range that contains the playhead, or the furthest edge
       when it does not sit inside one (a seek into unbuffered ground) */
    let edge = 0;
    if (known) {
      for (let i = 0; i < video.buffered.length; i += 1) {
        if (video.buffered.start(i) <= at + 0.5 && video.buffered.end(i) >= at - 0.5) {
          edge = video.buffered.end(i);
          break;
        }
        edge = Math.max(edge, video.buffered.end(i));
      }
    }
    el.buf.style.width = known ? Math.max(0, Math.min(1, edge / d)) * 100 + '%' : '0%';
  }

  function remember() {
    const now = Date.now();
    if (now - state.saved < 2000) return;
    state.saved = now;
    savePosition(state.photo, el.video.currentTime, el.video.duration);
  }

  function onEnded() {
    el.root.classList.add('paused', 'ended');
    el.root.classList.remove('playing');
    if (el.play) el.play.textContent = 'Replay';
    if (el.nextBtn) el.nextBtn.classList.toggle('hidden', !state.next);
    /* an ended video starts over next time, so the position goes */
    savePosition(state.photo, 0, el.video.duration);
    show();
    clearTimeout(state.idle);
    el.root.classList.remove('idle');
  }

  function onError() {
    const code = el.video.error ? el.video.error.code : 0;
    /* 4 is a decode failure: a codec this browser does not have, which in practice means
       HEVC — Safari plays it, Chrome does not. Say so rather than leave a black box. */
    el.err.textContent =
      code === 4
        ? 'This browser cannot play that file. It is most likely HEVC: Safari plays it, Chrome and Firefox do not.'
        : code === 2
          ? 'That video could not be loaded.'
          : 'Something went wrong playing that video.';
    el.err.classList.remove('hidden');
    spin(false);
    show();
    clearTimeout(state.idle);
    el.root.classList.remove('idle');
  }

  /* ---------------------------------------------------------------- *
   * the scrub bar
   * ---------------------------------------------------------------- */

  function atX(clientX) {
    const r = el.track.getBoundingClientRect();
    if (!r.width || !(el.video.duration > 0)) return 0;
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * el.video.duration;
  }

  function trackDown(e) {
    if (!(el.video.duration > 0)) return;
    state.scrubbing = true;
    state.scrubAt = atX(e.clientX);
    try {
      el.track.setPointerCapture(e.pointerId);
    } catch {
      /* a pointer that already went away is not worth an error */
    }
    el.video.currentTime = state.scrubAt;
    draw();
    show();
  }

  function trackMove(e) {
    const r = el.track.getBoundingClientRect();
    if (!r.width) return;
    const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    if (el.tip && el.video.duration > 0) {
      el.tip.textContent = fmt(ratio * el.video.duration);
      el.tip.style.left = ratio * 100 + '%';
      el.tip.classList.remove('hidden');
    }
    if (!state.scrubbing) return;
    state.scrubAt = ratio * el.video.duration;
    el.video.currentTime = state.scrubAt;
    draw();
  }

  function trackUp(e) {
    if (!state.scrubbing) return;
    state.scrubbing = false;
    try {
      el.track.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    if (el.tip) el.tip.classList.add('hidden');
    draw();
  }

  /* ---------------------------------------------------------------- *
   * volume, speed, full screen, picture in picture
   * ---------------------------------------------------------------- */

  function drawVolume() {
    const video = el.video;
    const off = video.muted || video.volume === 0;
    el.volFill.style.width = (off ? 0 : video.volume) * 100 + '%';
    el.mute.textContent = off ? 'Unmute' : 'Mute';
    el.mute.setAttribute('aria-label', off ? 'Unmute' : 'Mute');
    el.mute.setAttribute('aria-pressed', String(off));
  }

  function setVolume(value) {
    el.video.volume = Math.max(0, Math.min(1, value));
    el.video.muted = el.video.volume === 0;
    drawVolume();
    persistPrefs();
  }

  function setMuted(on) {
    el.video.muted = !!on;
    drawVolume();
    persistPrefs();
  }

  function volAt(clientX) {
    const r = el.vol.getBoundingClientRect();
    if (!r.width) return el.video.volume;
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  }

  function volDown(e) {
    el.vol.setPointerCapture(e.pointerId);
    setVolume(volAt(e.clientX));
  }

  function volMove(e) {
    if (!el.vol.hasPointerCapture || !el.vol.hasPointerCapture(e.pointerId)) return;
    setVolume(volAt(e.clientX));
  }

  function volUp(e) {
    try {
      el.vol.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  }

  function cycleRate() {
    const at = RATES.indexOf(el.video.playbackRate);
    const next = RATES[(at + 1) % RATES.length];
    el.video.playbackRate = next;
    el.rate.textContent = next + 'x';
    el.rate.setAttribute('aria-label', 'Playback speed ' + next + 'x');
    persistPrefs();
  }

  function fullscreenOn() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  function toggleFull() {
    const root = el.root;
    if (fullscreenOn()) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) exit.call(document);
      return;
    }
    /* iOS Safari has no element full screen, only video full screen — and that hands the
       picture to the system player, controls and all. It is still better than nothing. */
    if (root.requestFullscreen) {
      const started = root.requestFullscreen();
      if (started && started.catch) started.catch(() => {});
    } else if (root.webkitRequestFullscreen) root.webkitRequestFullscreen();
    else if (el.video.webkitEnterFullscreen) el.video.webkitEnterFullscreen();
  }

  function syncFull() {
    const on = fullscreenOn();
    el.root.classList.toggle('fs', on);
    el.full.textContent = on ? 'Exit' : 'Full';
    el.full.setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen');
  }

  function togglePip() {
    const video = el.video;
    try {
      if (document.pictureInPictureElement) document.exitPictureInPicture();
      else if (video.requestPictureInPicture) video.requestPictureInPicture();
    } catch {
      /* not supported here */
    }
  }

  /* A playing video should not be interrupted by the screen dimming. Released on close,
     and silently skipped where the API does not exist. */
  async function keepAwake(on) {
    try {
      if (on) {
        if (!state.wake && navigator.wakeLock && navigator.wakeLock.request) {
          state.wake = await navigator.wakeLock.request('screen');
          state.wake.addEventListener('release', () => {
            state.wake = null;
          });
        }
      } else if (state.wake) {
        const held = state.wake;
        state.wake = null;
        await held.release();
      }
    } catch {
      /* denied, or the tab went to the background */
    }
  }

  /* ---------------------------------------------------------------- *
   * the picture surface
   * ---------------------------------------------------------------- */

  function surfaceDown(e) {
    state.tap = { x: e.clientX, y: e.clientY };
  }

  function surfaceUp(e) {
    const tap = state.tap;
    state.tap = null;
    if (!tap) return;
    if (Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > TAP_SLOP) return;

    const now = Date.now();
    const r = el.video.getBoundingClientRect();
    const third = r.width / 3;
    const x = e.clientX - r.left;

    /* The second tap of a double tap is the skip: the first one already brought the
       controls up, and doing it again here would bury the skip's own feedback. */
    if (now - state.lastTap < TAP_MS) {
      state.lastTap = 0;
      if (x < third) skip(-SKIP);
      else if (x > third * 2) skip(SKIP);
      else toggle();
      return;
    }
    state.lastTap = now;
    show();
  }

  function onKey(e) {
    if (!state.open) return;
    const target = e.target || {};
    const tag = String(target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || target.isContentEditable) return;

    const video = el.video;
    const k = e.key;

    if (k === ' ' || k === 'Spacebar' || k === 'k' || k === 'K') {
      e.preventDefault();
      toggle();
    } else if (k === 'j' || k === 'J') {
      e.preventDefault();
      skip(-SKIP);
    } else if (k === 'l' || k === 'L') {
      e.preventDefault();
      skip(SKIP);
    } else if (k === 'ArrowLeft') {
      e.preventDefault();
      skip(-5);
    } else if (k === 'ArrowRight') {
      e.preventDefault();
      skip(5);
    } else if (k === 'ArrowUp') {
      e.preventDefault();
      setVolume(video.volume + 0.1);
    } else if (k === 'ArrowDown') {
      e.preventDefault();
      setVolume(video.volume - 0.1);
    } else if (k === 'm' || k === 'M') {
      e.preventDefault();
      setMuted(!video.muted);
    } else if (k === 'f' || k === 'F') {
      e.preventDefault();
      toggleFull();
    } else if (k === 'p' || k === 'P') {
      e.preventDefault();
      togglePip();
    } else if (k === 'Escape') {
      /* in full screen the browser's own Escape leaves full screen first, so this only
         closes the player once the picture is back */
      if (!fullscreenOn()) {
        e.preventDefault();
        api.close();
      }
    } else if (k === 'Home') {
      e.preventDefault();
      video.currentTime = 0;
      draw();
    } else if (k === 'End') {
      e.preventDefault();
      video.currentTime = Math.max(0, (video.duration || 0) - 0.5);
      draw();
    } else if (k >= '0' && k <= '9') {
      e.preventDefault();
      const d = video.duration || 0;
      video.currentTime = d ? (Number(k) / 10) * d : 0;
      draw();
      show();
    }
  }

  /* ---------------------------------------------------------------- *
   * remembered settings
   * ---------------------------------------------------------------- */

  function syncPrefs() {
    el.rate.textContent = readRate() + 'x';
    if (!el.video.requestPictureInPicture && el.pip) el.pip.classList.add('hidden');
    if (!document.fullscreenEnabled && !el.root.webkitRequestFullscreen) {
      /* the button stays: it falls back to the video's own full screen on iOS */
    }
  }

  function readRate() {
    const r = readNum(KEY_RATE, 1);
    return RATES.includes(r) ? r : 1;
  }

  function applyPrefs() {
    const video = el.video;
    video.volume = Math.max(0, Math.min(1, readNum(KEY_VOL, 1)));
    video.muted = readFlag(KEY_MUTE);
  }

  function persistPrefs() {
    try {
      localStorage.setItem(KEY_VOL, String(el.video.volume));
      localStorage.setItem(KEY_MUTE, el.video.muted ? '1' : '0');
      localStorage.setItem(KEY_RATE, String(el.video.playbackRate));
    } catch {
      /* private mode */
    }
  }

  /* ---------------------------------------------------------------- *
   * public
   * ---------------------------------------------------------------- */

  const api = {
    available() {
      build();
      return !!(el.root && el.video);
    },

    isOpen: () => state.open,
    current: () => state.photo,

    /* Whether this device has watched part of a video, for the thumbnail's red line. */
    watched,

    /* Where the last session stopped, for the "resumed from" note. */
    resumeAt,

    open(photo, opts) {
      build();
      if (!el.root || !el.video || !photo) return false;
      const o = opts || {};
      const video = el.video;

      state.photo = photo;
      state.next = o.next || null;
      state.onClose = o.onClose || null;
      state.open = true;
      state.saved = 0;
      state.scrubbing = false;

      video.poster = photo.poster || '';
      el.title.textContent = o.title || photo.name;
      el.sub.textContent = o.sub || '';
      el.err.textContent = '';
      el.err.classList.add('hidden');
      if (el.nextBtn) el.nextBtn.classList.add('hidden');
      el.root.classList.remove('ended', 'fs');
      spin(true);

      video.src = photo.url;
      video.playbackRate = readRate();
      applyPrefs();

      const at = resumeAt(photo);
      if (at > 0) {
        /* currentTime means nothing until the metadata is in */
        const seek = () => {
          try {
            video.currentTime = at;
          } catch {
            /* a seek before the media is ready is simply dropped */
          }
        };
        if (video.readyState >= 1) seek();
        else video.addEventListener('loadedmetadata', seek, { once: true });
        el.resume.textContent = 'Resumed from ' + fmt(at);
        el.resume.classList.remove('hidden');
        clearTimeout(state.resumeTimer);
        state.resumeTimer = setTimeout(() => el.resume.classList.add('hidden'), 3200);
      } else {
        el.resume.classList.add('hidden');
      }

      el.root.classList.remove('hidden');
      /* this runs inside the tap that opened it, so iOS lets it play unprompted */
      const started = video.play();
      if (started && started.catch) started.catch(() => {});
      syncPlay();
      draw();
      drawVolume();
      keepAwake(true);
      return true;
    },

    close() {
      if (!state.open) return;
      const video = el.video;
      savePosition(state.photo, video.currentTime, video.duration);
      state.open = false;
      state.photo = null;
      state.next = null;
      clearTimeout(state.idle);
      clearTimeout(state.resumeTimer);
      try {
        video.pause();
      } catch {
        /* nothing playing */
      }
      /* dropping the source stops the download: a paused video keeps buffering, and on a
         phone that is the user's data */
      video.removeAttribute('src');
      try {
        video.load();
      } catch {
        /* a browser that will not re-load a cleared source is not worth an error */
      }
      el.root.classList.add('hidden');
      el.root.classList.remove('idle', 'playing', 'paused', 'fs');
      spin(false);
      if (fullscreenOn()) {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) exit.call(document);
      }
      keepAwake(false);
      const done = state.onClose;
      state.onClose = null;
      if (typeof done === 'function') done();
    },
  };

  return api;
})();
