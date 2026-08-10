#!/usr/bin/env node
/*
 * test.js — check the career page of 100+ "W" companies for open roles.
 *
 * Target role : Software Engineer, ~2 years experience
 * Priority    : Java, and Dart/Flutter
 * Preference  : India
 * Output      : careers.txt   (report)
 *               results.json  (raw diagnostics — proof of what was fetched)
 *
 * Why it works this way
 * ---------------------
 * A "careers page" is almost always a JavaScript shell, so scraping the rendered
 * HTML gets you nothing. The real job data lives in the company's Applicant
 * Tracking System (ATS). So the script:
 *
 *   1. downloads the careers page (+ fallback URLs),
 *   2. sniffs which ATS the page embeds (25+ platforms, incl. the Indian ones:
 *      Zoho Recruit, Darwinbox, Keka, Freshteam, MyNextHire),
 *   3. calls that ATS's public JSON/RSS API to get the real list,
 *   4. falls back to JSON-LD JobPosting -> RSS -> WordPress REST -> raw anchors,
 *   5. re-fetches individual job pages to read the experience requirement,
 *   6. scores every role and writes the report.
 *
 * Guessed ATS tokens are validated against the board's own company name, so we
 * never report another company's jobs (e.g. greenhouse "wise" is not Wise).
 *
 * Usage:
 *   node test.js                     # all companies
 *   node test.js --only=wipro        # one company (substring match)
 *   node test.js --limit=10 --verbose
 */

const fs = require('fs');
const path = require('path');
/*
 * The company list sits beside the COPY of this file that run-letters.sh drops
 * into data/<letter>/, so a scan run finds it. When this file is imported as a
 * module instead — render-scan.js pulls in score()/stripHtml() so rendered jobs
 * are judged by identical rules — there is no companies.js next to it, and a
 * hard require would throw at load. The classifiers do not need it; only run()
 * does, and run() is guarded by require.main === module.
 */
const COMPANIES = (() => {
  try { return require('./companies'); } catch { return []; }
})();

const ARGS = process.argv.slice(2);
const argVal = (k, d) => {
  const a = ARGS.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const VERBOSE = ARGS.includes('--verbose');
const ONLY = argVal('only', null);
const LIMIT = parseInt(argVal('limit', '0'), 10) || 0;
const CONCURRENCY = parseInt(argVal('concurrency', '6'), 10);
const TIMEOUT = parseInt(argVal('timeout', '25000'), 10);
const ENRICH_MAX = parseInt(argVal('enrich', '14'), 10); // job pages to open per company
const COMPANY_MS = parseInt(argVal('companyms', '240000'), 10); // wall-clock cap per company
const ENRICH_MS = parseInt(argVal('enrichms', '120000'), 10);
/* Write the report somewhere other than careers.txt. Once a report is being
 * acted on — applied to, forwarded — regenerating it in place would move the
 * ground under whoever is reading it, so a new sweep goes to its own file:
 *   node test.js --out=careerv1     ->  careerv1.txt + careerv1.results.json */
const OUT = argVal('out', null);

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* ------------------------------------------------------------------ utils */

const log = (...a) => VERBOSE && console.error('      ·', ...a);

function stripHtml(s = '') {
  return String(s)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/\s+/g, ' ')
    .trim();
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** fuzzy "is this board actually this company?" */
function nameMatches(boardName, companyName) {
  const a = norm(boardName);
  const b = norm(companyName);
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const stop = new Set(['inc', 'ltd', 'limited', 'llc', 'the', 'group', 'technologies', 'labs', 'corp', 'gmbh', 'ab', 'plc']);
  const words = (s) => new Set(String(s).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !stop.has(w)));
  const wa = words(boardName);
  const wb = words(companyName);
  for (const w of wb) if (wa.has(w)) return true;
  return false;
}

/* Stricter variant, used only to validate a BLINDLY GUESSED token.
 *
 * nameMatches() accepts "one name contains the other", which is right for a
 * token we found on the company's own page but far too loose for a guess:
 * greenhouse "wellthy" is a US care company, yet it satisfies
 * "Wellthy Therapeutics".includes("Wellthy") and its 16 US jobs get reported
 * under an Indian digital-therapeutics firm.
 *
 * The distinction that matters: a company may legitimately differ from its
 * board name by a parenthetical ("Wolt (DoorDash)" -> "Wolt") or by a generic
 * corporate suffix ("Wiz" -> "Wiz, Inc."), but NOT by a real word like
 * "Therapeutics". So drop parentheticals and generic words from both sides,
 * then demand an exact match. */
const GENERIC_NAME_WORD = new Set([
  'inc', 'ltd', 'limited', 'llc', 'llp', 'plc', 'corp', 'corporation', 'company',
  'gmbh', 'ag', 'ab', 'as', 'bv', 'nv', 'sa', 'srl', 'oy', 'pte', 'pvt', 'private',
  'the', 'group', 'holdings', 'international', 'global', 'worldwide',
  'english', 'careers', 'career', 'jobs', 'board',
  // domain-style tails that appear in a display name but not on the board
  'works', 'io', 'ai', 'com', 'co', 'in', 'app', 'dev', 'tech', 'xyz', 'org', 'net',
]);

/* The direction of containment is what matters.
 *
 * Company name fully present in the board name is safe — real boards routinely
 * carry a parent or sibling brand ("WEBTOON Entertainment Inc. (Wattpad &
 * WEBTOON Family of Brands)" really is Wattpad's board).
 *
 * The reverse is not safe. A board named with only part of the company name may
 * be a different firm that happens to share a first word: greenhouse "wellthy"
 * is a US care-concierge company, not India's Wellthy Therapeutics, and a
 * symmetric check happily accepted it.
 *
 * So: require every significant word of the COMPANY to appear in the BOARD. */
function strictNameMatch(boardName, companyName) {
  const words = (s, dropParens) =>
    String(s)
      .replace(dropParens ? /\([^)]*\)/g : /(?!)/g, ' ')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w && !GENERIC_NAME_WORD.has(w));
  // Parentheticals in OUR company list are editorial ("Wolt (DoorDash)"), so
  // drop them; on the board side they carry real brand names, so keep them.
  const want = words(companyName, true);
  const have = new Set(words(boardName, false));
  return Boolean(want.length && have.size && want.every((w) => have.has(w)));
}

async function req(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeout || TIMEOUT);
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'User-Agent': UA,
        Accept: opts.json ? 'application/json,text/plain,*/*' : 'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(opts.headers || {}),
      },
      method: opts.method || 'GET',
      body: opts.body,
    });
    return { ok: r.ok, status: r.status, text: await r.text(), url: r.url };
  } catch (e) {
    return { ok: false, status: 0, text: '', error: String(e.message || e), url };
  } finally {
    clearTimeout(t);
  }
}

async function getJson(url, opts = {}) {
  const r = await req(url, { ...opts, json: true });
  if (!r.ok) return { ok: false, status: r.status, error: r.error };
  try {
    return { ok: true, status: r.status, data: JSON.parse(r.text) };
  } catch {
    return { ok: false, status: r.status, error: 'bad-json' };
  }
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        try {
          out[idx] = await fn(items[idx], idx);
        } catch (e) {
          out[idx] = { error: String((e && e.message) || e) };
        }
      }
    })
  );
  return out;
}

/* Discovery walks a chain of fallbacks, each with its own request timeout, so a
 * pathological host (huge sitemap + slow responses) can keep one company busy
 * for many minutes and stall the whole run — the report is only written at the
 * end. Cap the wall-clock any single company may consume. */
function withDeadline(promise, ms, onTimeout) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((res) => { t = setTimeout(() => res(onTimeout()), ms); }),
  ]);
}

const job = (o) => ({
  title: stripHtml(o.title || '').slice(0, 200),
  location: stripHtml(o.location || '').slice(0, 160),
  url: o.url || '',
  team: stripHtml(o.team || '').slice(0, 120),
  text: stripHtml(o.text || '').slice(0, 14000),
});

/* --------------------------------------------------------- ATS detectors */

const DETECTORS = [
  { type: 'greenhouse',      re: /(?:boards|job-boards)\.greenhouse\.io\/(?:embed\/job_(?:board|app)(?:\/js)?\?for=)?([a-zA-Z0-9_-]+)/g },
  { type: 'greenhouse',      re: /boards-api\.greenhouse\.io\/v1\/boards\/([a-zA-Z0-9_-]+)/g },
  { type: 'lever',           re: /(?:jobs|api)\.(?:eu\.)?lever\.co\/(?:v0\/postings\/)?([a-zA-Z0-9_-]+)/g },
  { type: 'ashby',           re: /(?:jobs|api)\.ashbyhq\.com\/(?:posting-api\/job-board\/)?([a-zA-Z0-9_.-]+)/g },
  { type: 'smartrecruiters', re: /(?:careers|jobs|api)\.smartrecruiters\.com\/(?:v1\/companies\/)?([a-zA-Z0-9_-]+)/g },
  { type: 'workable',        re: /apply\.workable\.com\/(?:api\/v1\/widget\/accounts\/)?([a-zA-Z0-9_-]+)/g },
  { type: 'recruitee',       re: /([a-zA-Z0-9_-]+)\.recruitee\.com/g },
  { type: 'teamtailor',      re: /([a-zA-Z0-9_-]+)\.teamtailor\.com/g },
  { type: 'personio',        re: /([a-zA-Z0-9_-]+)\.jobs\.personio\.(?:com|de)/g },
  { type: 'bamboohr',        re: /([a-zA-Z0-9_-]+)\.bamboohr\.com/g },
  { type: 'breezy',          re: /([a-zA-Z0-9_-]+)\.breezy\.hr/g },
  { type: 'jazzhr',          re: /([a-zA-Z0-9_-]+)\.applytojob\.com/g },
  { type: 'rippling',        re: /ats\.rippling\.com\/([a-zA-Z0-9_-]+)/g },
  { type: 'pinpoint',        re: /([a-zA-Z0-9_-]+)\.pinpointhq\.com/g },
  { type: 'comeet',          re: /([a-zA-Z0-9_-]+)\.comeet\.co/g },
  { type: 'freshteam',       re: /([a-zA-Z0-9_-]+)\.freshteam\.com/g },
  { type: 'keka',            re: /([a-zA-Z0-9_-]+)\.keka\.com/g },
  { type: 'jobvite',         re: /jobs\.jobvite\.com\/(?:careers\/)?([a-zA-Z0-9_-]+)/g },
  { type: 'icims',           re: /(?:careers-)?([a-zA-Z0-9_-]+)\.icims\.com/g },
  { type: 'smartapply',      re: /([a-zA-Z0-9_-]+)\.hire\.trakstar\.com/g },
  { type: 'recruiterbox',    re: /([a-zA-Z0-9_-]+)\.recruiterbox\.com/g },
  {
    type: 'workday',
    re: /([a-zA-Z0-9_-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-zA-Z-]{2,5}\/)?([a-zA-Z0-9_-]+)/g,
    build: (m) => ({ token: m[1], wd: m[2], site: m[3] }),
  },
  {
    // Darwinbox: links look like  https://<tenant>.darwinbox.in/ms/candidate(v2)/...
    type: 'darwinbox',
    re: /https?:\/\/([a-zA-Z0-9_-]+)\.darwinbox\.(?:in|com)/g,
  },
  {
    // MyNextHire (India)
    type: 'mynexthire',
    re: /https?:\/\/([a-zA-Z0-9_-]+)\.mynexthire\.(?:com|io)/g,
  },
  {
    // Zoho Recruit — often on the company's own domain (careers.yellow.ai)
    type: 'zohorecruit',
    re: /https?:\/\/([a-zA-Z0-9_-]+)\.zohorecruit\.(com|in|eu|com\.au)/g,
    build: (m) => ({ token: m[1], host: `https://${m[1]}.zohorecruit.${m[2]}` }),
  },
  {
    type: 'paylocity',
    re: /recruiting\.paylocity\.com\/recruiting\/jobs\/All\/([a-f0-9-]{36})/g,
    build: (m) => ({ token: m[1] }),
  },
];

// slugs that appear inside ATS URLs but are not company accounts
const BAD_TOKENS = new Set([
  'embed', 'js', 'v1', 'v0', 'api', 'boards', 'jobs', 'job', 'careers', 'career',
  'www', 'static', 'assets', 'cdn', 'app', 'apply', 'search', 'company', 'companies',
  'posting-api', 'job-board', 'postings', 'widget', 'accounts', 'images', 'img',
  'en', 'us', 'null', 'undefined', 'true', 'false', 'main', 'index', 'js?for',
]);

