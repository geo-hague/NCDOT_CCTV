// merge-sourceids.js
// Overwrites each camera's sourceId + systemSourceId in cameras.json with the
// REAL scraped ATMS values, matched on chan (chan-XXXX in the videoUrl).
//
// Run AFTER fetch-cameras.js and scrape-sourceids.js:
//   node merge-sourceids.js
//
// sourceids.json is the durable artifact — re-run this merge whenever
// cameras.json is regenerated (the daily fetch would otherwise leave the wrong
// API values in place). Re-scrape occasionally to pick up new cameras.

const fs = require('fs');
const path = require('path');

const camerasPath = path.join(__dirname, 'cameras.json');
const cameras = JSON.parse(fs.readFileSync(camerasPath, 'utf8'));
const sourceIds = JSON.parse(fs.readFileSync(path.join(__dirname, 'sourceids.json'), 'utf8'));

const byChan = new Map();
for (const e of sourceIds.entries) if (e.chan) byChan.set(e.chan.toLowerCase(), e);

const chanOf = (u) => {
  const m = (u || '').match(/(chan-[0-9a-zA-Z_]+)/i);
  return m ? m[1].toLowerCase() : null;
};

let matched = 0;
const unmatched = [];
for (const cam of cameras.cameras) {
  const hit = byChan.get(chanOf(cam.videoUrl));
  if (hit) {
    cam.sourceId = hit.sourceId;            // real ATMS id, e.g. "825"
    cam.systemSourceId = hit.systemSourceId; // e.g. "Division 5"
    matched++;
  } else {
    // No scrape match -> remove any (wrong) API values so the app cleanly
    // falls back instead of sending a bad sourceId.
    delete cam.sourceId;
    delete cam.systemSourceId;
    unmatched.push(cam.location || cam.id);
  }
}

cameras.updated = new Date().toISOString();
fs.writeFileSync(camerasPath, JSON.stringify(cameras, null, 2), 'utf8');

console.log(`Matched ${matched}/${cameras.cameras.length}.`);
if (unmatched.length) {
  console.log(`${unmatched.length} unmatched (will fall back, won't play until re-scraped):`);
  console.log(unmatched.slice(0, 20).join(', ') + (unmatched.length > 20 ? ', ...' : ''));
}
