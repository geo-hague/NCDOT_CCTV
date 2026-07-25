// scrape-sourceids.js
// ---------------------------------------------------------------------------
// Captures the real ATMS sourceId + systemSourceId for every camera by driving
// the DriveNC site. The public API does NOT expose these, so we click each
// camera's "Show Video" and record:
//   1. the POST to GetSecureTokenUriBySourceId -> { sourceId, systemSourceId }
//   2. the chan-XXXX/index.m3u8 request        -> the chan id (join key)
//
// COVERAGE: the flat unfiltered list does not reliably contain every camera, so
// we loop over each ROADWAY (using the roadway filter the site exposes) and
// paginate within each. Roadways are read straight from cameras.json, so we
// cover exactly the routes you actually have. Results are de-duped by chan, so
// cameras on concurrent routes are only captured once.
//
// Run:     node scrape-sourceids.js   (needs cameras.json present)
// Output:  sourceids.json
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const PAGE_SIZE = 100;
const MAX_PAGES_PER_ROADWAY = 20;
const PER_CAMERA_TIMEOUT_MS = 9000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// filters[0][i]=3 is the roadway filter; [s] is the roadway value (e.g. I-485).
function pageUrl(roadway, start) {
  const r = encodeURIComponent(roadway);
  return `https://www.drivenc.gov/cctv?start=${start}&length=${PAGE_SIZE}` +
         `&filters%5B0%5D%5Bi%5D=3&filters%5B0%5D%5Bs%5D=${r}` +
         `&order%5Bi%5D=1&order%5Bdir%5D=asc`;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function distinctRoadways() {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'cameras.json'), 'utf8'));
  const set = new Set();
  for (const c of data.cameras) {
    if (c.roadway && String(c.roadway).trim()) set.add(String(c.roadway).trim());
  }
  return [...set].sort();
}

async function run() {
  const roadways = distinctRoadways();
  console.log(`Scraping ${roadways.length} roadways: ${roadways.join(', ')}`);

  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 4000 });
  await page.setUserAgent(UA);

  let lastPost = null, lastChan = null, lastHost = null;
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('GetSecureTokenUriBySourceId')) {
      try {
        const d = JSON.parse(req.postData() || '{}');
        if (d.sourceId) lastPost = { sourceId: String(d.sourceId), systemSourceId: String(d.systemSourceId || '') };
      } catch (e) {}
    }
    const u = req.url();
    if (u.includes('index.m3u8') || u.includes('manifest.m3u8') || u.includes('/stream')) {
      const m = u.match(/(chan-[0-9a-zA-Z_]+)/i);
      if (m) { lastChan = m[1].toLowerCase(); try { lastHost = new URL(u).hostname.split('.')[0]; } catch (e) {} }
    }
  });

  const byChan = {};
  let downCount = 0;

  for (const roadway of roadways) {
    let roadwayCount = 0;
    for (let p = 0; p < MAX_PAGES_PER_ROADWAY; p++) {
      await page.goto(pageUrl(roadway, p * PAGE_SIZE), { waitUntil: 'networkidle2', timeout: 120000 });
      await sleep(3500);
      await page.keyboard.press('Escape');

      const rows = await page.evaluate(() => document.querySelectorAll('table tbody tr').length);
      if (!rows) break;

      for (let i = 0; i < rows; i++) {
        lastPost = null; lastChan = null; lastHost = null;

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
        while (Date.now() < deadline && !(lastPost && lastChan)) await sleep(150);

        if (lastPost && lastChan) {
          if (!byChan[lastChan]) roadwayCount++;
          byChan[lastChan] = { ...lastPost, host: lastHost };
        } else {
          downCount++;
        }

        await page.evaluate(() => {
          const els = [...document.querySelectorAll('button, a, span, .close, [data-dismiss="modal"]')];
          const c = els.find(el => {
            const t = (el.textContent || '').trim();
            return t.toLowerCase() === 'close' || t === '×' || el.classList.contains('close');
          });
          if (c) c.click();
        });
        await sleep(350);
      }

      if (rows < PAGE_SIZE) break;
    }
    console.log(`${roadway}: +${roadwayCount} new (total ${Object.keys(byChan).length})`);
  }

  await browser.close();

  const entries = Object.entries(byChan).map(([chan, v]) => ({ chan, ...v }));
  fs.writeFileSync(
    path.join(__dirname, 'sourceids.json'),
    JSON.stringify({ updated: new Date().toISOString(), count: entries.length, entries }, null, 2),
    'utf8'
  );
  console.log(`\nDone. ${entries.length} cameras captured, ${downCount} no-capture (offline or slow). -> sourceids.json`);
}

run().catch(err => { console.error('Scrape failed:', err); process.exit(1); });