function detect(html, pageUrl) {
  const found = [];
  for (const d of DETECTORS) {
    d.re.lastIndex = 0;
    let m;
    while ((m = d.re.exec(html))) {
      const info = d.build ? d.build(m) : { token: m[1] };
      if (!info.token || info.token.length < 2) continue;
      if (BAD_TOKENS.has(String(info.token).toLowerCase())) continue;
      const key = `${d.type}:${info.token}:${info.site || ''}`;
      if (!found.some((f) => f.key === key)) found.push({ key, type: d.type, page: pageUrl, ...info });
    }
  }
  // Zoho Recruit hosted on the company's own domain: /jobs/Careers links + zoho CDN
  if (/static\.zohocdn\.com\/recruit/i.test(html) || /\/jobs\/[Cc]areers\b/.test(html)) {
    const origin = new URL(pageUrl).origin;
    if (!found.some((f) => f.type === 'zohorecruit'))
      found.push({ key: `zohorecruit:${origin}`, type: 'zohorecruit', token: origin, host: origin, page: pageUrl });
  }
  // SAP SuccessFactors RMK: the careers host is the company's own domain, and
  // the giveaway is the sapsf/rmkcdn/jobs2web assets it pulls in.
  if (/career\d*\.sapsf\.|hcm\d*\.sapsf\.|rmkcdn\.successfactors\.com|jobs2web\.com/i.test(html)) {
    const origin = new URL(pageUrl).origin;
    if (!found.some((f) => f.type === 'successfactors'))
      found.push({ key: `successfactors:${origin}`, type: 'successfactors', token: origin, host: origin, page: pageUrl });
  }
  // Phenom People careers site (Yelp, many enterprises)
  if (/phenompeople|ph-cdn\.com|CareerConnectResources/i.test(html)) {
    if (!found.some((f) => f.type === 'phenom'))
      found.push({ key: 'phenom', type: 'phenom', token: '_self', host: new URL(pageUrl).origin, page: pageUrl });
  }
  return found;
}

/* --------------------------------------------------------- ATS fetchers  */
/* Every fetcher returns an array of jobs, or null when the board is not
 * this company's / does not exist. An empty array means "real board, 0 open". */

