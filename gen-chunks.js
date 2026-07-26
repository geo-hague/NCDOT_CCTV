// gen-chunks.js — emits the job matrix: one entry per 50-camera page.
// For each I/US/NC roadway it reads the TRUE camera count from DriveNC's list
// info text (works even though the list only displays 100 at a time), then
// makes ceil(count/50) chunks. Prints a compact JSON array to stdout (logs go
// to stderr so they don't pollute the output the workflow captures).
const fs = require('fs');
const path = require('path');

const PAGE_SIZE = 50;
const ROADWAY_RE = /^(I|US|NC)-/i;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const log = (...a) => console.error(...a);

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
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent(UA);

  const roadways = distinctRoadways();
  const chunks = [];
  let id = 0;

  for (const roadway of roadways) {
    const url = `https://www.drivenc.gov/cctv?start=0&length=1` +
                `&filters%5B0%5D%5Bi%5D=3&filters%5B0%5D%5Bs%5D=${encodeURIComponent(roadway)}` +
                `&order%5Bi%5D=1&order%5Bdir%5D=asc`;
    let total = 0;
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });
      await new Promise(r => setTimeout(r, 1500));
      const info = await page.evaluate(() => {
        const el = document.querySelector('.dataTables_info') || document.querySelector('[class*="info"]');
        return el ? el.textContent : '';
      });
      const m = info.match(/of\s+([\d,]+)\s+entries/i);
      total = m ? parseInt(m[1].replace(/,/g, ''), 10) : 0;
    } catch (e) { log(`${roadway}: count error ${e.message}`); }

    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    for (let p = 0; p < pages; p++) chunks.push({ id: id++, roadway, start: p * PAGE_SIZE });
    log(`${roadway}: total=${total} -> ${pages} chunk(s)`);
  }

  await browser.close();
  log(`Total chunks: ${chunks.length}`);
  process.stdout.write(JSON.stringify(chunks));   // ONLY the JSON on stdout
}
run().catch(err => { console.error('gen-chunks failed:', err); process.exit(1); });
