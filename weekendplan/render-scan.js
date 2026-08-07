#!/usr/bin/env node
/*
 * render-scan.js — second pass for boards that plain fetch() cannot read.
 *
 * 36% of the universe came back "careers page read but lists no openings",
 * including Flipkart, Coforge, Delhivery, MakeMyTrip, Nykaa and Hexaware —
 * companies that plainly do have open roles. Probing 120 of them found no
 * dominant ATS to add: 73% are single-page apps that fetch their jobs over
 * XHR after the HTML arrives. So there is nothing to parse in the HTML, and
 * one more provider integration would not move the number.
 *
 * This renders those pages in Chromium instead, and takes jobs from whichever
 * of two sources works:
 *   1. the XHR responses themselves — structured JSON, so titles/locations/
 *      URLs come out clean. Preferred.
 *   2. the rendered DOM — anchors that look like postings. Fallback.
 *
 * Scoring is imported from w/test.js so rendered jobs are judged by exactly
 * the same rules as fetched ones. Results are merged back into each letter's
 * results.json in place, so weekendplan/build.js needs no changes.
 *
 *   node weekendplan/render-scan.js                 # every unread board
 *   node weekendplan/render-scan.js --letters=a,b   # just these
 *   node weekendplan/render-scan.js --limit=20 --headed
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.dirname(__dirname);
const ENGINE = require(path.join(ROOT, 'w', 'test.js'));

const ARGS = process.argv.slice(2);
const argVal = (k, d) => {
  const a = ARGS.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const LETTERS = (argVal('letters', 'abcdefghijklmnopqrstuvwxyz') || '').split(/[,]?/).filter((c) => /[a-z]/.test(c));
const LIMIT = parseInt(argVal('limit', '0'), 10) || 0;
const CONCURRENCY = parseInt(argVal('concurrency', '6'), 10);
const PAGE_MS = parseInt(argVal('pagems', '30000'), 10);
const HEADED = ARGS.includes('--headed');

const RETRY = /lists-no-openings|no-job-data-found|blocked-or-error|timed-out|unreachable/;

/* ------------------------------------------------------------------ *
 * Recognising a job inside arbitrary JSON
 * ------------------------------------------------------------------ */

const TITLE_KEYS = ['title', 'jobTitle', 'name', 'positionName', 'post_name', 'designation', 'position'];
const LOC_KEYS = ['location', 'city', 'jobLocation', 'locationName', 'work_location', 'primaryLocation', 'locations'];
const URL_KEYS = ['url', 'jobUrl', 'applyUrl', 'link', 'href', 'canonicalUrl', 'detailUrl'];

const pick = (o, keys) => {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
    if (v && typeof v === 'object') {
      const s = v.name || v.label || v.city || v.title;
      if (typeof s === 'string' && s.trim()) return s.trim();
    }
  }
  return '';
};

const JOBBY = /\b(engineer|developer|manager|analyst|designer|architect|consultant|executive|specialist|lead|intern|associate|scientist|officer|administrator|technician|sde|qa|tester)\b/i;

/*
 * A rendered careers page sits inside the marketing site, so the same anchor
 * sweep also picks up the blog roll and the services menu. Both are full of
 * role nouns and sail through JOBBY: "Top 3 AI Tools to Increase Productivity
 * of Java Developers" is an article, "Hire a Java developer" is a sales page.
 * Neither is an opening, and one agency contributed 120 of them.
 */
const NOT_POSTING = new RegExp(
  [
    // article and announcement headlines
    '^(top|how|why|what|when|where|which|\\d+\\s)\\b',
    '^(introducing|announcing|celebrating|understanding|exploring|boosting|building|unlocking|leveraging|navigating)\\b',
    '\\b(honoured|honored|awarded|recognised|recognized|wins\\b|announces|launches|partners with|case study|webinar|whitepaper|blog|newsletter|press release)\\b',
    '\\bthe future of\\b|\\ba guide\\b|\\bguide to\\b|\\btips\\b|\\bbenefits of\\b|\\bvs\\.?\\b',
    // "hire an X developer" — a services page, not a vacancy
    '^hire\\s',
    // headlines end in a question; job titles do not
    '\\?\\s*$',
  ].join('|'),
  'i',
);

