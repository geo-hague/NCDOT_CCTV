// scrape-auth.js  —  PHASE 1 (slow, runs weekly)
// ---------------------------------------------------------------------------
// Captures each camera's minting credentials: sourceId, systemSourceId, uuid.
// Works exactly like the proven token scrape — everything captured SYNCHRONOUSLY
// from request URLs/payloads, no response-body reading (that async read raced
// the video request and captured nothing). Per click we grab:
//   - the trio from the GetSecureTokenUriBySourceId POST payload
//   - the chan from the m3u8 request URL
// and pair them. Sequential (video backend refuses concurrent streams). I/US/NC.
//
// Run:     node scrape-auth.js   (needs cameras.json)
// Output:  camera-auth.json      (chan -> { sourceId, systemSourceId, uuid })
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const PAGE_SIZE = 100;
const MAX_PAGES_PER_ROADWAY = 20;
// Your original scraper waited a flat 20s per camera because DriveNC handshakes
// are slow — the m3u8 can take 8-15s to fire. We keep that generous ceiling for
// any camera that shows network activity, but bail early on a row that produces
// nothing (a dead row — waiting longer won't help it), so the full run stays
// bounded instead of taking 3-4 hours.
const MAX_WAIT_MS = 20000;   // ceiling for slow handshakes (matches your original)
const DEAD_ROW_MS = 5000;    // if no request fires at all by here, give up on the row
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

  // Both captured synchronously in the request handler — no response reading.
  let trio = null, chan = null;
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('GetSecureTokenUriBySourceId')) {
      try {
        const d = JSON.parse(req.postData() || '{}');
        if (d.sourceId && d.token) {
          trio = { sourceId: String(d.sourceId), systemSourceId: String(d.systemSourceId || ''), uuid: String(d.token) };
        }
      } catch (e) {}
    }
    const u = req.url();
    if (u.includes('index.m3u8') || u.includes('manifest.m3u8') || u.includes('stream')) {
      const cM = u.match(/(chan-[0-9a-zA-Z_]+)/i);
      if (cM) chan = cM[1].toLowerCase();
    }
  });

  const byChan = {};
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
        trio = null; chan = null;

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

        // Wait up to MAX_WAIT_MS for a responsive camera; bail at DEAD_ROW_MS
        // if nothing fired at all. Exit the instant we have both pieces.
        const startT = Date.now();
        let sawActivity = false;
        while (Date.now() - startT < MAX_WAIT_MS) {
          if (trio || chan) sawActivity = true;
          if (trio && chan) break;
          if (!sawActivity && Date.now() - startT > DEAD_ROW_MS) break;
          await sleep(150);
        }

        if (trio && chan) { if (!byChan[chan]) captured++; byChan[chan] = trio; }

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
