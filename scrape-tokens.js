// scrape-tokens.js
// Same idea as your I-26 scraper.js: click each camera, capture the real
// ?token=... off the live stream URL. Generalised to every I-/US-/NC- roadway
// and written to tokens.json (chan -> token) instead of editing index.html.
// merge-tokens.js bakes those into cameras.json; refresh on a schedule.
//
// Run:  node scrape-tokens.js   (needs cameras.json)   Output: tokens.json

const fs = require('fs');
const path = require('path');

const PAGE_SIZE = 100;
const MAX_PAGES_PER_ROADWAY = 20;
const MAX_WAIT_MS = 20000;   // your original's generous handshake window
const DEAD_ROW_MS = 5000;    // bail early if a row fires nothing (bounds runtime)
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
  console.log(`Scraping ${roadways.length} I/US/NC roadways.`);

  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 3000 });
  await page.setUserAgent(UA);

  let chan = null, token = null, host = null;
  page.on('response', (response) => {          // response event, like your scraper.js
    const url = response.url();
    if (url.includes('index.m3u8') || url.includes('manifest.m3u8') || url.includes('stream')) {
      const cM = url.match(/(chan-[0-9a-zA-Z_]+)/i);
      const tM = url.match(/[?&]token=([0-9a-fA-F]+)/);
      if (cM && tM) { chan = cM[1].toLowerCase(); token = tM[1]; try { host = new URL(url).hostname.split('.')[0]; } catch (e) {} }
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
        chan = null; token = null; host = null;

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
        let sawActivity = false;
        while (Date.now() - startT < MAX_WAIT_MS) {
          if (chan || token) sawActivity = true;
          if (chan && token) break;
          if (!sawActivity && Date.now() - startT > DEAD_ROW_MS) break;
          await sleep(150);
        }
        if (chan && token) { if (!byChan[chan]) captured++; byChan[chan] = { token, host }; }

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
  fs.writeFileSync(path.join(__dirname, 'tokens.json'),
    JSON.stringify({ updated: new Date().toISOString(), count: entries.length, entries }, null, 2), 'utf8');
  console.log(`\nDone. ${entries.length} tokens -> tokens.json`);
}
run().catch(err => { console.error('Scrape failed:', err); process.exit(1); });