const ATS = {
  async greenhouse({ token }) {
    const r = await getJson(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`);
    if (!r.ok || !r.data || !Array.isArray(r.data.jobs)) return null;
    return r.data.jobs.map((j) =>
      job({
        title: j.title,
        location: j.location && j.location.name,
        url: j.absolute_url,
        team: (j.departments || []).map((d) => d.name).join(', '),
        text: j.content,
      })
    );
  },
  async greenhouseName({ token }) {
    const r = await getJson(`https://boards-api.greenhouse.io/v1/boards/${token}`);
    return r.ok && r.data ? r.data.name : null;
  },

  async lever({ token }) {
    for (const host of ['api.lever.co', 'api.eu.lever.co']) {
      const r = await getJson(`https://${host}/v0/postings/${token}?mode=json`);
      if (r.ok && Array.isArray(r.data)) return r.data.map(leverMap);
    }
    return null;
  },
  async leverName({ token }) {
    const r = await req(`https://jobs.lever.co/${token}`);
    const m = r.text.match(/<title>([^<]+)<\/title>/i);
    return m ? m[1].replace(/\s*[-|]\s*(jobs|careers).*/i, '').trim() : null;
  },

  async ashby({ token }) {
    const r = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${token}?includeCompensation=true`);
    if (!r.ok || !r.data || !Array.isArray(r.data.jobs)) return null;
    return r.data.jobs.map((j) => {
      const pa = (j.address && j.address.postalAddress) || {};
      return job({
        title: j.title,
        location: j.location || [pa.addressLocality, pa.addressRegion, pa.addressCountry].filter(Boolean).join(', '),
        url: j.jobUrl,
        team: j.department || j.team,
        text: j.descriptionPlain || j.descriptionHtml,
      });
    });
  },
  async ashbyName({ token }) {
    const r = await req(`https://jobs.ashbyhq.com/${token}`);
    const m = r.text.match(/<title>([^<]+)<\/title>/i);
    return m ? m[1].replace(/\s*[-|·]\s*(jobs|careers).*/i, '').trim() : null;
  },

  // NOTE: SmartRecruiters returns 200 + empty list for ANY string, so an empty
  // result is never proof the board exists. Only accept non-empty boards.
  async smartrecruiters({ token }) {
    const out = [];
    for (let offset = 0; offset < 500; offset += 100) {
      const r = await getJson(`https://api.smartrecruiters.com/v1/companies/${token}/postings?limit=100&offset=${offset}`);
      if (!r.ok || !r.data || !Array.isArray(r.data.content)) return offset ? out : null;
      for (const p of r.data.content) {
        const loc = p.location || {};
        const j = job({
          title: p.name,
          location: [loc.city, loc.region, loc.country].filter(Boolean).join(', '),
          url: `https://jobs.smartrecruiters.com/${token}/${p.id}`,
          team: (p.department && p.department.label) || '',
          text: p.name,
        });
        j._detail = `https://api.smartrecruiters.com/v1/companies/${token}/postings/${p.id}`;
        out.push(j);
      }
      if (r.data.content.length < 100) break;
    }
    return out.length ? out : null;
  },

  async workable({ token }) {
    for (const u of [
      `https://apply.workable.com/api/v1/widget/accounts/${token}?details=true`,
      `https://www.workable.com/api/accounts/${token}?details=true`,
    ]) {
      const r = await getJson(u);
      const jobs = r.ok && r.data && (r.data.jobs || r.data.results);
      if (Array.isArray(jobs))
        return jobs.map((j) =>
          job({
            title: j.title,
            location: [j.city, j.state, j.country].filter(Boolean).join(', '),
            url: j.url || j.shortlink || j.application_url,
            team: j.department || '',
            text: [j.description, j.requirements].filter(Boolean).join(' '),
          })
        );
    }
    return null;
  },
  async workableName({ token }) {
    const r = await getJson(`https://apply.workable.com/api/v1/widget/accounts/${token}?details=true`);
    return r.ok && r.data ? r.data.name : null;
  },

  async recruitee({ token }) {
    const r = await getJson(`https://${token}.recruitee.com/api/offers/`);
    if (!r.ok || !r.data || !Array.isArray(r.data.offers)) return null;
    return r.data.offers.map((o) =>
      job({
        title: o.title,
        location: [o.city, o.country].filter(Boolean).join(', ') || o.location,
        url: o.careers_url || o.careers_apply_url,
        team: o.department,
        text: [o.description, o.requirements].filter(Boolean).join(' '),
      })
    );
  },

  async workday({ token, wd, site }) {
    const base = `https://${token}.${wd}.myworkdayjobs.com`;
    const out = [];
    for (let offset = 0; offset < 400; offset += 20) {
      const r = await getJson(`${base}/wday/cxs/${token}/${site}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText: '' }),
      });
      if (!r.ok || !r.data || !Array.isArray(r.data.jobPostings)) return offset ? out : null;
      for (const p of r.data.jobPostings) {
        const j = job({
          title: p.title,
          location: p.locationsText || '',
          url: `${base}/${site}${p.externalPath || ''}`,
          text: p.title,
        });
        j._detail = `${base}/wday/cxs/${token}/${site}${p.externalPath}`;
        j._detailKind = 'workday';
        out.push(j);
      }
      if (r.data.jobPostings.length < 20 || out.length >= (r.data.total || 0)) break;
    }
    return out;
  },

  async personio({ token }) {
    const r = await req(`https://${token}.jobs.personio.com/xml`);
    if (!r.ok || !/<position/i.test(r.text)) {
      for (const u of [`https://${token}.jobs.personio.com/`, `https://${token}.jobs.personio.de/`]) {
        const p = await req(u);
        if (!p.ok) continue;
        const ld = jsonLdJobs(p.text, p.url);
        if (ld.length) return ld;
        const hj = htmlJobs(p.text, p.url);
        if (hj.length) return hj;
      }
      return null;
    }
    return [...r.text.matchAll(/<position>([\s\S]*?)<\/position>/gi)].map((m) => {
      const g = (t) => (m[1].match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`, 'i')) || [, ''])[1];
      return job({
        title: stripHtml(g('name')),
        location: stripHtml(g('office')),
        url: `https://${token}.jobs.personio.com/job/${stripHtml(g('id'))}`,
        team: stripHtml(g('department')),
        text: m[1],
      });
    });
  },

  async bamboohr({ token }) {
    const r = await getJson(`https://${token}.bamboohr.com/careers/list`);
    if (!r.ok || !r.data || !Array.isArray(r.data.result)) {
      // Newer BambooHR boards live at /jobs/ and render server-side instead of
      // serving the old JSON list.
      const p = await req(`https://${token}.bamboohr.com/jobs/`);
      if (!p.ok) return null;
      const ld = jsonLdJobs(p.text, p.url);
      if (ld.length) return ld;
      const emb = [...p.text.matchAll(/"jobOpeningName"\s*:\s*"([^"]+)"[\s\S]{0,400}?"id"\s*:\s*"?(\d+)/g)].map((m) =>
        job({ title: m[1], url: `https://${token}.bamboohr.com/careers/${m[2]}`, text: m[1] })
      );
      if (emb.length) return emb;
      const hj = htmlJobs(p.text, p.url);
      return hj.length ? hj : null;
    }
    return r.data.result.map((j) => {
      const loc = j.location || {};
      const o = job({
        title: j.jobOpeningName,
        location: [loc.city, loc.state, loc.country].filter(Boolean).join(', '),
        url: `https://${token}.bamboohr.com/careers/${j.id}`,
        team: j.departmentLabel || '',
        text: j.jobOpeningName,
      });
      o._detail = `https://${token}.bamboohr.com/careers/${j.id}/detail`;
      o._detailKind = 'bamboohr';
      return o;
    });
  },

  async breezy({ token }) {
    const r = await getJson(`https://${token}.breezy.hr/json`);
    if (!r.ok || !Array.isArray(r.data)) return null;
    return r.data.map((j) =>
      job({
        title: j.name,
        location: (j.location && (j.location.name || j.location.city)) || '',
        url: j.url,
        team: (j.department && j.department.name) || '',
        text: j.description,
      })
    );
  },

  async rippling({ token }) {
    const r = await getJson(`https://api.rippling.com/platform/api/ats/v1/board/${token}/jobs`);
    const arr = r.ok && (Array.isArray(r.data) ? r.data : r.data && r.data.items);
    if (!Array.isArray(arr)) return null;
    return arr.map((j) =>
      job({
        title: j.name || j.title,
        location: (j.workLocation && (j.workLocation.label || j.workLocation.city)) || j.location || '',
        url: j.url || `https://ats.rippling.com/${token}/jobs/${j.uuid || j.id}`,
        team: j.department || '',
        text: j.description || j.name,
      })
    );
  },

  async pinpoint({ token }) {
    const r = await getJson(`https://${token}.pinpointhq.com/postings.json`);
    const arr = r.ok && r.data && (r.data.data || r.data);
    if (!Array.isArray(arr)) return null;
    return arr.map((x) => {
      const a = x.attributes || x;
      return job({
        title: a.title,
        location: (a.location && a.location.name) || a.location || '',
        url: a.url || '',
        text: a.description || a.title,
      });
    });
  },

  async comeet({ token }) {
    const r = await getJson(`https://www.comeet.co/careers-api/2.0/company/${token}/positions`);
    if (!r.ok || !Array.isArray(r.data)) return null;
    return r.data.map((j) =>
      job({
        title: j.name,
        location: (j.location && [j.location.city, j.location.country].filter(Boolean).join(', ')) || '',
        url: j.url_comeet_hosted_page || j.url_active_page,
        team: j.department,
        text: (j.details || []).map((d) => d.value).join(' '),
      })
    );
  },

  async jazzhr({ token }) {
    const r = await req(`https://${token}.applytojob.com/apply/`);
    if (!r.ok) return null;
    const jobs = htmlJobs(r.text, `https://${token}.applytojob.com`);
    return jobs.length ? jobs : null;
  },

  async smartapply({ token }) {
    // Trakstar Hire is the rebranded RecruiterBox — the RSS feed carries the
    // full description, so try it before scraping the JS-rendered board.
    const feed = await ATS.recruiterbox({ token });
    if (feed && feed.length) return feed;
    const r = await req(`https://${token}.hire.trakstar.com/`);
    if (!r.ok) return null;
    const jobs = jsonLdJobs(r.text, r.url).concat(htmlJobs(r.text, r.url));
    return jobs.length ? jobs : null;
  },

  /* SAP SuccessFactors "Recruiting Marketing" (jobs2web) — Wipro and a lot of
   * large enterprises. The board is a JS shell, but every such site exposes
   * /services/rss/job/, which returns real postings. One feed is capped at ~20
   * items, so query it once plainly and once per priority keyword and merge —
   * that surfaces the Java/Flutter roles we actually care about instead of
   * whichever 20 happen to be newest.
   * Titles arrive as "TITLE (City, REGION, CC, PIN)", so split the location off. */
  async successfactors({ host }) {
    const base = String(host).replace(/\/$/, '');
    const terms = ['', 'java', 'flutter', 'dart', 'software engineer', 'developer', 'android', 'full stack'];
    const seen = new Map();
    await pool(terms, 4, async (t) => {
      const u = `${base}/services/rss/job/?locale=en_US${t ? `&keywords=(${encodeURIComponent(t)})` : ''}`;
      const r = await req(u, { timeout: 20000 });
      if (!r.ok || !/<item[\s>]/i.test(r.text)) return;
      for (const m of r.text.matchAll(/<item[\s>]([\s\S]*?)<\/item>/gi)) {
        const g = (tag) => (m[1].match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`, 'i')) || [, ''])[1];
        const raw = stripHtml(g('title'));
        const link = stripHtml(g('link'));
        if (!raw || seen.has(link)) continue;
        const loc = raw.match(/\(([^()]{2,90})\)\s*$/);
        seen.set(link, job({
          title: loc ? raw.slice(0, loc.index).trim() : raw,
          location: loc ? loc[1] : '',
          url: link,
          text: stripHtml(g('description')),
        }));
      }
    });
    return seen.size ? [...seen.values()] : null;
  },

  /* RecruiterBox / Trakstar Hire (Whatfix, and a lot of Indian SaaS).
   * The board itself renders client-side, but /jobfeeds/<token> is a plain RSS
   * document containing every opening with its full HTML description, and the
   * location sits in an "id=job_meta" block at the top of that description. */
  async recruiterbox({ token }) {
    let r = await req(`https://${token}.recruiterbox.com/jobfeeds/${token}`);
    if (!r.ok || !/<item[\s>]/i.test(r.text)) r = await req(`https://${token}.hire.trakstar.com/jobfeeds/${token}`);
    if (!r.ok || !/<item[\s>]/i.test(r.text)) return null;
    const jobs = [...r.text.matchAll(/<item[\s>]([\s\S]*?)<\/item>/gi)]
      .map((m) => {
        const g = (t) => (m[1].match(new RegExp(`<${t}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${t}>`, 'i')) || [, ''])[1];
        const desc = g('description');
        const meta = desc.match(/job_meta[\s\S]{0,400}?Location:\s*([^<&]{2,120})/i);
        const o = job({
          title: stripHtml(g('title')),
          location: meta ? meta[1].replace(/\s+/g, ' ').trim() : '',
          url: stripHtml(g('link')).replace(/^http:/, 'https:'),
          text: stripHtml(desc),
        });
        o._noEnrich = true; // the feed already carries the whole description
        return o;
      })
      .filter((j) => j.title);
    return jobs.length ? jobs : null;
  },

  async freshteam({ token }) {
    const r = await req(`https://${token}.freshteam.com/jobs`);
    if (!r.ok) return null;
    const jobs = jsonLdJobs(r.text, r.url).concat(htmlJobs(r.text, r.url));
    return jobs.length ? jobs : null;
  },

  /* Keka. The endpoint this used to call — /careers/api/embedjobs — now 404s,
   * which is why Keka boards were reporting zero openings. Keka's own bundle
   * calls /careers/api/jobs/<portal>/active; some tenants also expose the older
   * embedjobs path with a portal GUID, so try the current one first and fall
   * back rather than assuming one shape. */
  async keka({ token, portal, embedId }) {
    const base = `https://${token}.keka.com/careers`;
    const p = portal || 'default';
    const urls = [`${base}/api/jobs/${p}/active`];
    if (embedId) urls.push(`${base}/api/embedjobs/${p}/active/${embedId}`);
    urls.push(`${base}/api/embedjobs`);
    for (const u of urls) {
      const api = await getJson(u);
      const arr = api.ok && (Array.isArray(api.data) ? api.data : api.data && api.data.data);
      if (!Array.isArray(arr) || !arr.length) continue;
      return arr.map((j) =>
        job({
          title: j.title || j.jobTitle,
          location: Array.isArray(j.jobLocations)
            ? j.jobLocations.map((l) => [l.city, l.state, l.country].filter(Boolean).join(', ') || l.name).join(' | ')
            : j.location || '',
          url: `${base}/jobdetails/${j.id}`,
          team: j.departmentName || '',
          text: stripHtml(j.description || j.excerpt || j.title),
        })
      );
    }
    const r = await req(`${base}/`);
    if (!r.ok) return null;
    const jobs = jsonLdJobs(r.text, r.url).concat(htmlJobs(r.text, r.url));
    return jobs.length ? jobs : null;
  },

  /* Oracle Recruiting Cloud. Big enterprises sit behind this (WSP, Waste
   * Management, Williams-Sonoma, Wesco — 7k+ roles between them). The public
   * REST finder needs the pod host and the site number, both of which are in
   * the careers page URL. */
  async oracleorc({ host, token, site }) {
    const base = String(host).replace(/\/$/, '');
    const siteNumber = site || token;
    const out = [];
    for (let offset = 0; offset < 600; offset += 200) {
      const u =
        `${base}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true` +
        `&expand=requisitionList.secondaryLocations` +
        `&finder=findReqs;siteNumber=${encodeURIComponent(siteNumber)},limit=200,offset=${offset},sortBy=POSTING_DATES_DESC`;
      const r = await getJson(u, { timeout: 30000 });
      const item = r.ok && r.data && Array.isArray(r.data.items) && r.data.items[0];
      const list = item && item.requisitionList;
      if (!Array.isArray(list) || !list.length) break;
      for (const j of list) {
        const secondary = (j.secondaryLocations || []).map((l) => l.Name).filter(Boolean);
        out.push(
          job({
            title: j.Title,
            location: [j.PrimaryLocation, ...secondary].filter(Boolean).join(' | '),
            url: `${base}/hcmUI/CandidateExperience/en/sites/${siteNumber}/job/${j.Id}`,
            team: j.JobFamily || j.JobFunction || '',
            text: j.Title,
          })
        );
      }
      if (list.length < 200) break;
    }
    return out.length ? out : null;
  },

  /* Eightfold AI (Whirlpool, and a growing share of large employers). The
   * documented /api/apply/v2/jobs returns 403 "Not authorized for PCSX"; the
   * board's own search endpoint works. Pages 10 at a time. */
  async eightfold({ host, token, domain }) {
    const base = String(host || `https://${token}.eightfold.ai`).replace(/\/$/, '');
    const dom = domain || token;
    const out = [];
    for (let start = 0; start < 300; start += 10) {
      const u = `${base}/api/pcsx/search?domain=${encodeURIComponent(dom)}&start=${start}&num=10`;
      const r = await getJson(u, { timeout: 25000 });
      const d = r.ok && r.data && r.data.data;
      const ps = d && d.positions;
      if (!Array.isArray(ps) || !ps.length) break;
      for (const p of ps) {
        out.push(
          job({
            title: p.name || p.title,
            location: [].concat(p.locations || p.location || []).join(' | '),
            url: p.canonicalPositionUrl || `${base}/careers/job/${p.id}?domain=${dom}`,
            team: p.department || '',
            text: stripHtml(p.job_description || p.description || p.name),
          })
        );
      }
      if (out.length >= (d.count || 0)) break;
    }
    return out.length ? out : null;
  },

  /* Avature: the search UI is JS, but every board exposes an RSS feed. */
  async avature({ token, host, locale }) {
    const base = String(host || `https://${token}.avature.net`).replace(/\/$/, '');
    const loc = locale || 'en_US';
    const r = await req(`${base}/${loc}/careers/SearchJobs/feed/`, { timeout: 25000 });
    if (!r.ok || !/<item[\s>]/i.test(r.text)) return null;
    const out = [];
    for (const m of r.text.matchAll(/<item[\s>]([\s\S]*?)<\/item>/gi)) {
      const g = (t) => (m[1].match(new RegExp(`<${t}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${t}>`, 'i')) || [, ''])[1];
      const title = stripHtml(g('title'));
      if (title) out.push(job({ title, url: stripHtml(g('link')), text: stripHtml(g('description')) }));
    }
    return out.length ? out : null;
  },

  /* Instahyre — an Indian aggregator, but it is the only machine-readable
   * source for several Indian companies whose own boards are Cloudflare-walled
   * (Wakefit, WheelsEye). Scoped to one company, so it is that company's list. */
  async instahyre({ token }) {
    const r = await getJson(
      `https://www.instahyre.com/api/v1/job_search?limit=100&offset=0&companies=${encodeURIComponent(token)}`,
      { timeout: 25000 }
    );
    const list = r.ok && r.data && (r.data.objects || r.data.results);
    if (!Array.isArray(list) || !list.length) return null;
    return list.map((j) =>
      job({
        title: j.title,
        location: [].concat(j.locations || j.location || []).join(', '),
        url: j.public_url ? `https://www.instahyre.com${j.public_url}` : 'https://www.instahyre.com/',
        text: stripHtml(j.description || j.keywords || j.title),
      })
    );
  },

  /* CVViz — small Indian ATS (Wobot AI). */
  async cvviz({ token, slug }) {
    const r = await getJson(`https://jobs.cvviz.com/api/career/employers/${token}/jobs`, { timeout: 25000 });
    const list = r.ok && r.data && (r.data.data || r.data.jobs);
    if (!Array.isArray(list) || !list.length) return null;
    return list.map((j) =>
      job({
        title: j.title,
        location: [j.city, j.state, j.country].filter(Boolean).join(', '),
        url: slug ? `https://jobs.cvviz.com/${slug}/job_${j.id}` : 'https://jobs.cvviz.com/',
        text: stripHtml(j.jobdescription || j.title),
      })
    );
  },

  /* ADP Recruiting. Two front ends: the newer myjobs.adp.com (needs the org id
   * as a header) and the older workforcenow client-id form. */
  async adp({ token, orgoid, cid }) {
    if (orgoid) {
      const r = await getJson('https://myjobs.adp.com/public/staffing/v1/job-requisitions?$top=100', {
        timeout: 25000,
        headers: { orgoid },
      });
      const list = r.ok && r.data && (r.data.jobRequisitions || r.data.items);
      if (Array.isArray(list) && list.length)
        return list.map((j) =>
          job({
            title: (j.requisitionTitle || j.jobTitle || '').toString(),
            location: ((j.requisitionLocations || [])[0] || {}).nameCode
              ? j.requisitionLocations.map((l) => l.nameCode.shortName).filter(Boolean).join(' | ')
              : '',
            url: j.itemID ? `https://myjobs.adp.com/${token || ''}/cx/job-preview?reqId=${j.itemID}` : '',
            text: stripHtml(j.description || j.requisitionTitle || ''),
          })
        );
    }
    const id = cid || token;
    const r = await getJson(
      `https://workforcenow.adp.com/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions?cid=${encodeURIComponent(id)}&%24top=20&%24skip=0`,
      { timeout: 25000 }
    );
    const list = r.ok && r.data && (r.data.jobRequisitions || r.data.items);
    if (!Array.isArray(list) || !list.length) return null;
    return list.map((j) =>
      job({
        title: (j.requisitionTitle || j.jobTitle || '').toString(),
        location: (j.requisitionLocations || []).map((l) => (l.nameCode && l.nameCode.shortName) || '').filter(Boolean).join(' | '),
        url: `https://workforcenow.adp.com/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions?cid=${id}`,
        text: stripHtml(j.description || j.requisitionTitle || ''),
      })
    );
  },

  async jobvite({ token }) {
    const r = await req(`https://jobs.jobvite.com/${token}/search`);
    if (!r.ok) return null;
    const jobs = htmlJobs(r.text, 'https://jobs.jobvite.com');
    return jobs.length ? jobs : null;
  },

  /* iCIMS. Two things make the difference between 0 jobs and a real list:
   *   - the token is the WHOLE subdomain (uscareers-waters, careers-acme, ...),
   *     so it must not be re-prefixed; when we only have a bare company slug,
   *     try the usual prefixes.
   *   - without in_iframe=1 the board ships an empty JS shell; with it, iCIMS
   *     server-renders the results.
   * Results are 20 per page, paged by ?pr=N — page far enough that a large
   * board is not silently truncated (a 6-page cap hid 20 of Waters' 140). */
  async icims({ token }) {
    const hosts = /-/.test(token) ? [token] : [`careers-${token}`, token, `uscareers-${token}`];
    for (const host of hosts) {
      const base = `https://${host}.icims.com`;
      const seen = new Map();
      for (let pr = 0; pr < 12; pr++) {
        const r = await req(`${base}/jobs/search?ss=1&in_iframe=1&pr=${pr}`, { timeout: 20000 });
        if (!r.ok) break;
        const before = seen.size;
        // Each row is: anchor (title) followed by a "description" div holding the
        // whole posting. The list page carries no location — that only exists in
        // the JSON-LD on the job page — so leave it for enrich() to fill.
        for (const m of r.text.matchAll(
          /<a[^>]+href="([^"]*\/jobs\/\d+\/[^"]*)"[^>]*class="iCIMS_Anchor"[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>[\s\S]*?<\/a>([\s\S]{0,6000}?)(?=<a[^>]+class="iCIMS_Anchor"|$)/gi
        )) {
          const url = m[1].split('?')[0];
          if (seen.has(url)) continue;
          const title = stripHtml(m[2]);
          if (!title) continue;
          const desc = (m[3].match(/class="[^"]*description[^"]*"[^>]*>([\s\S]*)/i) || [, ''])[1];
          const o = job({ title, url, text: stripHtml(desc) || title });
          o._detail = `${url}?in_iframe=1`; // the JSON-LD (and the location) live here
          o._detailKind = 'html';
          seen.set(url, o);
        }
        if (seen.size === before) break; // page added nothing new — end of list
      }
      if (seen.size) return [...seen.values()];
    }
    return null;
  },

  /* ---- Teamtailor: the public careers site emits JSON-LD per posting ---- */
  async teamtailor({ token, host }) {
    for (const base of [host, `https://${token}.teamtailor.com`].filter(Boolean)) {
      const r = await req(`${base}/jobs`);
      if (!r.ok) continue;
      const ld = jsonLdJobs(r.text, r.url);
      if (ld.length) return ld;
      const anchors = [...r.text.matchAll(/<a[^>]+href=["']([^"']*\/jobs\/\d+[^"']*)["'][^>]*>([\s\S]{0,400}?)<\/a>/gi)];
      const out = [];
      const seen = new Set();
      for (const m of anchors) {
        const title = stripHtml(m[2]).split('  ')[0].trim();
        if (!title || title.length < 4 || seen.has(title)) continue;
        seen.add(title);
        out.push(job({ title, url: new URL(m[1], r.url).href, text: stripHtml(m[2]) }));
      }
      if (out.length) return out;
    }
    return null;
  },

  /* ---- Zoho Recruit (very common in India; often on a custom domain) ---- */
  async zohorecruit({ token, host, _links }) {
    // Many sites render the Zoho job links into their own careers page even
    // though the Zoho board itself is JS-only — use those first.
    if (_links && _links.length) {
      const out = [];
      const seen = new Set();
      for (const u of _links) {
        const m = u.match(/\/jobs\/[Cc]areers\/(\d+)\/([A-Za-z0-9%\-_]+)/);
        if (!m || seen.has(m[1])) continue;
        seen.add(m[1]);
        let slug = m[2];
        try { slug = decodeURIComponent(slug); } catch {}
        const j = job({ title: slug.replace(/-+/g, ' ').trim(), url: u.split('?')[0], text: slug.replace(/-+/g, ' ') });
        j._detail = j.url;
        j._detailKind = 'html';
        out.push(j);
      }
      if (out.length) return out;
    }
    const bases = [...new Set([host, token && token.startsWith('http') ? token : null,
      token && !token.startsWith('http') ? `https://${token}.zohorecruit.in` : null,
      token && !token.startsWith('http') ? `https://${token}.zohorecruit.com` : null].filter(Boolean))];
    for (const base of bases) {
      // RSS first — cleanest
      const rss = await req(`${base}/jobs/Careers/rss`);
      if (rss.ok && /<item>/i.test(rss.text)) {
        const items = [...rss.text.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((m) => {
          const g = (t) => (m[1].match(new RegExp(`<${t}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${t}>`, 'i')) || [, ''])[1];
          return job({ title: stripHtml(g('title')), url: stripHtml(g('link')), text: stripHtml(g('description')) });
        });
        if (items.length) return items;
      }
      // otherwise pull /jobs/Careers/<id>/<Title-Slug> links out of the HTML
      const r = await req(`${base}/jobs/Careers`);
      if (r.ok) {
        const jobs = zohoLinkJobs(r.text, base);
        if (jobs.length) return jobs;
        // A live Zoho board that simply has nothing open: report it as empty,
        // not as "board not found".
        if (/static\.zohocdn\.com\/recruit|zoho/i.test(r.text)) return [];
      }
      if (rss.ok && /<channel>/i.test(rss.text)) return [];
    }
    return null;
  },

  /* ---- Darwinbox (India). Job pages expose title+location in og:title ---- */
  async darwinbox({ token, _links }) {
    const links = [...new Set(_links || [])];
    if (!links.length) return null;
    const out = [];
    for (const url of links.slice(0, 60)) {
      const r = await req(url, { timeout: 15000 });
      if (!r.ok) continue;
      const m = r.text.match(/property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
      if (!m) continue;
      // "YES Securities Limited   |  AIF Operations Executive (Mumbai, Maharashtra, India)"
      const raw = stripHtml(m[1]);
      const parts = raw.split('|');
      const tail = (parts.length > 1 ? parts.slice(1).join('|') : raw).trim();
      const lm = tail.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
      const desc = r.text.match(/property=["']og:description["'][^>]*content=["']([^"']*)["']/i);
      out.push(
        job({
          title: lm ? lm[1] : tail,
          location: lm ? lm[2] : '',
          url,
          text: [tail, desc ? desc[1] : '', stripHtml(r.text)].join(' '),
        })
      );
    }
    return out.length ? out : null;
  },

  /* ---- MyNextHire (India) ---- */
  async mynexthire({ token }) {
    for (const u of [
      `https://${token}.jobs.mynexthire.io/api/careers/jobs`,
      `https://${token}.jobs.mynexthire.io/api/jobs`,
      `https://${token}.mynexthire.com/employer/rest/jobboard/careers/${token}`,
    ]) {
      const r = await getJson(u);
      const arr = r.ok && (Array.isArray(r.data) ? r.data : r.data && (r.data.jobs || r.data.data));
      if (Array.isArray(arr) && arr.length)
        return arr.map((j) =>
          job({
            title: j.jobTitle || j.title || j.positionTitle,
            location: j.location || j.jobLocation || '',
            url: j.url || `https://${token}.jobs.mynexthire.io/careers`,
            text: j.jobDescription || j.description || j.jobTitle || j.title,
          })
        );
    }
    for (const u of [`https://${token}.jobs.mynexthire.io/careers`, `https://${token}.mynexthire.com/employer/jobs/careers`]) {
      const r = await req(u);
      if (!r.ok) continue;
      const jobs = jsonLdJobs(r.text, r.url).concat(nextDataJobs(r.text, r.url)).concat(htmlJobs(r.text, r.url));
      if (jobs.length) return jobs;
    }
    return null;
  },

  /* ---- Phenom People careers sites ---- */
  async phenom({ host }) {
    if (!host) return null;
    // Modern Phenom sites ship the result set inside the page as an escaped
    // JSON blob rather than exposing the old /api/apply endpoint.
    const embedded = [];
    for (let from = 0; from < 200; from += 10) {
      const r = await req(`${host}/us/en/search-results?from=${from}&s=1`);
      if (!r.ok) break;
      const batch = phenomEmbeddedJobs(r.text, host);
      if (!batch.length) break;
      const before = embedded.length;
      for (const j of batch) if (!embedded.some((e) => e.url === j.url)) embedded.push(j);
      if (embedded.length === before) break;
    }
    if (embedded.length) return embedded;
    const domain = new URL(host).hostname.replace(/^www\./, '');
    const tries = [
      `${host}/api/apply/v2/jobs?domain=${domain}&start=0&num=200&exportType=json`,
      `${host}/widgets/?feature=joblist&domain=${domain}&start=0&num=200&exportType=json`,
      `${host}/api/apply/v2/jobs?domain=${domain}&start=0&num=200&exportType=json&sortBy=relevance`,
    ];
    for (const u of tries) {
      const r = await getJson(u);
      const arr =
        r.ok && r.data &&
        (r.data.jobs ||
          (r.data.refineSearch && r.data.refineSearch.data && r.data.refineSearch.data.jobs) ||
          (r.data.data && r.data.data.jobs));
      if (Array.isArray(arr) && arr.length)
        return arr.map((j) =>
          job({
            title: j.title,
            location: j.location || [j.city, j.state, j.country].filter(Boolean).join(', '),
            url: j.applyUrl || j.jobUrl || j.canonicalUrl || '',
            team: j.category || j.department || '',
            text: j.descriptionTeaser || j.description || j.title,
          })
        );
    }
    // fall back to the sitemap of job pages that Phenom always publishes
    const sm = await sitemapJobs(host);
    return sm && sm.length ? sm : null;
  },

  async paylocity({ token }) {
    const r = await req(`https://recruiting.paylocity.com/recruiting/jobs/All/${token}`);
    if (!r.ok) return null;
    const jobs = jsonLdJobs(r.text, r.url).concat(
      [...r.text.matchAll(/<a[^>]+href=["']([^"']*\/recruiting\/jobs\/Details\/[^"']+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi)]
        .map((m) => job({ title: stripHtml(m[2]), url: new URL(m[1], r.url).href, text: stripHtml(m[2]) }))
        .filter((j) => j.title.length > 3)
    );
    return jobs.length ? jobs : null;
  },
};

function leverMap(j) {
  return job({
    title: j.text,
    location: (j.categories && j.categories.location) || '',
    url: j.hostedUrl || j.applyUrl,
    team: (j.categories && j.categories.team) || '',
    // Lever splits a posting across several fields and the requirements — the
    // "3+ years", the tech stack — live in `lists`, not in the description.
    // Reading descriptionPlain alone silently loses them.
    text: [
      j.descriptionPlain || j.description,
      ...(j.lists || []).map((l) => `${l.text}: ${l.content}`),
      j.additionalPlain || j.additional,
    ].filter(Boolean).join(' \n'),
  });
}

/* Phenom People embeds its result set as an escaped JSON blob in the page. */
function phenomEmbeddedJobs(html, host) {
  const un = html.replace(/\\"/g, '"');
  const key = '"eagerLoadRefineSearch":';
  const at = un.indexOf(key);
  if (at < 0) return [];
  const start = un.indexOf('{', at + key.length);
  if (start < 0) return [];
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let k = start; k < un.length; k++) {
    const ch = un[k];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = k + 1; break; } }
  }
  if (end < 0) return [];
  let obj;
  try { obj = JSON.parse(un.slice(start, end)); } catch { return []; }
  const jobs = obj && obj.data && obj.data.jobs;
  if (!Array.isArray(jobs)) return [];
  return jobs.map((j) =>
    job({
      title: j.title,
      location: j.cityState || [j.city, j.state, j.country].filter(Boolean).join(', '),
      url: j.applyUrl || j.jobSeoUrl || (j.jobId ? `${host}/us/en/job/${j.jobId}` : host),
      team: j.category || j.department || '',
      text: [j.title, j.descriptionTeaser, (j.ml_skills || []).join(' '), j.description].filter(Boolean).join(' '),
    })
  );
}

/* Titles are recoverable from Zoho Recruit URL slugs. */
function zohoLinkJobs(html, base) {
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/\/jobs\/[Cc]areers\/(\d+)\/([A-Za-z0-9%\-_]+)/g)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    let slug = m[2];
    try { slug = decodeURIComponent(slug); } catch {}
    const title = slug.replace(/-+/g, ' ').replace(/\s+/g, ' ').trim();
    if (title.length < 3) continue;
    const j = job({ title, url: `${base}/jobs/Careers/${m[1]}/${m[2]}`, text: title });
    j._detail = j.url;
    j._detailKind = 'html';
    out.push(j);
  }
  return out;
}

/* ---------------------------------- generic (no-ATS) extraction strategies */

// 1. schema.org JobPosting in JSON-LD  (widest-compatibility signal there is)
function jsonLdJobs(html, base) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const seen = new Set();
    const walk = (n) => {
      if (!n || typeof n !== 'object' || seen.has(n)) return;
      seen.add(n);
      if (Array.isArray(n)) return n.forEach(walk);
      const t = n['@type'];
      if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) {
        const loc = Array.isArray(n.jobLocation) ? n.jobLocation[0] : n.jobLocation;
        const a = (loc && loc.address) || {};
        out.push(
          job({
            title: n.title,
            location: [a.addressLocality, a.addressRegion, a.addressCountry]
              .filter((x) => typeof x === 'string').join(', '),
            url: (typeof n.url === 'string' && n.url) || base,
            team: typeof n.occupationalCategory === 'string' ? n.occupationalCategory : '',
            text: [n.description, n.qualifications, n.experienceRequirements &&
              (n.experienceRequirements.monthsOfExperience
                ? `${Math.round(n.experienceRequirements.monthsOfExperience / 12)} years of experience`
                : n.experienceRequirements)].filter((x) => typeof x === 'string' || typeof x === 'number').join(' '),
          })
        );
      }
      Object.values(n).forEach(walk);
    };
    walk(data);
  }
  return out;
}

// 2. Next.js payloads (__NEXT_DATA__ or the flight stream) often carry the list
function nextDataJobs(html, base) {
  const out = [];
  const blobs = [];
  const nd = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (nd) blobs.push(nd[1]);
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/g)) {
    try { blobs.push(JSON.parse(`"${m[1]}"`)); } catch {}
  }
  for (const b of blobs) {
    let data;
    try { data = JSON.parse(b); } catch { data = null; }
    const push = (o) => {
      const title = o.title || o.jobTitle || o.name || o.position || o.role;
      if (typeof title !== 'string' || title.length < 4 || title.length > 140) return;
      const hay = JSON.stringify(o).toLowerCase();
      if (!/(location|department|apply|job|vacan|experience|employment)/.test(hay)) return;
      out.push(
        job({
          title,
          location: typeof o.location === 'string' ? o.location
            : (o.location && (o.location.name || o.location.city)) || o.city || o.jobLocation || '',
          url: typeof o.url === 'string' ? new URL(o.url, base).href
            : o.slug ? new URL(String(o.slug), base).href : base,
          team: typeof o.department === 'string' ? o.department : '',
          text: [o.description, o.jobDescription, o.requirements, o.experience, title]
            .filter((x) => typeof x === 'string').join(' '),
        })
      );
    };
    if (data) {
      const seen = new Set();
      const walk = (n) => {
        if (!n || typeof n !== 'object' || seen.has(n)) return;
        seen.add(n);
        if (Array.isArray(n)) return n.forEach(walk);
        push(n);
        Object.values(n).forEach(walk);
      };
      walk(data);
    } else {
      // flight stream isn't valid JSON on its own — pick out job-ish objects
      for (const m of b.matchAll(/\{[^{}]{0,600}?"(?:jobTitle|title)"\s*:\s*"([^"]{4,140})"[^{}]{0,600}?\}/g)) {
        try { push(JSON.parse(m[0])); } catch { out.push(job({ title: m[1], url: base, text: m[0] })); }
      }
    }
  }
  const seen = new Set();
  return out.filter((j) => {
    const k = j.title.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// 3. RSS / Atom feed of vacancies
async function feedJobs(origin, html) {
  const urls = new Set();
  if (html)
    for (const m of html.matchAll(/<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]*href=["']([^"']+)["']/gi)) {
      try { urls.add(new URL(m[1], origin).href); } catch {}
    }
  for (const p of ['/jobs/Careers/rss', '/careers/feed', '/jobs/feed', '/feed?post_type=job'])
    urls.add(origin + p);
  for (const u of [...urls].slice(0, 5)) {
    const r = await req(u, { timeout: 12000 });
    if (!r.ok || !/<item[\s>]/i.test(r.text)) continue;
    const items = [...r.text.matchAll(/<item[\s>]([\s\S]*?)<\/item>/gi)].map((m) => {
      const g = (t) => (m[1].match(new RegExp(`<${t}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${t}>`, 'i')) || [, ''])[1];
      return job({ title: stripHtml(g('title')), url: stripHtml(g('link')), text: stripHtml(g('description')) });
    }).filter((j) => j.title && !isMarketingContent(j.title, j.url));
    if (items.length && items.some((j) => /job|engineer|develop|manager|analyst|executive|intern|hiring/i.test(j.title)))
      return items;
  }
  return null;
}

// 4. WordPress REST API — extremely common on Indian company sites
async function wpJobs(origin) {
  const types = await getJson(`${origin}/wp-json/wp/v2/types`);
  if (!types.ok || !types.data || typeof types.data !== 'object') return null;
  const bases = Object.values(types.data)
    .map((t) => t && t.rest_base)
    .filter((b) => b && /job|career|vacan|opening|position|hiring/i.test(b));
  const out = [];
  for (const b of bases.slice(0, 3)) {
    const r = await getJson(`${origin}/wp-json/wp/v2/${b}?per_page=100`);
    if (!r.ok || !Array.isArray(r.data)) continue;
    for (const p of r.data)
      out.push(
        job({
          title: stripHtml((p.title && p.title.rendered) || p.slug),
          location: '',
          url: p.link,
          text: stripHtml(((p.content && p.content.rendered) || '') + ' ' + ((p.excerpt && p.excerpt.rendered) || '')),
        })
      );
  }
  const kept = out.filter((j) => j && j.title && !isMarketingContent(j.title, j.url));
  return kept.length ? kept : null;
}

// 5. sitemap that lists job detail pages
async function sitemapJobs(origin) {
  const seenMaps = new Set();
  const queue = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/robots.txt`];
  const jobUrls = new Set();
  while (queue.length && jobUrls.size < 300 && seenMaps.size < 8) {
    const u = queue.shift();
    if (seenMaps.has(u)) continue;
    seenMaps.add(u);
    const r = await req(u, { timeout: 12000 });
    if (!r.ok) continue;
    if (u.endsWith('robots.txt')) {
      for (const m of r.text.matchAll(/Sitemap:\s*(\S+)/gi)) queue.push(m[1]);
      continue;
    }
    for (const m of r.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
      const loc = m[1];
      if (/sitemap.*\.xml/i.test(loc) && /job|career/i.test(loc)) queue.push(loc);
      else if (/\/(job|jobs|career|careers|vacancy|vacancies|openings?)\/[^/]+\/?$/i.test(loc)) jobUrls.add(loc);
    }
  }
  if (jobUrls.size < 2) return null;
  const picked = [...jobUrls].slice(0, 40);
  const jobs = await pool(picked, 6, async (u) => {
    const r = await req(u, { timeout: 12000 });
    if (!r.ok) return null;
    const ld = jsonLdJobs(r.text, u);
    if (ld.length) return ld[0];
    const t = r.text.match(/<title>([^<]+)<\/title>/i);
    if (!t) return null;
    const st = t[1].split(/[|–-]/)[0].trim();
    if (isMarketingContent(st, u)) return null;
    return job({ title: st, url: u, text: stripHtml(r.text) });
  });
  const clean = jobs.filter(Boolean);
  return clean.length ? clean : null;
}

// 6. static career pages (very common for smaller Indian firms) list the roles
//    as plain headings/list items rather than links — pull those out.
const TITLE_WORD =
  /\b(engineers?|developers?|programmers?|architects?|analysts?|managers?|executives?|designers?|interns?|trainees?|leads?|consultants?|specialists?|officers?|associates?|scientists?|administrators?|coordinators?|strategists?|writers?|accountants?|recruiters?|sde|sdet|qa|devops|testers?|technicians?|supervisors?|directors?|assistants?|representatives?|advisors?|interns?|apprentice)\b/i;
const NOT_TITLE =
  /\b(we|our|you|your|us|the company|apply now|read more|learn more|click|email|contact|privacy|cookie|copyright|all rights|follow|share|subscribe|newsletter|home|about|blog|login|sign in)\b/i;

// Words that end a marketing phrase rather than a job title
// ("Developer Center", "Engineering Culture", "Our Design Team").
const NOT_TITLE_TAIL =
  /^(cent(er|re)|team|teams|culture|story|stories|life|page|portal|hub|program|programme|network|community|platform|solutions|services|experience|benefits|values|process|journey|world|india|blog|news|events|us|more|details|detail|reply|openings?|positions?|vacanc(y|ies)|now|here|today|all)$/i;

/* Nav links and section headers that survive the word filters. */
const NOT_A_JOB = new RegExp('^(' + [
  'join us', 'join our team', 'current openings', 'open positions', 'leave a reply',
  'apply now', 'view all jobs', 'all jobs', 'our people', 'our team', 'students',
  'life at work', 'work with us', 'career', 'careers', 'jobs', 'job openings',
  'why join us', 'meet the team', 'employee benefits', 'campus hiring', 'browse jobs',
  'our culture', 'how we work', 'our functions', 'open jobs', 'search jobs',
  'see all jobs', 'explore openings', 'board of directors', 'executive management',
  'cookies policy', 'read more', 'client service', 'client services',
  'professional development', 'the candidate experience', 'young professionals',
  'chro message', 'vacancies', 'deferred modules',
].join('|') + ')$', 'i');

/*
 * RSS feeds and sitemaps are site-wide, so a dev shop's marketing blog arrives
 * through exactly the same pipe as its vacancies — and its posts are all about
 * hiring, so every keyword filter waves them through. Four of the top five
 * entries in the priority folder were articles like "How Much Does It Cost to
 * Hire an App Developer?" and "Cost to Hire a Developer in India (2026)".
 *
 * The URL is the stronger signal (/blog/, /insights/), the headline shape is
 * the backstop. Applied only to the feed/sitemap/wordpress extractors — an ATS
 * board never serves its blog through its jobs API, so this must not narrow
 * the real providers.
 */
const NOT_POSTING_URL =
  /\/(blogs?|insights?|news|resources?|articles?|guides?|press|events?|webinars?|whitepapers?|ebooks?|podcasts?|case-stud\w*|stories|tags?|category|categories|author|about|services?|solutions?|portfolio|clients?)\//i;

const BLOG_HEADLINE = new RegExp(
  [
    '^(how|why|what|when|where|which|top\\s*\\d*|\\d+\\s+(best|top|ways|tips|reasons|things))\\b',
    '^(introducing|announcing|celebrating|understanding|exploring|choosing|building|unlocking|leveraging|navigating|comparing)\\b',
    '\\b(a comprehensive guide|complete guide|ultimate guide|step[- ]by[- ]step|pricing guide|cost to hire|cost of hiring|vs\\.?\\s|case study|webinar|whitepaper|checklist|roadmap|trends?\\s+(in|for)\\s|\\d{4}\\)?\\s*:)\\b',
    '\\?\\s*$',
  ].join('|'),
  'i',
);

/*
 * "Hire a Java Developer", "Hire Dedicated Flutter Developers" — a dev shop
 * selling its own staff, not a vacancy. These read exactly like job titles and
 * 60 of them reached the weekend folders, 18 into the priority one.
 *
 * This lives here rather than in one extractor because it has to apply to
 * BOTH paths: the heading/anchor extractors go through looksLikeJobTitle,
 * while feeds and sitemaps go through isMarketingContent. The identical filter
 * already existed in render-scan.js and was never carried across — the same
 * one-path-only mistake as the blog filter and the intern filter before it.
 */
const SERVICE_PAGE =
  /^(hire|outsource|offshore)\b|\b(hire|hiring)\s+(a|an|the)?\s*(dedicated|expert|top|best|remote|offshore)?\s*\w*\s*(developers?|engineers?|designers?|teams?|programmers?)\b|^(our|why choose|about)\s/i;

/** Reject marketing content that arrived through a site-wide feed or sitemap. */
function isMarketingContent(title, url) {
  if (url && NOT_POSTING_URL.test(String(url))) return true;
  const t = String(title || '');
  if (BLOG_HEADLINE.test(t) || SERVICE_PAGE.test(t)) return true;
  // Vacancy titles are noun phrases. Prose this long is an article headline.
  return t.split(/\s+/).length > 10;
}

/* A plural role noun at the end is a category heading, not a vacancy:
 * "Board of Directors", "Executive assistants", "Client Services". */
const PLURAL_ROLE_TAIL =
  /^(assistants|analysts|engineers|developers|managers|designers|executives|professionals|directors|consultants|specialists|officers|associates|technicians|trainees|interns|leads|architects|scientists|administrators|coordinators|recruiters|testers|programmers|openings|positions|vacancies|jobs|services|roles|opportunities)$/i;

/** Shared sanity check for titles produced by the HTML fallbacks (real ATS
 *  boards never go through here, so this can afford to be strict). */
function looksLikeJobTitle(t) {
  const s = (t || '').trim();
  if (!s || s.length < 5 || s.length > 80) return false;
  if (NOT_A_JOB.test(s)) return false;
  // A services page ("Hire a Java Developer") reads exactly like a vacancy.
  if (SERVICE_PAGE.test(s)) return false;
  // So does a blog headline: "Cost to Hire Full Stack Developer" reached the
  // priority folder through this path, because BLOG_HEADLINE was only applied
  // to feeds and sitemaps.
  if (BLOG_HEADLINE.test(s)) return false;
  const words = s.split(/\s+/);
  // One-word entries are section headings ("Development", "Analysts", "DevOps"),
  // never actual vacancies.
  if (words.length < 2 || words.length > 8) return false;
  if (/[.!?;:]$/.test(s)) return false;
  if (!/^[A-Z0-9]/.test(s)) return false;
  const last = words[words.length - 1];
  if (NOT_TITLE.test(s) || NOT_TITLE_TAIL.test(last) || PLURAL_ROLE_TAIL.test(last)) return false;
  return words.some((w) => TITLE_WORD.test(w));
}

function headingJobs(html, base) {
  // Pass 1: locate every heading-ish element that reads like a job title.
  const hits = [];
  const seen = new Set();
  const re = /<(h[1-6]|strong|b|a|span|div|p|td|li)\b[^>]*>([^<]{4,90})<\/\1>/gi;
  let m;
  while ((m = re.exec(html))) {
    const t = stripHtml(m[2]);
    if (!looksLikeJobTitle(t)) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({ title: t, start: m.index, end: m.index + m[0].length });
  }
  if (hits.length < 2) return [];

  // Pass 2: each role's description is the markup between its own heading and
  // the next one. Using the whole page instead would smear one listing's
  // "2-3 years / Java" across every other role on the page.
  return hits.slice(0, 60).map((h, i) => {
    const stop = Math.min(i + 1 < hits.length ? hits[i + 1].start : html.length, h.end + 2500);
    const j = job({ title: h.title, url: base, text: `${h.title} ${stripHtml(html.slice(h.end, stop))}` });
    j._noEnrich = true;
    return j;
  });
}

// 7. last resort — job-looking anchors in the page
function htmlJobs(html, base) {
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi)) {
    const href = m[1];
    const label = stripHtml(m[2]);
    if (!label || label.length < 4 || label.length > 120) continue;
    if (!/\/(jobs?|careers?|positions?|openings?|vacanc\w*|apply|o|p)\//i.test(href)) continue;
    let url;
    try { url = new URL(href, base).href; } catch { continue; }
    // Career-site nav ("Life at Yara", "Client Services", language switchers)
    // lives under the same /careers/ paths as real postings, so the label has
    // to read like a job title regardless of where the link points.
    const samePage = url.split('#')[0] === base.split('#')[0];
    if (!looksLikeJobTitle(label)) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const j = job({ title: label, url, text: label });
    if (samePage) j._noEnrich = true; // every role would share one description
    out.push(j);
  }
  return out;
}

/* ----------------------------------------------------------- discovery */

function slugs(company) {
  const n = norm(
    company.name
      .replace(/\(.*?\)/g, '')
      .replace(/\b(technologies|technology|solutions|systems|software|labs|group|inc|ltd|limited|private|pvt|corp|company|international|india|media|data|services|electric|motor|health|digital|energy|fund|interactive|gaming|venture engine|bikes|bus|brands|online|hospitals|hospitality|techworks|securities|bank|pakka|industries|systems)\b/gi, '')
  );
  const host = company.site.replace(/^www\./, '').split('.')[0].replace(/[^a-z0-9]/g, '');
  return [...new Set([n, host].filter((s) => s && s.length >= 4))]; // >=4 kills "yes", "yum"
}

function careerUrls(company) {
  const s = company.site.replace(/^https?:\/\//, '').replace(/\/$/, '').replace(/^www\./, '');
  const paths = (h) => [
    `https://careers.${h}`,
    `https://${h}/careers`,
    `https://${h}/career`,
    `https://${h}/jobs`,
    `https://${h}/join-us`,
    `https://${h}/join-our-team`,
    `https://${h}/careers.html`,
    `https://${h}/company/careers`,
    `https://${h}/about/careers`,
    `https://${h}/current-openings`,
    `https://${h}/`,
  ];
  /*
   * The www form is not a stylistic duplicate — a lot of large companies
   * publish no A record at the apex at all (fujitsu.com, dream11.com,
   * denso.com, schaeffler.com...). Probing only the bare domain makes every
   * one of them permanently "unreachable" no matter how many paths we try.
   * Bare first so the common case still resolves on the first request.
   */
  return [...new Set([company.careers, ...paths(s), ...paths(`www.${s}`)].filter(Boolean))];
}

/** Pull career-page links out of a homepage — the most reliable way to find a
 *  careers URL we could not guess. */
function careerLinksIn(html, base) {
  const out = new Set();
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,140}?)<\/a>/gi)) {
    const label = stripHtml(m[2]);
    if (!/(career|job|vacanc|opening|join[\s-]?us|join[\s-]?our|work[\s-]?with[\s-]?us|hiring|life[\s-]?at)/i.test(m[1] + ' ' + label)) continue;
    if (/\.(png|jpe?g|svg|gif|css|js|pdf)(\?|$)/i.test(m[1])) continue;
    try {
      const u = new URL(m[1], base);
      if (/^https?:$/.test(u.protocol)) out.add(u.href.split('#')[0]);
    } catch { /* ignore */ }
  }
  return [...out].slice(0, 6);
}