/** Job titles are short noun phrases. Prose is a headline. */
function looksLikePosting(title) {
  if (!title || NOT_POSTING.test(title)) return false;
  if (title.split(/\s+/).length > 12) return false;
  return true;
}

/** Does this object look like a job posting rather than a nav item? */
function asJob(o, base) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const title = pick(o, TITLE_KEYS);
  if (!title || title.length < 3 || title.length > 160) return null;
  if (!looksLikePosting(title)) return null;
  /*
   * Marketing sites serve their blog and customer list from the same content
   * API the careers page uses, so "having a title and a location" is not
   * enough — that let a telecom vendor contribute 83 case studies and customer
   * names ("Africell", "Digital BSS: The Cornerstone of Telecom Evolution").
   * Demand real evidence of a vacancy: a role noun in the title, or an
   * explicit requisition identifier.
   */
  const hasJobShape =
    JOBBY.test(title) ||
    o.jobId || o.job_id || o.requisitionId || o.reqId || o.jobCode || o.vacancyId || o.postingId;
  if (!hasJobShape) return null;

  let url = pick(o, URL_KEYS);
  if (url && !/^https?:/i.test(url)) {
    try { url = new URL(url, base).href; } catch { url = ''; }
  }
  const text = [o.description, o.jobDescription, o.summary, o.qualifications, o.requirements]
    .filter((x) => typeof x === 'string')
    .join(' ');
  return {
    title,
    location: pick(o, LOC_KEYS),
    url: url || base,
    team: pick(o, ['department', 'team', 'category', 'function']),
    text: ENGINE.stripHtml(text).slice(0, 14000),
  };
}

/** Walk arbitrary JSON and collect anything job-shaped. */
function harvest(node, base, out, depth = 0) {
  if (!node || depth > 7 || out.length > 600) return;
  if (Array.isArray(node)) {
    // An array of job-shaped objects is the payload we want.
    let hits = 0;
    for (const item of node) {
      const j = asJob(item, base);
      if (j) { out.push(j); hits++; }
    }
    if (!hits) for (const item of node) harvest(item, base, out, depth + 1);
    return;
  }
  if (typeof node === 'object') for (const v of Object.values(node)) harvest(v, base, out, depth + 1);
}

/* ------------------------------------------------------------------ *
 * Rendering one company
 * ------------------------------------------------------------------ */

async function renderOne(ctx, company) {
  const base = company.careers;
  const page = await ctx.newPage();
  const fromXhr = [];

  page.on('response', async (res) => {
    try {
      const ct = res.headers()['content-type'] || '';
      if (!/json/i.test(ct)) return;
      if (res.status() >= 400) return;
      const len = +(res.headers()['content-length'] || 0);
      if (len > 4_000_000) return;
      const body = await res.json().catch(() => null);
      if (body) harvest(body, base, fromXhr);
    } catch { /* response already consumed or navigated away */ }
  });

  try {
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: PAGE_MS });
    // SPAs fire their job XHR after first paint; give it a beat, then settle.
    await page.waitForTimeout(2500);
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    // Lazy lists often only load on scroll.
    await page.evaluate(() => window.scrollBy(0, 2000)).catch(() => {});
    await page.waitForTimeout(1200);
  } catch {
    /* keep whatever XHR we already captured */
  }

  let jobs = dedupe(fromXhr);

  if (!jobs.length) {
    // Fallback: read the rendered DOM.
    const dom = await page
      .evaluate((JOBBY_SRC) => {
        const re = new RegExp(JOBBY_SRC, 'i');
        const out = [];
        for (const a of document.querySelectorAll('a[href]')) {
          const t = (a.innerText || '').trim().replace(/\s+/g, ' ');
          if (!t || t.length < 4 || t.length > 140) continue;
          const href = a.href || '';
          const looksJobby = re.test(t) || /job|career|position|opening|vacanc|requisition/i.test(href);
          if (!looksJobby) continue;
          const row = a.closest('li,tr,article,div');
          const ctxText = row ? (row.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 400) : '';
          out.push({ title: t, url: href, text: ctxText });
        }
        return out.slice(0, 300);
      }, JOBBY.source)
      .catch(() => []);
    jobs = dedupe(
      dom
        .filter((j) => JOBBY.test(j.title) && looksLikePosting(j.title))
        // A DOM anchor only counts when its own href points at a posting; the
        // blog roll and services menu never do.
        .filter((j) => /job|career|position|opening|vacanc|requisition|apply/i.test(j.url))
        .map((j) => ({ title: j.title, location: '', url: j.url, team: '', text: j.text || '' })),
    );
  }

  await page.close().catch(() => {});
  return jobs;
}

