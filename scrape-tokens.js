// scrape-tokens.js
// ---------------------------------------------------------------------------
// Your original approach, done for every camera. For each camera we click
// "Show Video" and grab the ACTUAL stream URL, which now looks like:
//
//   https://cfase04.services.ncdot.gov:8887/chan-5381_l/index.m3u8?token=4d2aeb...
//
// Both the chan and the token live in that one URL, so we capture them together
// (no pairing races, no sourceId, no per-camera UUID, no worker). We store
// chan -> token, and merge-tokens.js writes the token onto the matching camera
// in cameras.json. Tokens expire, so this is meant to run on a schedule (see
// refresh-camera-tokens.yml) to keep them fresh.
//
// Roadways are read from cameras.json so we cover every route you have.
//
// Run:     node scrape-tokens.js   (needs cameras.json present)
// Output:  tokens.json
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const PAGE_SIZE = 100;
const MAX_PAGES_PER_ROADWAY = 20;
const PER_CAMERA_TIMEOUT_MS = 9000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

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
  for (const c of data.cameras) if (c.roadway && String(c.roadway).trim()) set.add(String(c.roadway).trim());
  return [...set].sort();
}

async function run() {
  const roadways = distinctRoadways();
  console.log(`Scraping ${roadways.length} roadways.`);

  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 4000 });
  await page.setUserAgent(UA);

  // Capture chan + token from the SAME stream URL — atomic, no mispairing.
  let lastChan = null, lastToken = null, lastHost = null;
  page.on('request', (req) => {
    const u = req.url();
    if (u.includes('index.m3u8') || u.includes('manifest.m3u8') || u.includes('/stream')) {
      const chanM  = u.match(/(chan-[0-9a-zA-Z_]+)/i);
      const tokM   = u.match(/[?&]token=([0-9a-fA-F]+)/);
      if (chanM && tokM) {
        lastChan = chanM[1].toLowerCase();
        lastToken = tokM[1];
        try { lastHost = new URL(u).hostname.split('.')[0]; } catch (e) {}
      }
    }
  });

  const byChan = {};
  let down = 0;

  for (const roadway of roadways) {
    let added = 0;
    for (let p = 0; p < MAX_PAGES_PER_ROADWAY; p++) {
      await page.goto(pageUrl(roadway, p * PAGE_SIZE), { waitUntil: 'networkidle2', timeout: 120000 });
      await sleep(3500);
      await page.keyboard.press('Escape');

      const rows = await page.evaluate(() => document.querySelectorAll('table tbody tr').length);
      if (!rows) break;

      for (let i = 0; i < rows; i++) {
        lastChan = null; lastToken = null; lastHost = null;

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
        while (Date.now() < deadline && !(lastChan && lastToken)) await sleep(150);

        if (lastChan && lastToken) {
          if (!byChan[lastChan]) added++;
          byChan[lastChan] = { token: lastToken, host: lastHost };
        } else {
          down++;
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
    console.log(`${roadway}: +${added} (total ${Object.keys(byChan).length})`);
  }

  await browser.close();

  const entries = Object.entries(byChan).map(([chan, v]) => ({ chan, ...v }));
  fs.writeFileSync(
    path.join(__dirname, 'tokens.json'),
    JSON.stringify({ updated: new Date().toISOString(), count: entries.length, entries }, null, 2),
    'utf8'
  );
  console.log(`\nDone. ${entries.length} tokens captured, ${down} no-capture (offline). -> tokens.json`);
}

run().catch(err => { console.error('Scrape failed:', err); process.exit(1); });
