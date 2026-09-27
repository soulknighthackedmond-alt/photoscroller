'use strict';

/* Container entrypoint — starts the server as an unprivileged user, after making
   DATA_DIR writable.

   Why this exists: with a host bind-mount (which is what a Coolify volume
   mapping usually is), /data arrives owned by root while the app is meant to run
   as the unprivileged "node" user. The app then could not create /data/albums,
   exited at startup, and the container restart-looped — which from the outside
   looks exactly like "nothing is listening on port 3000".

   So: start as root, fix ownership once, drop to the node user, then run the
   server. If any of that fails the server still starts and says what is wrong on
   /api/health, rather than dying silently.

   Set PUID/PGID when a bind-mounted folder is owned by a different uid/gid. */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const UID = Number(process.env.PUID || 1000);
const GID = Number(process.env.PGID || 1000);

const runningAsRoot = typeof process.getuid === 'function' && process.getuid() === 0;

if (runningAsRoot) {
  try {
    fs.mkdirSync(path.join(DATA_DIR, 'albums'), { recursive: true });
    const owner = fs.statSync(DATA_DIR).uid;
    if (owner !== UID) {
      console.log(`entrypoint: taking ownership of ${DATA_DIR} (uid ${owner} -> ${UID})`);
      chownTree(DATA_DIR);
    }
  } catch (err) {
    /* not fatal — the server starts and reports this on /api/health */
    console.error(`entrypoint: could not prepare ${DATA_DIR}: ${err.code || ''} ${err.message}`.trim());
  }

  try {
    process.setgid(GID);
    process.setuid(UID);
    console.log(`entrypoint: running as uid ${UID}:${GID}`);
  } catch (err) {
    console.error(`entrypoint: could not drop privileges (${err.message}) — continuing as root`);
  }
}

require('./server.js');

/* lchown, not chown: a symlink in the volume must not be followed out of it. */
function chownTree(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.error(`entrypoint: cannot read ${dir}: ${err.code || ''} ${err.message}`.trim());
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      fs.lchownSync(full, UID, GID);
      if (entry.isDirectory() && !entry.isSymbolicLink()) chownTree(full);
    } catch (err) {
      console.error(`entrypoint: chown failed for ${full}: ${err.code || ''} ${err.message}`.trim());
    }
  }
}
