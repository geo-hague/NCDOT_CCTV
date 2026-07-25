// scrape-auth.js  —  PHASE 1 (slow, runs weekly)
// ---------------------------------------------------------------------------
// Captures each camera's TOKEN-MINTING CREDENTIALS, not the token itself:
//   sourceId, systemSourceId, and the per-camera UUID (the "token" field in the
//   GetSecureTokenUriBySourceId POST). These are stable for at least a day, so
//   we grab them rarely; mint-tokens.js uses them to mint fresh tokens fast.
//
// Pairing is robust: we read the POST body (the trio) AND the POST response
// (the stream token it returns), then match that stream token to the m3u8 URL
// (which carries chan + the same token). So chan is tied to the exact trio that
// produced it — no cross-camera mixups. Sequential, one camera at a time,
// because the video backend refuses concurrent streams. I-/US-/NC- only.
//
// Run:     node scrape-auth.js   (needs cameras.json present)
// Output:  camera-auth.json      (chan -> { sourceId, systemSourceId, uuid })
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const PAGE_SIZE = 100;
const MAX_PAGES_PER_ROADWAY = 20;
const PER_CAMERA_TIMEOUT_MS = 10000;
const ROADWAY_RE = /^(I|US|NC)-/i;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function pageUrl(roadway, start) {
  const r = encodeURIComponent(roadway);
  return `https://www.drivenc.gov/cctv?start=${start}&length=${PAGE_SIZE}` +
         `&filters%5B0%5D%5Bi%5D=3&filters%5B0%5D%5Bs%5D=${r}` +
         `&order%5Bi%5D=1&order%5Bdir%5D=asc`;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function distinctRoadways() {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'cameras.json'), 'utf8'));
  const set = new Set();
  for (const c of data.cameras) {
    const rw = c.roadway && String(c.roadway).trim();
    if (rw && ROADWAY_RE.test(rw)) set.add(rw);
  }
  return [...set].sort();
}

async function run() {
  const roadways = distinctRoadways();
  console.log(`Scraping ${roadways.length} I/US/NC roadways (sequential).`);

  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 3000 });
  await page.setUserAgent(UA);

  const byChan = {};
  let pendingTrio = null;            // trio from a POST awaiting its response
  const trioByStreamToken = {};      // streamToken -> trio
  let lastRecorded = null;           // chan recorded on the current click

  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('GetSecureTokenUriBySourceId')) {
      try {
        const d = JSON.parse(req.postData() || '{}');
        if (d.sourceId && d.token) {
          pendingTrio = { sourceId: String(d.sourceId), systemSourceId: String(d.systemSourceId || ''), uuid: String(d.token) };
        }
      } catch (e) {}
    }
    const u = req.url();
    if (u.includes('index.m3u8') || u.includes('manifest.m3u8') || u.includes('/stream')) {
      const cM = u.match(/(chan-[0-9a-zA-Z_]+)/i);
      const tM = u.match(/[?&]token=([0-9a-fA-F]+)/);
      if (cM && tM) {
        const trio = trioByStreamToken[tM[1]];
        if (trio) { byChan[cM[1].toLowerCase()] = trio; lastRecorded = cM[1].toLowerCase(); }
      }
    }
  });

  page.on('response', async (resp) => {
    const req = resp.request();
    if (req.method() === 'POST' && req.url().includes('GetSecureTokenUriBySourceId')) {
      try {
        const body = await resp.text();               // "?token=HEX"
        const m = body.match(/token=([0-9a-fA-F]+)/);
        if (m && pendingTrio) { trioByStreamToken[m[1]] = pendingTrio; pendingTrio = null; }
      } catch (e) {}
    }
  });

  let done = 0;
  for (const roadway of roadways) {
    let rowsTotal = 0, captured = 0;
    for (let p = 0; p < MAX_PAGES_PER_ROADWAY; p++) {
      await page.goto(pageUrl(roadway, p * PAGE_SIZE), { waitUntil: 'networkidle2', timeout: 120000 });
      await sleep(3000);
      await page.keyboard.press('Escape');

      const rows = await page.evaluate(() => document.querySelectorAll('table tbody tr').length);
      if (!rows) break;
      rowsTotal += rows;

      for (let i = 0; i < rows; i++) {
        lastRecorded = null;

        const clicked = await page.evaluate((rowIndex) => {
          const r = document.querySelectorAll('table tbody tr')[rowIndex];
          if (!r) return false;
          r.scrollIntoView({ block: 'center', behavior: 'instant' });
          const els = [...r.querySelectorAll('button, a, span, td')];
          const btn = els.find(el => (el.textContent || '').trim().toLowerCase() === 'show video');
          if (btn) { btn.click(); return true; }
          return false;
        }, i);
        if (!clicked) continue;

        const deadline = Date.now() + PER_CAMERA_TIMEOUT_MS;
        while (Date.now() < deadline && !lastRecorded) await sleep(150);
        if (lastRecorded) captured++;

        await page.evaluate(() => {
          const els = [...document.querySelectorAll('button, a, span, .close, [data-dismiss="modal"]')];
          const c = els.find(el => {
            const t = (el.textContent || '').trim();
            return t.toLowerCase() === 'close' || t === '×' || el.classList.contains('close');
          });
          if (c) c.click();
        });
        await sleep(300);
      }
      if (rows < PAGE_SIZE) break;
    }
    done++;
    console.log(`${roadway}: rows=${rowsTotal} captured=${captured} [${done}/${roadways.length}, total ${Object.keys(byChan).length}]`);
  }

  await browser.close();

  const entries = Object.entries(byChan).map(([chan, v]) => ({ chan, ...v }));
  fs.writeFileSync(
    path.join(__dirname, 'camera-auth.json'),
    JSON.stringify({ updated: new Date().toISOString(), count: entries.length, entries }, null, 2),
    'utf8'
  );
  console.log(`\nDone. ${entries.length} camera credentials -> camera-auth.json`);
}

run().catch(err => { console.error('Scrape failed:', err); process.exit(1); });
