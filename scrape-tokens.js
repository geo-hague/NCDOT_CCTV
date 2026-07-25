// scrape-tokens.js
// ---------------------------------------------------------------------------
// Clicks each camera's "Show Video" and captures the real stream URL
//   https://.../chan-5381_l/index.m3u8?token=4d2aeb...
// pulling chan + token from that one URL (atomic, no mispairing). Writes
// chan -> token to tokens.json; merge-tokens.js applies it to cameras.json.
//
// Runs several browser tabs IN PARALLEL (CONCURRENCY) to cut wall-clock time,
// each tab with its own capture state so they don't cross wires. Roadways are
// pulled from a shared queue so the tabs stay balanced. Only I-/US-/NC- roads
// are scraped (others have no cameras and just waste time).
//
// Run:     node scrape-tokens.js   (needs cameras.json present)
// Output:  tokens.json
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const CONCURRENCY = 4;                 // parallel tabs; lower to 2 if DriveNC pushes back
const PAGE_SIZE = 100;
const MAX_PAGES_PER_ROADWAY = 20;
const PER_CAMERA_TIMEOUT_MS = 6000;    // working cams resolve in ~2s; this caps the wait on dead ones
const ROADWAY_RE = /^(I|US|NC)-/i;     // skip ramps/minor roads with no cameras
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

async function makeTab(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 3000 });
  await page.setUserAgent(UA);
  const state = { chan: null, token: null, host: null };
  page.on('request', (req) => {           // fires ONLY for this tab's requests
    const u = req.url();
    if (u.includes('index.m3u8') || u.includes('manifest.m3u8') || u.includes('/stream')) {
      const chanM = u.match(/(chan-[0-9a-zA-Z_]+)/i);
      const tokM  = u.match(/[?&]token=([0-9a-fA-F]+)/);
      if (chanM && tokM) {
        state.chan = chanM[1].toLowerCase();
        state.token = tokM[1];
        try { state.host = new URL(u).hostname.split('.')[0]; } catch (e) {}
      }
    }
  });
  return { page, state };
}

async function processRoadway(tab, roadway, byChan, counters) {
  const { page, state } = tab;
  let rows_total = 0, captured = 0;

  for (let p = 0; p < MAX_PAGES_PER_ROADWAY; p++) {
    await page.goto(pageUrl(roadway, p * PAGE_SIZE), { waitUntil: 'networkidle2', timeout: 120000 });
    await sleep(2500);
    await page.keyboard.press('Escape');

    const rows = await page.evaluate(() => document.querySelectorAll('table tbody tr').length);
    if (!rows) break;
    rows_total += rows;

    for (let i = 0; i < rows; i++) {
      state.chan = null; state.token = null; state.host = null;

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
      while (Date.now() < deadline && !(state.chan && state.token)) await sleep(120);

      if (state.chan && state.token) {
        if (!byChan[state.chan]) captured++;
        byChan[state.chan] = { token: state.token, host: state.host };
      }

      await page.evaluate(() => {
        const els = [...document.querySelectorAll('button, a, span, .close, [data-dismiss="modal"]')];
        const c = els.find(el => {
          const t = (el.textContent || '').trim();
          return t.toLowerCase() === 'close' || t === '×' || el.classList.contains('close');
        });
        if (c) c.click();
      });
      await sleep(250);
    }
    if (rows < PAGE_SIZE) break;
  }

  counters.done++;
  console.log(`${roadway}: rows=${rows_total} captured=${captured} ` +
              `[${counters.done}/${counters.total} roadways, total tokens ${Object.keys(byChan).length}]`);
}

async function run() {
  const roadways = distinctRoadways();
  console.log(`Scraping ${roadways.length} I/US/NC roadways with ${CONCURRENCY} parallel tabs.`);

  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security'],
  });

  const tabs = await Promise.all(Array.from({ length: CONCURRENCY }, () => makeTab(browser)));
  const queue = [...roadways];
  const byChan = {};
  const counters = { done: 0, total: roadways.length };

  await Promise.all(tabs.map(async (tab) => {
    while (queue.length) {
      const rw = queue.shift();
      if (rw === undefined) break;
      try { await processRoadway(tab, rw, byChan, counters); }
      catch (e) { console.log(`${rw}: ERROR ${e.message}`); counters.done++; }
    }
  }));

  await browser.close();

  const entries = Object.entries(byChan).map(([chan, v]) => ({ chan, ...v }));
  fs.writeFileSync(
    path.join(__dirname, 'tokens.json'),
    JSON.stringify({ updated: new Date().toISOString(), count: entries.length, entries }, null, 2),
    'utf8'
  );
  console.log(`\nDone. ${entries.length} tokens captured -> tokens.json`);
}

run().catch(err => { console.error('Scrape failed:', err); process.exit(1); });
