// mint-tokens.js  —  PHASE 2 (fast, runs often, no browser)
// ---------------------------------------------------------------------------
// Reads camera-auth.json (the credentials from scrape-auth.js) and mints a
// FRESH stream token for every camera by POSTing straight to the ATMS endpoint
// — no browser, so all cameras refresh in about a minute. Writes cam.token into
// cameras.json (matched by chan); the app appends ?token=... at play time.
//
// Run:     node mint-tokens.js   (needs cameras.json + camera-auth.json)
// Effect:  updates cameras.json in place
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const ENDPOINT = 'https://vds.nc.insight-atms.com/api/SecureTokenUri/GetSecureTokenUriBySourceId';
const CONCURRENCY = 10;   // the token endpoint is fine with some parallelism (this isn't the video backend)
const RETRIES = 2;

const auth = JSON.parse(fs.readFileSync(path.join(__dirname, 'camera-auth.json'), 'utf8'));
const camerasPath = path.join(__dirname, 'cameras.json');
const cameras = JSON.parse(fs.readFileSync(camerasPath, 'utf8'));

async function mintOne(entry) {
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const resp = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Origin': 'https://www.drivenc.gov',
          'Referer': 'https://www.drivenc.gov/',
        },
        body: JSON.stringify({ token: entry.uuid, sourceId: entry.sourceId, systemSourceId: entry.systemSourceId }),
      });
      if (resp.ok) {
        const body = await resp.text();          // "?token=HEX"
        const m = body.match(/token=([0-9a-fA-F]+)/);
        if (m) return { chan: entry.chan, token: m[1] };
      }
    } catch (e) { /* retry */ }
    await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
  }
  return { chan: entry.chan, token: null };
}

async function run() {
  const entries = auth.entries;
  console.log(`Minting tokens for ${entries.length} cameras...`);

  const tokenByChan = {};
  let ok = 0, fail = 0;

  // simple concurrency pool
  let idx = 0;
  async function worker() {
    while (idx < entries.length) {
      const e = entries[idx++];
      const res = await mintOne(e);
      if (res.token) { tokenByChan[res.chan] = res.token; ok++; }
      else fail++;
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const chanOf = (u) => { const m = (u || '').match(/(chan-[0-9a-zA-Z_]+)/i); return m ? m[1].toLowerCase() : null; };
  let applied = 0;
  for (const cam of cameras.cameras) {
    const t = tokenByChan[chanOf(cam.videoUrl)];
    if (t) { cam.token = t; applied++; } else { delete cam.token; }
  }

  cameras.updated = new Date().toISOString();
  cameras.tokensUpdated = new Date().toISOString();
  fs.writeFileSync(camerasPath, JSON.stringify(cameras, null, 2), 'utf8');

  console.log(`Minted ${ok}, failed ${fail}. Applied tokens to ${applied} cameras in cameras.json.`);
  if (fail > ok) console.log('High failure rate — UUIDs may have rotated; re-run scrape-auth.js.');
}

run().catch(err => { console.error('Mint failed:', err); process.exit(1); });
