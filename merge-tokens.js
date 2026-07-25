// merge-tokens.js
// Writes each camera's fresh stream token into cameras.json by matching chan.
// Run after scrape-tokens.js (and after fetch-cameras.js when that runs):
//   node merge-tokens.js
//
// The app reads cam.token and appends ?token=... to the stream URL. Cameras
// with no captured token (offline at scrape time) get no token and simply
// won't play until a later scrape picks them up.

const fs = require('fs');
const path = require('path');

const camerasPath = path.join(__dirname, 'cameras.json');
const cameras = JSON.parse(fs.readFileSync(camerasPath, 'utf8'));
const tokens = JSON.parse(fs.readFileSync(path.join(__dirname, 'tokens.json'), 'utf8'));

const byChan = new Map();
for (const e of tokens.entries) if (e.chan) byChan.set(e.chan.toLowerCase(), e);

const chanOf = (u) => {
  const m = (u || '').match(/(chan-[0-9a-zA-Z_]+)/i);
  return m ? m[1].toLowerCase() : null;
};

let matched = 0, missing = 0;
for (const cam of cameras.cameras) {
  const hit = byChan.get(chanOf(cam.videoUrl));
  if (hit) { cam.token = hit.token; matched++; }
  else { delete cam.token; missing++; }
}

cameras.updated = new Date().toISOString();
cameras.tokensUpdated = tokens.updated; // so you can see token freshness in the file
fs.writeFileSync(camerasPath, JSON.stringify(cameras, null, 2), 'utf8');
console.log(`Tokens applied: ${matched}/${cameras.cameras.length} (${missing} without a token).`);
