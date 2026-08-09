/*
 * diag-hop.js — why does the second hop find the board but come back empty?
 *
 * render-scan finds delhivery.darwinbox.in / flipkart.turbohire.co /
 * jobs.hexaware.com correctly, navigates there, and still returns no jobs.
 * This walks the same path with the internals printed so the failing step is
 * visible instead of guessed at.
 */
const path = require('path');
const { chromium } = require('playwright');
const ROOT = path.dirname(__dirname);
const ENGINE = require(path.join(ROOT, 'w', 'test.js'));

const TARGETS = [
  ['Delhivery', 'https://www.delhivery.com/careers'],
  ['Flipkart', 'https://www.flipkartcareers.com/'],
  ['Hexaware Technologies', 'https://hexaware.com/careers/'],
];

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

(async () => {
  const b = await chromium.launch({ headless: true });
  const ctx = await b.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });

  for (const [name, careers] of TARGETS) {
    const page = await ctx.newPage();
    const jsonUrls = [];
    let jsonWithArrays = 0;

    page.on('response', async (res) => {
      try {
        const ct = res.headers()['content-type'] || '';
        if (!/json/i.test(ct) || res.status() >= 400) return;
        const body = await res.json().catch(() => null);
        if (!body) return;
        jsonUrls.push(res.url().slice(0, 78));
        const s = JSON.stringify(body);
        if (/\[\s*\{/.test(s) && s.length > 500) jsonWithArrays++;
      } catch {}
    });

    let site = '';
    try { site = new URL(careers).hostname.replace(/^www\./, ''); } catch {}

    console.log(`\n=== ${name} ===`);
    try {
      await page.goto(careers, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);

      const hrefs = await page.evaluate(() =>
        [...document.querySelectorAll('a[href]')].map((a) => a.href).filter(Boolean).slice(0, 400),
      );
      const target =
        hrefs.find((u) => { try { return ENGINE.ownAtsBoard(u, { name, site }); } catch { return false; } }) ||
        hrefs.find((u) => {
          try {
            const h = new URL(u).hostname.toLowerCase();
            return site && h !== site && h !== `www.${site}` && h.endsWith(`.${site}`) &&
              /^(jobs|careers|career|apply|hiring|recruit)\./.test(h);
          } catch { return false; }
        });

      console.log(`  hop target : ${target || 'NONE FOUND'}`);
      if (!target) { await page.close(); continue; }

      jsonUrls.length = 0;
      jsonWithArrays = 0;
      const resp = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => ({ err: e.message }));
      console.log(`  nav status : ${resp && resp.status ? resp.status() : 'ERR ' + (resp && resp.err || '').slice(0, 50)}`);
      await page.waitForTimeout(6000);
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await page.evaluate(() => window.scrollBy(0, 2500)).catch(() => {});
      await page.waitForTimeout(2500);

      const info = await page.evaluate(() => {
        const t = (document.body && document.body.innerText) || '';
        return {
          url: location.href,
          textLen: t.length,
          anchors: document.querySelectorAll('a[href]').length,
          jobbyAnchors: [...document.querySelectorAll('a[href]')].filter((a) =>
            /engineer|developer|manager|analyst|designer|architect|specialist|sde|qa/i.test(a.innerText || ''),
          ).length,
          sample: [...document.querySelectorAll('a[href]')]
            .map((a) => (a.innerText || '').trim().replace(/\s+/g, ' '))
            .filter((x) => x && x.length > 3)
            .slice(0, 6),
        };
      });
      console.log(`  landed on  : ${info.url.slice(0, 76)}`);
      console.log(`  text len   : ${info.textLen}   anchors: ${info.anchors}   role-ish anchors: ${info.jobbyAnchors}`);
      console.log(`  json calls : ${jsonUrls.length}  (with arrays: ${jsonWithArrays})`);
      jsonUrls.slice(0, 4).forEach((u) => console.log(`      ${u}`));
      console.log(`  anchor text: ${info.sample.join(' | ').slice(0, 150)}`);
    } catch (e) {
      console.log(`  ERR ${String(e.message).slice(0, 80)}`);
    }
    await page.close().catch(() => {});
  }
  await b.close();
})();