/* Multi-tenant job boards. A company's careers link often redirects here, but
 * their sitemap/feed lists every employer on the platform, not just this one. */
const AGGREGATORS = /(welcometothejungle|linkedin|indeed|glassdoor|naukri|wellfound|angel\.co|monster|shine\.com|timesjobs|foundit\.in|jobstreet|seek\.com|ycombinator\.com|builtin|dice\.com|ziprecruiter|simplyhired|jobsdb|instahyre|cutshort|hirist)\./i;

/*
 * Vendor domains that host a company's own job board. A careers page is very
 * often just a marketing landing page whose one useful link points here:
 * Delhivery -> delhivery.darwinbox.in, Flipkart -> flipkart.turbohire.co,
 * Hexaware -> an Oracle Cloud board advertising "All Jobs (293)". Those links
 * are off-domain, so the aggregator guard below used to discard them and the
 * scan stopped on a page with no jobs on it.
 */
const ATS_HOSTS =
  /(darwinbox\.(?:in|com)|turbohire\.co|myworkdayjobs\.com|oraclecloud\.com|successfactors\.(?:com|eu)|taleo\.net|icims\.com|smartrecruiters\.com|greenhouse\.io|lever\.co|ashbyhq\.com|zohorecruit\.(?:com|in|eu)|keka\.com|freshteam\.com|peoplestrong\.com|ripplehire\.com|phenompeople\.com|eightfold\.ai|jobvite\.com|workable\.com|recruitee\.com|teamtailor\.com|bamboohr\.com|breezy\.hr|recruiterbox\.com|hirebridge\.com|kekahire\.com|mynexthire\.com|skillate\.com|zwayam\.com|talentrecruit\.com|adrenalin\.\w+|sensehq\.com)/i;

