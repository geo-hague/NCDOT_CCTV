// merge-auth.js
// Writes each camera's minting CREDENTIALS (sourceId, systemSourceId, uuid)
// into cameras.json by matching chan. The app uses these to mint a fresh, very
// short-lived stream token at play time via the worker. We store credentials
// (good for ~a day), NOT tokens (good for ~a minute).
//
// Run after scrape-auth.js (and after fetch-cameras.js when it runs):
//   node merge-auth.js

const fs = require('fs');
const path = require('path');

const camerasPath = path.join(__dirname, 'cameras.json');
const cameras = JSON.parse(fs.readFileSync(camerasPath, 'utf8'));
const auth = JSON.parse(fs.readFileSync(path.join(__dirname, 'camera-auth.json'), 'utf8'));

const byChan = new Map();
for (const e of auth.entries) if (e.chan) byChan.set(e.chan.toLowerCase(), e);

const chanOf = (u) => { const m = (u || '').match(/(chan-[0-9a-zA-Z_]+)/i); return m ? m[1].toLowerCase() : null; };

let matched = 0, missing = 0;
for (const cam of cameras.cameras) {
  const hit = byChan.get(chanOf(cam.videoUrl));
  if (hit) {
    cam.sourceId = hit.sourceId;
    cam.systemSourceId = hit.systemSourceId;
    cam.uuid = hit.uuid;
    delete cam.token; // no baked tokens anymore
    matched++;
  } else {
    delete cam.sourceId; delete cam.systemSourceId; delete cam.uuid; delete cam.token;
    missing++;
  }
}

cameras.updated = new Date().toISOString();
fs.writeFileSync(camerasPath, JSON.stringify(cameras, null, 2), 'utf8');
console.log(`Credentials applied: ${matched}/${cameras.cameras.length} (${missing} without creds).`);
