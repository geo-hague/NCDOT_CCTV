// scrape-tokens.js
// Captures the live ?token=... for each camera (like your I-26 scraper.js),
// across all I-/US-/NC- roadways, sharded for parallel jobs.
//
// ANTI-THROTTLE: DriveNC rate-limits a session after too many streams in a row
// (why big roadways like I-40/I-77 capture ~60%). So we cap every browser
// session at PAGE_SIZE cameras and launch a FRESH browser per page — matching
// the ~50-camera sessions your original ran without trouble.
//
// Env:  SHARD="k/N" (this job takes every Nth roadway), OUT_FILE (output name)
// Run:  node scrape-tokens.js   (needs cameras.json)

const fs = require('fs');
const path = require('path');

const PAGE_SIZE = 50;          // cameras per session — keep at/under ~50 to avoid throttling
const MAX_PAGES_PER_ROADWAY = 40;
const MAX_WAIT_MS = 20000;
const DEAD_ROW_MS = 5000;
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

// Scrape ONE page (<= PAGE_SIZE cameras) in its own fresh browser session.
// Returns { rows, captured, tokens: {chan: {token, host}} }.
async function scrapePage(puppeteer, roadway, start) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security'],
  });
  const out = { rows: 0, tokens: {} };
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 3000 });
    await page.setUserAgent(UA);

    let chan = null, token = null, host = null, activity = false;
    page.on('request', (req) => {
      const u = req.url();
      if (u.includes('GetSecureTokenUriBySourceId') || u.includes('.services.ncdot.gov') ||
          u.includes('m3u8') || u.includes('manifest') || u.includes('stream')) activity = true;
    });
    page.on('response', (response) => {
      const url = response.url();
      if (url.includes('index.m3u8') || url.includes('manifest.m3u8') || url.includes('stream')) {
        const cM = url.match(/(chan-[0-9a-zA-Z_]+)/i);
        const tM = url.match(/[?&]token=([0-9a-fA-F]+)/);
        if (cM && tM) { chan = cM[1].toLowerCase(); token = tM[1]; try { host = new URL(url).hostname.split('.')[0]; } catch (e) {} }
      }
    });

    await page.goto(pageUrl(roadway, start), { waitUntil: 'networkidle2', timeout: 120000 });
    await sleep(3000);
    await page.keyboard.press('Escape');

    const rows = await page.evaluate(() => document.querySelectorAll('table tbody tr').length);
    out.rows = rows;

    for (let i = 0; i < rows; i++) {
      chan = null; token = null; host = null; activity = false;

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

      const startT = Date.now();
      while (Date.now() - startT < MAX_WAIT_MS) {
        if (chan && token) break;
        if (!activity && Date.now() - startT > DEAD_ROW_MS) break;
        await sleep(150);
      }
      if (chan && token) out.tokens[chan] = { token, host };

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
  } finally {
    await browser.close();  // fresh session next page
  }
  return out;
}

async function run() {
  const puppeteer = require('puppeteer');
  const allRoadways = distinctRoadways();
  const [k, N] = (process.env.SHARD || '0/1').split('/').map(Number);
  const roadways = allRoadways.filter((_, idx) => idx % N === k);
  const OUT = process.env.OUT_FILE || 'tokens.json';
  console.log(`Shard ${k}/${N}: ${roadways.length} of ${allRoadways.length} roadways -> ${OUT}`);

  const byChan = {};
  for (const roadway of roadways) {
    let captured = 0, rowsTotal = 0;
    for (let p = 0; p < MAX_PAGES_PER_ROADWAY; p++) {
      let res;
      try { res = await scrapePage(puppeteer, roadway, p * PAGE_SIZE); }
      catch (e) { console.log(`${roadway} p${p}: ERROR ${e.message}`); break; }
      rowsTotal += res.rows;
      for (const [chan, v] of Object.entries(res.tokens)) { if (!byChan[chan]) captured++; byChan[chan] = v; }
      if (res.rows < PAGE_SIZE) break;
    }
    console.log(`${roadway}: rows=${rowsTotal} captured=${captured} [total ${Object.keys(byChan).length}]`);
  }

  const entries = Object.entries(byChan).map(([chan, v]) => ({ chan, ...v }));
  fs.writeFileSync(path.join(__dirname, OUT),
    JSON.stringify({ updated: new Date().toISOString(), count: entries.length, entries }, null, 2), 'utf8');
  console.log(`\nDone. ${entries.length} tokens -> ${OUT}`);
}
run().catch(err => { console.error('Scrape failed:', err); process.exit(1); });