/*
 * An ATS URL is this company's only when the company's own slug appears in it
 * — delhivery.darwinbox.in is Delhivery's, someoneelse.darwinbox.in is not.
 * Asymmetric on purpose, the same rule the board-name check uses: the company
 * identifies the board, never the other way round. Without this, one shared
 * vendor host would hand every company the same stranger's postings.
 */
function ownAtsBoard(origin, company) {
  let u;
  try { u = new URL(origin); } catch { return false; }
  if (!ATS_HOSTS.test(u.hostname)) return false;
  const hay = (u.hostname + u.pathname + u.search).toLowerCase().replace(/[^a-z0-9]/g, '');
  return slugs(company).some((s) => s.length >= 4 && hay.includes(s));
}

/** Is `origin` plausibly this company's own property (vs. a random aggregator)?
 *  `trusted` holds origins we reached by following redirects from a URL the
 *  company itself gave us, which covers rebrands (yashhighvoltage -> yashhv). */
function ownDomain(origin, company, trusted) {
  let host;
  try { host = new URL(origin).hostname.toLowerCase(); } catch { return false; }
  if (AGGREGATORS.test(host)) return false;
  if (trusted && trusted.has(new URL(origin).origin)) return true;
  if (ownAtsBoard(origin, company)) return true;
  if (company.careers) {
    try { if (new URL(company.careers).hostname.toLowerCase() === host) return true; } catch {}
  }
  const site = company.site.replace(/^www\./, '').toLowerCase();
  const root = site.split('.')[0].replace(/[^a-z0-9]/g, '');
  if (host.endsWith(site)) return true;
  if (root.length >= 4 && host.replace(/[^a-z0-9]/g, '').includes(root)) return true;
  const n = norm(company.name.replace(/\(.*?\)/g, ''));
  return n.length >= 5 && host.replace(/[^a-z0-9]/g, '').includes(n);
}

