'use strict';

/* Install / home-screen glue, shared by the viewer and the upload page.

   Two different stories live here:

   - Android + desktop Chrome fire `beforeinstallprompt`, so the app can show a real
     Install button that opens the browser's own install dialog.
   - iOS Safari never fires it. "Add to Home Screen" is a manual step behind the Share
     button, so the viewer tells the user where it is. Once added, the apple-touch-icon
     and the standalone meta tags make it open full screen with no browser bars.

   Registering the service worker is what makes Chrome offer to install at all, and it
   is what lets the installed app open offline. It needs a secure origin (https or
   localhost), so on a plain-http origin it is skipped and everything else still works. */

(function () {
  const $ = (sel) => document.querySelector(sel);

  const isStandalone = () =>
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    window.navigator.standalone === true;

  const isIos = () =>
    /iP(hone|od|ad)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  /* only Safari can add to the home screen on iOS — Chrome/Firefox on iOS cannot */
  const isIosSafari = () => isIos() && !/CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo/.test(navigator.userAgent);

  if (isStandalone()) document.documentElement.classList.add('standalone');

  const secureEnough =
    window.isSecureContext ||
    location.hostname === 'localhost' ||
    location.hostname === '127.0.0.1' ||
    location.hostname === '[::1]';

  if ('serviceWorker' in navigator && secureEnough) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        /* an unsupported or blocked worker changes nothing for the user */
      });
    });
  }

  const installBtn = $('#installBtn');
  const hint = $('#a2hs');
  const hideHint = () => { if (hint) hint.classList.add('hidden'); };

  let deferredPrompt = null;

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event;
    if (installBtn && !isStandalone()) installBtn.classList.remove('hidden');
    hideHint();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    if (installBtn) installBtn.classList.add('hidden');
    hideHint();
  });

  if (installBtn) {
    installBtn.addEventListener('click', async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      try {
        await deferredPrompt.userChoice;
      } catch {
        /* dismissed */
      }
      deferredPrompt = null;
      installBtn.classList.add('hidden');
    });
  }

  const HINT_KEY = 'ps-a2hs-dismissed';
  const hintClose = $('#a2hsClose');

  if (hintClose) {
    hintClose.addEventListener('click', () => {
      hideHint();
      try {
        localStorage.setItem(HINT_KEY, '1');
      } catch {
        /* private mode: the hint just comes back next visit */
      }
    });
  }

  /* shown once, a couple of seconds in, and never once the app is already installed */
  if (hint && isIosSafari() && !isStandalone()) {
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(HINT_KEY) === '1';
    } catch {
      dismissed = false;
    }
    if (!dismissed) setTimeout(() => hint.classList.remove('hidden'), 2500);
  }

  /* leaving the tab open while the app gets installed shouldn't keep the button around */
  if (window.matchMedia) {
    const mq = window.matchMedia('(display-mode: standalone)');
    const onChange = () => {
      if (mq.matches) {
        document.documentElement.classList.add('standalone');
        if (installBtn) installBtn.classList.add('hidden');
        hideHint();
      }
    };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }
})();
