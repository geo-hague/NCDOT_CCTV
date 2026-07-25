// scrape-sourceids.js
// ---------------------------------------------------------------------------
// Captures the REAL ATMS sourceId + systemSourceId for every camera, which the
// public API does NOT expose. For each camera we click "Show Video" and record:
//
//   1. the POST to GetSecureTokenUriBySourceId -> { sourceId, systemSourceId }
//        e.g. sourceId "825", systemSourceId "Division 5"
//   2. the chan-XXXX/index.m3u8 request        -> the chan id
//        e.g. chan-5671_l
//
// chan is the join key back to cameras.json (its videoUrl contains chan-XXXX).
// NOTE: the API's own SourceId field equals the chan number (5671), NOT the
// ATMS sourceId (825) — that's why scraping is required.
//
// The DriveNC list shows max 100 rows per page, so this pages through with the
// `start` URL param until a page returns no rows.
//
// Run with:  node scrape-sourceids.js
// Output:    sourceids.json
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const PAGE_SIZE = 100;                 // DriveNC caps the list at 100/page
const MAX_PAGES = 40;                  // safety stop (40 * 100 = 4000 cameras)
const PER_CAMERA_TIMEOUT_MS = 8000;    // wait per click for both requests
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function pageUrl(start) {
  // No route filter = the full inventory, paged. order params match the site.
  return `https://www.drivenc.gov/cctv?start=${start}&length=${PAGE_SIZE}&order%5Bi%5D=1&order%5Bdir%5D=asc`;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
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
        if (d.sourceId) {
          lastPost = { sourceId: String(d.sourceId), systemSourceId: String(d.systemSourceId || '') };
        }
      } catch (e) {}
    }
    const u = req.url();
    if (u.includes('index.m3u8') || u.includes('manifest.m3u8') || u.includes('/stream')) {
      const m = u.match(/(chan-[0-9a-zA-Z_]+)/i);
      if (m) {
        lastChan = m[1].toLowerCase();
        try { lastHost = new URL(u).hostname.split('.')[0]; } catch (e) {}
      }
    }
  });

  const byChan = {};
  let totalCaptured = 0;

  for (let p = 0; p < MAX_PAGES; p++) {
    const start = p * PAGE_SIZE;
    console.log(`\n=== Page ${p + 1} (start=${start}) ===`);
    await page.goto(pageUrl(start), { waitUntil: 'networkidle2', timeout: 120000 });
    await sleep(4000);
    await page.keyboard.press('Escape');

    const rows = await page.evaluate(() => document.querySelectorAll('table tbody tr').length);
    if (!rows) { console.log('No rows — reached the end.'); break; }
    console.log(`${rows} rows on this page.`);

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
        byChan[lastChan] = { ...lastPost, host: lastHost };
        totalCaptured++;
        console.log(`  ${lastChan} -> ${lastPost.sourceId} (${lastPost.systemSourceId})`);
      } else {
        console.log(`  row ${i}: no capture (post=${!!lastPost} chan=${!!lastChan})`);
      }

      await page.evaluate(() => {
        const els = [...document.querySelectorAll('button, a, span, .close, [data-dismiss="modal"]')];
        const c = els.find(el => {
          const t = (el.textContent || '').trim();
          return t.toLowerCase() === 'close' || t === '×' || el.classList.contains('close');
        });
        if (c) c.click();
      });
      await sleep(400);
    }

    if (rows < PAGE_SIZE) { console.log('Last page (partial).'); break; }
  }

  await browser.close();

  const entries = Object.entries(byChan).map(([chan, v]) => ({ chan, ...v }));
  fs.writeFileSync(
    path.join(__dirname, 'sourceids.json'),
    JSON.stringify({ updated: new Date().toISOString(), count: entries.length, entries }, null, 2),
    'utf8'
  );
  console.log(`\nDone. Captured ${totalCaptured} cameras -> sourceids.json`);
}

run().catch(err => { console.error('Scrape failed:', err); process.exit(1); });