function dedupe(jobs) {
  const seen = new Set();
  return jobs.filter((j) => {
    const k = `${j.title}|${j.url}`.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main() {
  // Collect every company still unread, across the requested letters.
  const targets = [];
  for (const L of LETTERS) {
    const f = path.join(ROOT, L, 'results.json');
    if (!fs.existsSync(f)) continue;
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    data.forEach((entry, i) => {
      if (entry.careers && RETRY.test(entry.error || '') && !(entry.jobs || []).length) {
        targets.push({ L, i, company: entry });
      }
    });
  }
  const list = LIMIT ? targets.slice(0, LIMIT) : targets;
  console.log(`Rendering ${list.length} unread board(s) across ${LETTERS.length} letter(s), concurrency ${CONCURRENCY}\n`);
  if (!list.length) return;

  const browser = await chromium.launch({ headless: !HEADED });
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
  });
  // Images/fonts/media are pure cost here — we only ever read text and JSON.
  await ctx.route('**/*', (route) => {
    const t = route.request().resourceType();
    return t === 'image' || t === 'font' || t === 'media' ? route.abort() : route.continue();
  });

  const found = new Map(); // "letter:index" -> jobs
  let done = 0;
  let idx = 0;

  const worker = async () => {
    while (idx < list.length) {
      const t = list[idx++];
      let jobs = [];
      try {
        jobs = await renderOne(ctx, t.company);
      } catch (e) {
        jobs = [];
      }
      done++;
      if (jobs.length) found.set(`${t.L}:${t.i}`, jobs);
      const tag = jobs.length ? `${String(jobs.length).padStart(3)} jobs` : '  -    ';
      console.log(`[${String(done).padStart(4)}/${list.length}] ${tag}  ${t.company.company}`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await browser.close();

  // Merge back into each letter's results.json, scoring with the engine's rules.
  let updatedCompanies = 0;
  let addedJobs = 0;
  for (const L of LETTERS) {
    const f = path.join(ROOT, L, 'results.json');
    if (!fs.existsSync(f)) continue;
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    let touched = false;
    data.forEach((entry, i) => {
      const jobs = found.get(`${L}:${i}`);
      if (!jobs || !jobs.length) return;
      const company = { name: entry.company, country: entry.country, site: '' };
      const boiler = ENGINE.boilerplateStacks(jobs);
      const scored = jobs
        .map((j) => ({ ...j, ...ENGINE.score(j, company, boiler) }))
        .sort((a, b) => b.score - a.score);
      entry.jobs = scored.map((j) => ({
        title: j.title,
        location: j.location,
        url: j.url,
        india: j.india,
        locationSaysIndia: ENGINE.RE_INDIA.test(j.location || ''),
        hasLocation: Boolean(j.location),
        isEng: j.isEng,
        java: j.java,
        flutter: j.flutter,
        senior: j.senior,
        exp: j.exp,
        expFits2: j.expFits2,
        score: j.score,
      }));
      entry.totalJobs = scored.length;
      entry.source = 'rendered';
      entry.error = null;
      touched = true;
      updatedCompanies++;
      addedJobs += scored.length;
    });
    if (touched) fs.writeFileSync(f, JSON.stringify(data, null, 1));
  }

  console.log(`\n  boards recovered : ${updatedCompanies} of ${list.length}`);
  console.log(`  postings added   : ${addedJobs}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
