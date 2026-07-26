// scrape-tokens.js — scrapes ONE 50-camera page (one roadway, one start), in a
// single warm browser. Each job runs on its own GitHub runner (its own IP), so
// no IP ever does more than 50 cameras in a row — which is what keeps DriveNC
// from throttling (matches your original's safe ~50-camera session).
//
// Env:  ROADWAY, START (offset), OUT_FILE
// Run:  node scrape-tokens.js   (needs cameras.json only for the run to exist)

const fs = require('fs');
const path = require('path');

const PAGE_SIZE = 50;
const MAX_WAIT_MS = 20000;   // generous handshake window, like your original
const DEAD_ROW_MS = 5000;    // bail only on rows that fire nothing
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const ROADWAY = process.env.ROADWAY;
const START = parseInt(process.env.START || '0', 10);
const OUT = process.env.OUT_FILE || 'tokens-part.json';

function pageUrl(roadway, start) {
  return `https://www.drivenc.gov/cctv?start=${start}&length=${PAGE_SIZE}` +
         `&filters%5B0%5D%5Bi%5D=3&filters%5B0%5D%5Bs%5D=${encodeURIComponent(roadway)}` +
         `&order%5Bi%5D=1&order%5Bdir%5D=asc`;
}

async function run() {
  if (!ROADWAY) { console.error('No ROADWAY set'); process.exit(1); }
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security'],
  });
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

  await page.goto(pageUrl(ROADWAY, START), { waitUntil: 'networkidle2', timeout: 120000 });
  await sleep(3000);
  await page.keyboard.press('Escape');

  const rows = await page.evaluate(() => document.querySelectorAll('table tbody tr').length);
  const byChan = {};
  let captured = 0;

  const MAX_ATTEMPTS = 3;
  const RETRY_WAIT_MS = 12000; // per-attempt window after the first

  for (let i = 0; i < rows; i++) {
    let got = false;
    let sawButton = true;

    for (let attempt = 0; attempt < MAX_ATTEMPTS && !got && sawButton; attempt++) {
      // Clean slate so the click lands on the row, not a leftover modal overlay.
      await page.keyboard.press('Escape');
      await sleep(250);

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
      if (!clicked) { sawButton = false; break; } // not a video row — don't retry

      const window = attempt === 0 ? MAX_WAIT_MS : RETRY_WAIT_MS;
      const startT = Date.now();
      while (Date.now() - startT < window) {
        if (chan && token) break;
        if (!activity && Date.now() - startT > DEAD_ROW_MS) break; // nothing fired — retry
        await sleep(150);
      }

      if (chan && token) { if (!byChan[chan]) captured++; byChan[chan] = { token, host }; got = true; }

      // Force-close before the next attempt / next camera.
      await page.evaluate(() => {
        const els = [...document.querySelectorAll('button, a, span, .close, [data-dismiss="modal"]')];
        const c = els.find(el => {
          const t = (el.textContent || '').trim();
          return t.toLowerCase() === 'close' || t === '×' || el.classList.contains('close');
        });
        if (c) c.click();
      });
      await page.keyboard.press('Escape');
      await sleep(got ? 500 : 700);
    }
  }

  await browser.close();

  const entries = Object.entries(byChan).map(([chan, v]) => ({ chan, ...v }));
  fs.writeFileSync(path.join(__dirname, OUT),
    JSON.stringify({ updated: new Date().toISOString(), count: entries.length, entries }, null, 2), 'utf8');
  console.log(`${ROADWAY} @${START}: rows=${rows} captured=${captured} -> ${OUT}`);
}
run().catch(err => { console.error('Scrape failed:', err); process.exit(1); });