const NAME_CHECK = { greenhouse: 'greenhouseName', lever: 'leverName', ashby: 'ashbyName', workable: 'workableName' };

async function discover(company) {
  const trace = { pages: [], candidates: [], attempts: [] };
  const htmls = [];
  const fetched = new Set();
  const trusted = new Set();

  const grab = async (u, seed) => {
    if (!u || fetched.has(u) || htmls.length >= 4) return null;
    fetched.add(u);
    const r = await req(u);
    trace.pages.push({ url: u, status: r.status, bytes: r.text.length, error: r.error });
    // Plenty of SPA/CDN setups answer 404 while still serving the real page,
    // so judge on body size, not just status.
    // Several candidate URLs usually resolve to the very same page; counting
    // those against the page budget starved boards like careers.<company>.com.
    const dup = htmls.some((h) => Math.abs(h.html.length - r.text.length) < 8);
    if (r.text.length > 400 && r.status !== 0 && !dup) {
      htmls.push({ url: r.url, html: r.text, ok: r.ok });
      if (seed) { try { trusted.add(new URL(r.url).origin); } catch {} }
    }
    return r;
  };

  for (const u of careerUrls(company)) {
    if (htmls.length >= 3) break;
    await grab(u, true);
  }

  // Nothing convincing yet? Follow the "Careers" link off whatever we did get,
  // but never off the company's own property — an outbound link would otherwise
  // let a completely different company's board answer for this one.
  if (htmls.length < 3) {
    const seedPages = htmls.slice();
    for (const h of seedPages) {
      for (const l of careerLinksIn(h.html, h.url)) {
        if (htmls.length >= 4) break;
        if (!ownDomain(l, company, trusted)) { trace.pages.push({ url: l, status: 'skipped-off-domain' }); continue; }
        await grab(l);
      }
    }
  }

  const cands = [];
  const add = (c) => {
    if (!cands.some((x) => x.type === c.type && x.token === c.token && x.site === c.site)) cands.push(c);
  };
  if (company.ats) add({ ...company.ats, src: 'seed' });
  for (const h of htmls) for (const c of detect(h.html, h.url)) add({ ...c, src: 'html' });

  // Darwinbox / Zoho Recruit render individual job links into the company's own
  // careers page even when their own board is JS-only — harvest those links.
  for (const c of cands) {
    if (c.type === 'darwinbox') {
      const links = new Set(c._links || []);
      for (const h of htmls)
        for (const m of h.html.matchAll(/https?:\/\/[a-z0-9_-]+\.darwinbox\.(?:in|com)\/ms\/candidate(?:v2)?\/careers\/[a-z0-9]+/gi))
          links.add(m[0]);
      c._links = [...links];
    }
    if (c.type === 'zohorecruit') {
      const links = new Set(c._links || []);
      for (const h of htmls) {
        const origin = new URL(h.url).origin;
        for (const m of h.html.matchAll(/(https?:\/\/[a-z0-9_.-]+)?\/jobs\/[Cc]areers\/(\d+)\/([A-Za-z0-9%\-_]+)/gi))
          links.add(`${m[1] || origin}/jobs/Careers/${m[2]}/${m[3]}`);
      }
      c._links = [...links];
    }
  }

  // Blind slug guessing is a last resort and is skipped entirely when we already
  // know this company's ATS — otherwise a failing seed lets an unrelated board
  // with the same slug (e.g. ashby "yotta") answer for the company.
  if (!company.ats)
    for (const s of slugs(company))
      for (const type of ['greenhouse', 'lever', 'ashby', 'recruitee', 'workable'])
        add({ type, token: s, src: 'guess' });

  trace.candidates = cands.map((c) => `${c.type}:${String(c.token).slice(0, 48)}(${c.src})`);

  const ordered = [...cands.filter((c) => c.src !== 'guess'), ...cands.filter((c) => c.src === 'guess')];
  let emptyBoard = null;

  for (const c of ordered) {
    const fn = ATS[c.type];
    if (!fn) continue;
    let jobs = null;
    try { jobs = await fn(c); } catch (e) { trace.attempts.push(`${c.type}:${c.token} threw ${e.message}`); continue; }
    if (!Array.isArray(jobs)) { trace.attempts.push(`${c.type}:${String(c.token || c.host || '').slice(0, 40)} -> no board`); continue; }

    // a guessed token must prove it belongs to this company
    if (c.src === 'guess' && jobs.length) {
      const checker = NAME_CHECK[c.type];
      let boardName = null;
      if (checker) { try { boardName = await ATS[checker](c); } catch {} }
      if (!strictNameMatch(boardName || '', company.name)) {
        trace.attempts.push(
          `${c.type}:${c.token} -> REJECTED (board is "${boardName || '?'}", not ${company.name})`
        );
        continue;
      }
    }

    const label = `${c.type}:${String(c.token || c.host || '').replace(/^https?:\/\//, '').slice(0, 48)}`;
    trace.attempts.push(`${label} -> ${jobs.length} jobs${c.src === 'guess' ? ' (guess, name-verified)' : ''}`);
    if (jobs.length) return { source: label, jobs, trace };
    if (!emptyBoard && c.src !== 'guess') emptyBoard = { source: `${label} (0 open)`, jobs: [], trace, empty: true };
  }

  // Work the most careers-looking page first; a homepage that happens to be in
  // the list should never pre-empt the actual openings page.
  htmls.sort((a, b) => {
    const w = (u) => (/(career|job|vacanc|opening|hiring|join)/i.test(u) ? 0 : 1);
    return w(a.url) - w(b.url);
  });

  // An ATS that answered "0 open roles" is authoritative — believe it rather
  // than falling through and scraping stray words off the marketing page.
  if (emptyBoard) return emptyBoard;

  // ---- no ATS. Work through every strategy on the best page before moving to
  // the next one, so a rich careers page always beats the homepage.
  //
  // The origin-wide strategies (feed / WordPress / sitemap) are gated on the
  // page being the company's own property — otherwise a careers link that
  // redirects to a job aggregator would hand back that aggregator's whole
  // catalogue instead of this company's roles.
  for (const h of htmls) {
    const origin = new URL(h.url).origin;
    const own = ownDomain(origin, company, trusted);
    if (!own) trace.attempts.push(`skip off-domain ${origin}`);

    const ld = jsonLdJobs(h.html, h.url);
    if (ld.length) return { source: `json-ld:${h.url}`, jobs: ld, trace };

    // Next.js payloads and sitemaps carry marketing copy alongside vacancies,
    // so they go through the same title gate as the HTML scrapers.
    const nx = nextDataJobs(h.html, h.url).filter((j) => looksLikeJobTitle(j.title));
    if (nx.length >= 2) return { source: `next-data:${h.url}`, jobs: nx, trace };

    if (own) {
      const f = await feedJobs(origin, h.html);
      if (f) return { source: `feed:${origin}`, jobs: f, trace };

      const wp = await wpJobs(origin);
      if (wp) return { source: `wordpress:${origin}`, jobs: wp, trace };
    }

    const raw = htmlJobs(h.html, h.url);
    if (raw.length >= 2) return { source: `html:${h.url}`, jobs: raw, trace };

    // Static pages that simply print the role names. Only trust a page that
    // looks like a careers page to begin with.
    if (/(career|job|vacanc|opening|hiring|join)/i.test(h.url)) {
      const hd = headingJobs(h.html, h.url);
      if (hd.length >= 2) return { source: `headings:${h.url}`, jobs: hd, trace };
    }
  }

  // Sitemap crawling is the slowest option, so it runs only once everything
  // cheaper has come up empty.
  for (const h of htmls) {
    const origin = new URL(h.url).origin;
    if (!ownDomain(origin, company, trusted)) continue;
    const sm = await sitemapJobs(origin);
    const smClean = (sm || []).filter((j) => looksLikeJobTitle(j.title));
    if (smClean.length >= 2) return { source: `sitemap:${origin}`, jobs: smClean, trace };
  }

  return {
    source: null,
    jobs: [],
    trace,
    error: !htmls.length
      ? 'careers-page-unreachable'
      // A body arrived, but every response was an error status: that is a bot
      // wall or a dead route, not an employer with nothing to advertise.
      : htmls.every((h) => !h.ok)
        ? 'blocked-or-error-response'
        : htmls.some((h) => h.ok && /(career|job|vacanc|opening|hiring|join)/i.test(h.url))
          ? 'careers-page-read-but-lists-no-openings'
          : 'no-job-data-found',
  };
}

/* ------------------------------------------------------------- matching */

const RE_JAVA = /\bjava\b(?!\s*script)/i;
const RE_FLUTTER = /\b(flutter|dart)\b/i;
const RE_ANDROID = /\b(android|kotlin)\b/i;
const RE_ENG_TITLE =
  /(software|backend|back[\s-]?end|frontend|front[\s-]?end|full[\s-]?stack|application|platform|mobile|android|ios|web|java|python|node|golang|api|sde|systems?|qa|test|data|devops|cloud|ml|ai)\s*[-\s]*(engineer|developer|dev\b|programmer|architect)|(\bengineer\b|\bdeveloper\b|\bsde\b|\bsdet\b|\bprogrammer\b|\btech lead\b)/i;
const RE_SENIOR = /\b(senior|sr\.?|staff|principal|lead|architect|manager|director|head|vp|chief|iii|iv|expert|avp|dvp)\b/i;
const RE_INTERN = /\b(intern|internship|trainee|apprentice|co[- ]?op)\b/i;
/* 'intern' used to sit in RE_JUNIOR, which ADDS score -- so internships ranked
 * high in a two-year list (a Stripe internship reached #15 of the priority
 * folder). Junior is a positive signal for this candidate; an internship is not
 * the same thing and is not a target at all. */
const RE_JUNIOR = /\b(junior|jr\.?|associate|entry|graduate|fresher|sde[\s-]?1|engineer\s*i\b|level\s*1|l1|i\b)\b/i;
const RE_INDIA =
  /\b(india|bangalore|bengaluru|hyderabad|pune|mumbai|chennai|delhi|gurgaon|gurugram|noida|kolkata|ahmedabad|jaipur|indore|kochi|coimbatore|trivandrum|thiruvananthapuram|chandigarh|vadodara|nagpur|mysore|mysuru)\b/i;

function expWindows(text) {
  const out = [];
  const t = String(text).replace(/[–—]/g, '-');
  for (const m of t.matchAll(/(\d{1,2})\s*(?:-|to)\s*(\d{1,2})\s*\+?\s*(?:years?|yrs?)/gi)) out.push([+m[1], +m[2]]);
  for (const m of t.matchAll(/(\d{1,2})\s*\+\s*(?:years?|yrs?)/gi)) out.push([+m[1], +m[1] + 4]);
  for (const m of t.matchAll(/(?:minimum|min\.?|at\s?least|atleast|over|more than)\s*(?:of\s*)?(\d{1,2})\s*(?:years?|yrs?)/gi)) out.push([+m[1], +m[1] + 4]);
  for (const m of t.matchAll(/(\d{1,2})\s*(?:years?|yrs?)\s*(?:of\s+)?(?:relevant\s+|hands[\s-]on\s+|professional\s+|work\s+|industry\s+)?(?:experience|exp\b)/gi)) out.push([+m[1], +m[1] + 1]);
  const seen = new Set();
  return out.filter(([a, b]) => {
    if (!(a >= 0 && b >= a && b <= 30)) return false;
    const k = `${a}:${b}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/*
 * Which stack keywords are page furniture rather than a real requirement.
 *
 * A dev shop's careers page carries a nav/footer listing every service it
 * sells ("PHP Development, Java Development, Flutter App Development, ...").
 * When we open a posting to read it, that whole chrome comes along, so a
 * React Native role reads as Java + Flutter and lands in the priority bucket.
 *
 * A keyword in EVERY posting is site chrome; a real requirement varies role to
 * role. Judge that only over the postings we actually opened — enrichment only
 * opens engineering titles, so a sales role keeps its short listing text with
 * no chrome in it, and counting those would mask the signal every time.
 */
function boilerplateStacks(jobs) {
  const out = { java: false, flutter: false, android: false };
  const full = jobs.filter((j) => j._enriched);
  if (full.length < 3) return out;
  const hit = { java: 0, flutter: 0, android: 0 };
  for (const j of full) {
    const t = `${j.team || ''} ${j.text || ''}`;
    if (RE_JAVA.test(t)) hit.java++;
    if (RE_FLUTTER.test(t)) hit.flutter++;
    if (RE_ANDROID.test(t)) hit.android++;
  }
  for (const k of Object.keys(out)) out[k] = hit[k] === full.length;
  return out;
}

function score(j, company, boiler = {}) {
  const title = j.title || '';
  const body = `${title} ${j.team} ${j.text}`;
  const isEng = RE_ENG_TITLE.test(title);
  // When a keyword is boilerplate for this board, only the title can earn it.
  const stack = (re, isBoiler) => (isBoiler ? re.test(title) : re.test(body));
  const java = stack(RE_JAVA, boiler.java);
  const flutter = stack(RE_FLUTTER, boiler.flutter);
  const android = stack(RE_ANDROID, boiler.android);
  const wins = expWindows(body);
  const fits2 = wins.some(([a, b]) => a <= 2 && b >= 2);
  const near2 = wins.some(([a, b]) => a <= 4 && b >= 1);
  const senior = RE_SENIOR.test(title);
  const junior = RE_JUNIOR.test(title);
  // Not a two-year target at all, and it used to score as a junior bonus.
  const intern = RE_INTERN.test(title);
  const india = RE_INDIA.test(`${j.location} ${j.text.slice(0, 500)}`) || (company.country === 'India' && !j.location);

  let s = 0;
  if (isEng) s += 30;
  if (java) s += 25;
  if (flutter) s += 28;
  if (android && !java && !flutter) s += 8;
  if (fits2) s += 30;
  else if (near2) s += 12;
  else if (!wins.length) s += 4;
  if (junior && !intern) s += 12;
  if (intern) s -= 40;
  if (senior) s -= 22;
  if (india) s += 15;

  const priority = java || flutter;
  const isMatch = isEng && priority && !senior && !intern && (fits2 || (!wins.length && junior));

  return { score: s, isMatch, isEng, java, flutter, android, india, senior, junior, intern, exp: wins.slice(0, 6), expFits2: fits2 };
}

/* Job listings often omit the description; open the posting to read the
 * experience requirement for anything that looks like an engineering role. */
async function enrich(jobs, company) {
  const need = jobs
    .map((j, i) => ({ j, i }))
    // Open the posting when the listing is thin OR when it never gave us a
    // location — location decides the India preference, so a missing one is
    // just as much a reason to fetch as a missing description.
    .filter(
      ({ j }) =>
        !j._noEnrich &&
        RE_ENG_TITLE.test(j.title) &&
        ((j.text || '').length < 400 || !j.location) &&
        (j._detail || j.url)
    )
    .slice(0, ENRICH_MAX);
  if (!need.length) return 0;
  let n = 0;
  await pool(need, 4, async ({ j }) => {
    const url = j._detail || j.url;
    if (j._detailKind === 'workday') {
      const r = await getJson(url, { timeout: 15000 });
      const d = r.ok && r.data && r.data.jobPostingInfo;
      if (d) { j.text = stripHtml([d.jobDescription, d.jobRequirements].filter(Boolean).join(" ")).slice(0, 14000); j._enriched = true; n++; }
      return;
    }
    if (/api\.smartrecruiters\.com/.test(url)) {
      const r = await getJson(url, { timeout: 15000 });
      const s = r.ok && r.data && r.data.jobAd && r.data.jobAd.sections;
      if (s) {
        j.text = stripHtml(Object.values(s).map((x) => (x && x.text) || '').join(' ')).slice(0, 14000);
        j._enriched = true;
        n++;
      }
      return;
    }
    const r = await req(url, { timeout: 15000 });
    if (!r.ok) return;
    const ld = jsonLdJobs(r.text, url);
    const body = ld.length && ld[0].text ? ld[0].text : stripHtml(r.text);
    if (body && body.length > (j.text || "").length) { j.text = body.slice(0, 14000); j._enriched = true; n++; }
    if (!j.location && ld.length && ld[0].location) j.location = ld[0].location;
  });
  return n;
}

/* ---------------------------------------------------------------- main */

async function run() {
  let list = COMPANIES;
  if (ONLY) list = list.filter((c) => (c.name + c.site).toLowerCase().includes(ONLY.toLowerCase()));
  if (LIMIT) list = list.slice(0, LIMIT);

  console.log(`Checking ${list.length} companies (concurrency ${CONCURRENCY})\n`);
  let done = 0;

  const results = await pool(list, CONCURRENCY, async (company) => {
    const t0 = Date.now();
    const d = await withDeadline(discover(company), COMPANY_MS, () => ({
      jobs: [], source: null, error: 'timed-out', trace: { pages: [], attempts: [] },
    }));
    const enriched = d.jobs.length
      ? await withDeadline(enrich(d.jobs, company), ENRICH_MS, () => 0)
      : 0;
    const boiler = boilerplateStacks(d.jobs);
    const scored = d.jobs
      .map((j) => ({ ...j, ...score(j, company, boiler) }))
      .sort((a, b) => b.score - a.score);

    const r = {
      company: company.name,
      country: company.country,
      careers: company.careers,
      source: d.source,
      error: d.error || null,
      totalJobs: d.jobs.length,
      // Full (compact) listing so the run can be re-analysed without refetching
      // — e.g. "how many of these are in India?".
      jobs: scored.map((j) => ({
        title: j.title,
        location: j.location,
        url: j.url,
        india: j.india,
        locationSaysIndia: RE_INDIA.test(j.location || ''),
        hasLocation: Boolean(j.location),
        isEng: j.isEng,
        java: j.java,
        flutter: j.flutter,
        senior: j.senior,
        exp: j.exp,
        expFits2: j.expFits2,
        score: j.score,
      })),
      enriched,
      matches: scored.filter((j) => j.isMatch),
      // Engineering + priority stack, but the 2-year window is unstated or a
      // little off — worth surfacing rather than silently dropping.
      nearMatches: scored.filter((j) => !j.isMatch && j.isEng && (j.java || j.flutter) && !j.senior).slice(0, 6),
      closest: scored[0] || null,
      closestEng: scored.find((j) => j.isEng) || null,
      trace: d.trace,
      ms: Date.now() - t0,
    };
    done++;
    const tag = r.error ? `!! ${r.error}` : `${String(r.totalJobs).padStart(3)} jobs  via ${r.source}`;
    console.log(
      `[${String(done).padStart(3)}/${list.length}] ${company.name.padEnd(28).slice(0, 28)} ${tag}` +
        (r.matches.length ? `   ** ${r.matches.length} MATCH **` : '')
    );
    return r;
  });

  /* A --only/--limit run covers a handful of companies. Letting it write the
   * canonical results.json/careers.txt silently destroys a full sweep that took
   * half an hour, so partial runs go to their own files. */
  const partial = Boolean(ONLY || LIMIT);
  const reportFile = OUT ? `${OUT}.txt` : partial ? 'careers.partial.txt' : 'careers.txt';
  const resultsFile = OUT ? `${OUT}.results.json` : partial ? 'results.partial.json' : 'results.json';
  fs.writeFileSync(path.join(__dirname, resultsFile), JSON.stringify(results, null, 2));
  writeReport(results, list.length, reportFile);

  const okFetch = results.filter((r) => r.totalJobs > 0).length;
  const empty = results.filter((r) => !r.error && r.totalJobs === 0).length;
  const failed = results.filter((r) => r.error).length;
  const matched = results.filter((r) => r.matches.length).length;
  console.log(
    `\n  boards read with jobs : ${okFetch}` +
    `\n  boards read, 0 open   : ${empty}` +
    `\n  could not read        : ${failed}` +
    `\n  companies w/ matches  : ${matched}` +
    `\n\nWrote ${reportFile} + ${resultsFile}`
  );
}

function fmtJob(j, indent = '    ') {
  const exp = j.exp && j.exp.length ? j.exp.map(([a, b]) => `${a}-${b}y`).join(' / ') : 'not stated';
  const tech = [j.java && 'Java', j.flutter && 'Dart/Flutter', j.android && 'Android'].filter(Boolean).join(' + ') || '—';
  return (
    `${indent}${j.title}\n` +
    `${indent}  location : ${j.location || 'n/a'}${j.india ? '   [INDIA]' : ''}\n` +
    `${indent}  exp req  : ${exp}    stack: ${tech}    score: ${j.score}\n` +
    `${indent}  url      : ${j.url || 'n/a'}`
  );
}

function writeReport(results, total, reportFile) {
  const L = [];
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const nMatch = results.reduce((n, r) => n + r.matches.length, 0);
  const withMatches = results.filter((r) => r.matches.length);

  L.push('='.repeat(78));
  L.push(`OPEN ROLES AT ${total} "W" COMPANIES`);
  L.push('Looking for : Software Engineer, ~2 years experience');
  L.push('Priority    : Java, Dart/Flutter        Location preference : India');
  L.push(`Generated   : ${now} UTC  by test.js`);
  L.push('='.repeat(78));
  L.push('');
  L.push(`Boards read with open roles : ${results.filter((r) => r.totalJobs > 0).length}`);
  L.push(`Boards read, currently empty: ${results.filter((r) => !r.error && r.totalJobs === 0).length}`);
  L.push(`Could not read              : ${results.filter((r) => r.error).length}`);
  L.push(`Total open roles seen       : ${results.reduce((n, r) => n + r.totalJobs, 0)}`);
  L.push('');

  L.push('#'.repeat(78));
  L.push('# SECTION 1 — MATCHES: Software Engineer + Java/Dart/Flutter + ~2 yrs');
  L.push(`# ${nMatch} role(s) across ${withMatches.length} company(s)`);
  L.push('#'.repeat(78));
  L.push('');
  if (!withMatches.length) {
    L.push('  Nothing matched all three criteria in this run.');
    L.push('  Section 4 lists the closest role at every company instead, which also');
    L.push('  proves the script really read each board.');
    L.push('');
  }
  for (const r of [...withMatches].sort((a, b) => {
    const ai = a.matches.some((m) => m.india) ? 0 : 1;
    const bi = b.matches.some((m) => m.india) ? 0 : 1;
    return ai - bi || b.matches[0].score - a.matches[0].score;
  })) {
    L.push(`>> ${r.company}  [${r.country}]   via ${r.source}`);
    for (const m of r.matches) L.push(fmtJob(m));
    L.push('');
  }

  /* Sections 1 and 2 both insist on Java or Dart/Flutter. The brief allows any
   * stack as long as the role is engineering at roughly the 2-year mark, and
   * India is the location preference — so give that its own section rather than
   * leaving those roles buried in the per-company listing. */
  const indiaRows = [];
  for (const r of results)
    for (const j of r.jobs)
      if (j.india && j.isEng && !j.senior) indiaRows.push({ company: r.company, source: r.source, ...j });
  indiaRows.sort((a, b) => b.score - a.score);
  const indiaFits = indiaRows.filter((j) => j.expFits2 || !j.exp.length);
  const indiaRest = indiaRows.filter((j) => !(j.expFits2 || !j.exp.length));

  L.push('#'.repeat(78));
  L.push('# SECTION 2 — INDIA: engineering, non-senior, ANY stack');
  L.push(`# ${indiaRows.length} role(s). Java/Dart-Flutter still rank highest, but the brief allows`);
  L.push('# any tech stack, so these are the India roles worth a look regardless.');
  L.push(`# 2a: states a window covering ~2 yrs, or states none (${indiaFits.length})`);
  L.push(`# 2b: states a different window — usually 3-5 yrs (${indiaRest.length})`);
  L.push('#'.repeat(78));
  L.push('');
  const pushGrouped = (rows) => {
    let last = null;
    for (const j of rows) {
      if (j.company !== last) {
        L.push(`>> ${j.company}`);
        last = j.company;
      }
      L.push(fmtJob(j));
    }
  };
  L.push(`-- 2a --------------------------------------------- fits ~2 years (${indiaFits.length})`);
  L.push('');
  pushGrouped(indiaFits);
  L.push('');
  L.push(`-- 2b ------------------------------------ states a wider window (${indiaRest.length})`);
  L.push('');
  pushGrouped(indiaRest.slice(0, 60));
  if (indiaRest.length > 60) L.push(`    ... and ${indiaRest.length - 60} more (see results.json)`);
  L.push('');

  const near = results.filter((r) => r.nearMatches.length);
  const nearIndiaFirst = [...near].sort((a, b) => {
    const w = (r) => (r.country === 'India' ? 0 : r.nearMatches.some((m) => m.india) ? 1 : 2);
    return w(a) - w(b);
  });
  L.push('#'.repeat(78));
  L.push('# SECTION 3 — NEAR MATCHES: engineering + Java/Dart/Flutter, non-senior,');
  L.push('#              but the posting does not state a 2-year window (India first)');
  L.push('#'.repeat(78));
  L.push('');
  for (const r of nearIndiaFirst) {
    L.push(`>> ${r.company}  [${r.country}]   via ${r.source}`);
    for (const m of r.nearMatches) L.push(fmtJob(m));
    L.push('');
  }

  L.push('#'.repeat(78));
  L.push('# SECTION 4 — CLOSEST ROLE PER COMPANY  (fetch verification)');
  L.push('# One live posting from every board the script could read. If a company');
  L.push('# had no match above, its nearest engineering role is shown here so you');
  L.push('# can confirm the fetch worked rather than silently returning nothing.');
  L.push('#'.repeat(78));
  L.push('');
  const readable = results.filter((r) => !r.error);
  for (const r of [...readable].sort((a, b) => (a.country === 'India' ? 0 : 1) - (b.country === 'India' ? 0 : 1))) {
    const pick = r.closestEng || r.closest;
    L.push(`>> ${r.company}  [${r.country}]`);
    L.push(`    board    : ${r.source}   —  ${r.totalJobs} open role${r.totalJobs === 1 ? '' : 's'}`);
    if (pick) L.push(fmtJob(pick));
    else L.push('    (board reached successfully, but it has 0 open roles right now)');
    L.push('');
  }

  const bad = results.filter((r) => r.error);
  L.push('#'.repeat(78));
  L.push(`# SECTION 5 — NOT READ  (${bad.length} of ${total})`);
  L.push('# lists-no-openings  = careers page loaded fine, published no vacancies');
  L.push('# blocked-or-error    = bot wall / dead route (403, 404) — needs a browser');
  L.push('# unreachable         = domain did not respond at all');
  L.push('# timed-out           = board too slow to read inside the per-company cap');
  L.push('#'.repeat(78));
  L.push('');
  for (const r of [...bad].sort((a, b) => String(a.error).localeCompare(String(b.error)))) {
    L.push(`>> ${r.company}  [${r.country}]  — ${r.error}`);
    L.push(`    careers page : ${r.careers}`);
    L.push(`    http status  : ${r.trace.pages.map((h) => `${h.status}`).join(', ')}`);
    if (r.trace.attempts.length) L.push(`    ATS tried    : ${r.trace.attempts.slice(0, 4).join(' ; ')}`);
    L.push('');
  }

  fs.writeFileSync(path.join(__dirname, reportFile || 'careers.txt'), L.join('\n'));
}

/* Re-render careers.txt from the last run's results.json. The sweep takes ~30
 * minutes, so iterating on the report format must not require refetching. */
function reportOnly() {
  const src = argVal('from', OUT ? `${OUT}.results.json` : 'results.json');
  const dest = OUT ? `${OUT}.txt` : 'careers.txt';
  const results = JSON.parse(fs.readFileSync(path.join(__dirname, src), 'utf8'));
  writeReport(results, results.length, dest);
  console.log(`Rebuilt ${dest} from ${src} (${results.length} companies)`);
}

/* Required as a module (by weekendplan/render-scan.js) rather than run: hand
 * over the classifiers so rendered jobs are scored by exactly the same rules
 * as fetched ones, instead of a second copy that drifts. */
if (require.main !== module) {
  module.exports = { score, boilerplateStacks, expWindows, stripHtml, RE_INDIA, RE_ENG_TITLE, ownAtsBoard, ATS_HOSTS };
} else if (ARGS.includes('--report-only')) reportOnly();
else
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
