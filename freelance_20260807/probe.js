#!/usr/bin/env node
/*
 * probe.js — find out which freelance sources are actually readable, BEFORE
 * writing an adapter for any of them.
 *
 * The failure mode this exists to prevent: an endpoint that returns HTTP 200
 * while serving an SPA HTML shell, a block page, or — worst — a real-looking
 * JSON payload that silently ignored the search parameter and handed back the
 * whole unfiltered board. All three look like success to a naive scraper and
 * poison the run with junk.
 *
 * So every candidate is judged on what came back, not on the status code:
 *   - content-type AND a JSON.parse / <item> check
 *   - a plausible item count at a plausible path
 *   - for searchable endpoints, a differential test: ask for two different
 *     terms and require the results to actually differ. Identical payloads
 *     mean the query parameter is decorative.
 *
 * Usage: node probe.js            (writes probe-results.json)
 */

const fs = require('fs');
const path = require('path');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function hit(url, opts = {}) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), opts.timeout || 25000);
  try {
    const r = await fetch(url, {
      method: opts.method || 'GET',
      headers: {
        'user-agent': UA,
        accept: opts.accept || 'application/json,text/html,*/*',
        ...(opts.headers || {}),
      },
      body: opts.body,
      redirect: 'follow',
      signal: c.signal,
    });
    const text = await r.text();
    return { status: r.status, ct: r.headers.get('content-type') || '', text, bytes: text.length };
  } catch (e) {
    return { status: 0, ct: '', text: '', bytes: 0, error: String(e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

const J = (t) => { try { return JSON.parse(t); } catch { return null; } };
const dig = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);

/* Candidate list. `pick` names the array path inside the JSON; `q` marks an
 * endpoint that claims to search, which triggers the differential test. */
const CANDIDATES = [
  // ---- known-good baseline, re-verified each run --------------------------
  { name: 'freelancer.com', q: true,
    url: (s) => `https://www.freelancer.com/api/projects/0.1/projects/active/?query=${s}&limit=20&job_details=true`,
    pick: 'result.projects' },

  // ---- from PLATFORMS.md §3, previously probed ----------------------------
  { name: 'braintrust', url: () => 'https://app.usebraintrust.com/api/jobs/?page=1', pick: 'results' },
  { name: 'arc.dev', url: (s) => `https://arc.dev/remote-jobs/${s}`, q: true, html: '__NEXT_DATA__' },
  { name: 'torre', q: true, method: 'POST',
    url: () => 'https://search.torre.co/opportunities/_search/?offset=0&size=20&aggregate=false',
    body: (s) => JSON.stringify({ 'skill/role': { text: s, experience: 'potential-to-develop' } }),
    headers: { 'content-type': 'application/json' }, pick: 'results' },
  { name: 'jobgether', q: true, url: (s) => `https://jobgether.com/astroapi/ai/jobs?keyword=${s}`, pick: null },

  // ---- direct-contact goldmines (emails live in the body text) -----------
  { name: 'hn-algolia-search', q: true,
    url: (s) => `https://hn.algolia.com/api/v1/search?query=${s}&tags=comment&hitsPerPage=20`,
    pick: 'hits' },
  { name: 'hn-whoishiring-thread', q: false,
    url: () => 'https://hn.algolia.com/api/v1/search?query=Freelancer%3F%20Seeking%20freelancer%3F&tags=story&hitsPerPage=5',
    pick: 'hits' },
  { name: 'reddit-forhire', q: false,
    url: () => 'https://www.reddit.com/r/forhire/new.json?limit=50', pick: 'data.children' },
  { name: 'reddit-jobbit', q: false,
    url: () => 'https://www.reddit.com/r/jobbit/new.json?limit=50', pick: 'data.children' },
  { name: 'reddit-freelance-forhire', q: false,
    url: () => 'https://www.reddit.com/r/freelance_forhire/new.json?limit=50', pick: 'data.children' },
  { name: 'reddit-search-hiring', q: true,
    url: (s) => `https://www.reddit.com/search.json?q=${s}%20hiring&sort=new&limit=50`, pick: 'data.children' },

  // ---- gig marketplaces, unverified --------------------------------------
  { name: 'peopleperhour-html', q: true, url: (s) => `https://www.peopleperhour.com/freelance-jobs?q=${s}`, html: 'job' },
  { name: 'truelancer-api', q: true, url: (s) => `https://www.truelancer.com/api/v1/projects?search=${s}`, pick: null },
  { name: 'truelancer-html', q: true, url: (s) => `https://www.truelancer.com/freelance-jobs?search=${s}`, html: 'project' },
  { name: 'workana-api', q: true, url: (s) => `https://www.workana.com/api/v2/projects?query=${s}`, pick: null },
  { name: 'guru', q: true, url: (s) => `https://www.guru.com/d/jobs/?q=${s}`, html: 'job' },
  { name: 'freelancermap-rss', q: true, url: (s) => `https://www.freelancermap.com/rss/projects.xml?query=${s}`, xml: true },
  { name: 'freelancermap-html', q: true, url: (s) => `https://www.freelancermap.com/freelance-projects.html?query=${s}`, html: 'project' },
  { name: 'useme-html', q: true, url: (s) => `https://useme.com/en/jobs/?search=${s}`, html: 'job' },
  { name: 'codeur-rss', q: false, url: () => 'https://www.codeur.com/projects.rss', xml: true },
  { name: 'twago-html', q: true, url: (s) => `https://www.twago.com/projects/?search=${s}`, html: 'project' },
  { name: 'golance-api', q: true, url: (s) => `https://golance.com/api/v1/jobs/search?query=${s}`, pick: null },
  { name: 'hubstaff-talent', q: true, url: (s) => `https://talent.hubstaff.com/search/jobs?search[keywords]=${s}`, html: 'job' },
  { name: 'outsourcely', q: false, url: () => 'https://www.outsourcely.com/remote-jobs', html: 'job' },
  { name: 'gun-io', q: false, url: () => 'https://gun.io/find-work/', html: 'job' },
  { name: 'contra-api', q: true, url: (s) => `https://contra.com/api/search/opportunities?query=${s}`, pick: null },
  { name: 'lemon-io', q: false, url: () => 'https://lemon.io/jobs/', html: 'job' },
  { name: 'twine-api', q: true, url: (s) => `https://www.twine.net/api/jobs?search=${s}`, pick: null },
  { name: 'kolabtree', q: false, url: () => 'https://www.kolabtree.com/jobs', html: 'job' },
  { name: 'wripple', q: false, url: () => 'https://www.wripple.com/marketplace', html: 'job' },

  // ---- design / 3D specific (for the friends) -----------------------------
  { name: 'dribbble-jobs', q: false, url: () => 'https://dribbble.com/jobs', html: 'job' },
  { name: 'behance-joblist', q: true, url: (s) => `https://www.behance.net/joblist?search=${s}`, html: 'job' },
  { name: 'blendermarket-jobs', q: false, url: () => 'https://blendswap.com/', html: 'blend' },
  { name: 'polycount-jobs-rss', q: false, url: () => 'https://polycount.com/categories/freelance-job-postings/feed.rss', xml: true },
  { name: 'cgtrader-jobs', q: false, url: () => 'https://www.cgtrader.com/freelance-3d-jobs', html: 'job' },
  { name: 'artstation-jobs', q: false, url: () => 'https://www.artstation.com/api/v2/jobs/search.json?page=1', pick: 'data' },
  { name: 'uxjobsboard-rss', q: false, url: () => 'https://uxjobsboard.com/feed', xml: true },

  // ---- open remote/tech boards not already in the old sweep ---------------
  { name: 'python-org-jobs-rss', q: false, url: () => 'https://www.python.org/jobs/feed/rss/', xml: true },
  { name: 'larajobs-rss', q: false, url: () => 'https://larajobs.com/feed', xml: true },
  { name: 'web3career-api', q: true, url: (s) => `https://web3.career/api/v1?token=demo&q=${s}`, pick: null },
  { name: 'cryptojobslist', q: true, url: (s) => `https://cryptojobslist.com/api/jobs?search=${s}`, pick: null },
  { name: 'nodesk-rss', q: false, url: () => 'https://nodesk.co/remote-jobs/index.xml', xml: true },
  { name: 'remoteco-rss', q: false, url: () => 'https://remote.co/remote-jobs/feed/', xml: true },
  { name: 'justremote', q: false, url: () => 'https://justremote.co/api/remote-jobs', pick: null },
  { name: 'workingnomads-tags', q: false, url: () => 'https://www.workingnomads.com/api/exposed_jobs/', pick: null },
  { name: 'devitjobs-api', q: false, url: () => 'https://devitjobs.uk/api/jobsLight', pick: null },
  { name: 'okjob-api', q: false, url: () => 'https://okjob.io/api/jobs', pick: null },
  { name: 'wellfound-html', q: true, url: (s) => `https://wellfound.com/role/r/${s}`, html: 'job' },
  { name: 'weworkremotely-design-rss', q: false, url: () => 'https://weworkremotely.com/categories/remote-design-jobs.rss', xml: true },
  { name: 'weworkremotely-all-rss', q: false, url: () => 'https://weworkremotely.com/remote-jobs.rss', xml: true },
  { name: 'jobicy-all', q: false, url: () => 'https://jobicy.com/api/v2/remote-jobs?count=50', pick: 'jobs' },
  { name: 'himalayas-api', q: false, url: () => 'https://himalayas.app/jobs/api?limit=20', pick: 'jobs' },
  { name: 'adzuna-noauth', q: true, url: (s) => `https://api.adzuna.com/v1/api/jobs/in/search/1?what=${s}`, pick: null },
  { name: 'jooble-noauth', q: false, url: () => 'https://jooble.org/api/', pick: null },
  { name: 'findwork-dev', q: true, url: (s) => `https://findwork.dev/api/jobs/?search=${s}`, pick: 'results' },
  { name: 'jobdataapi', q: true, url: (s) => `https://jobdataapi.com/api/jobs/?title=${s}&max_age=30`, pick: 'results' },
  { name: 'remoteok-api', q: false, url: () => 'https://remoteok.com/api', pick: null },
  { name: 'openskills-usajobs', q: false, url: () => 'https://data.usajobs.gov/api/search?Keyword=flutter', pick: null },
];

/* Two deliberately unrelated terms. If a "search" endpoint returns the same
 * payload for both, the query param is being ignored. */
const T1 = 'flutter';
const T2 = 'blender';

function shape(text, cand) {
  const j = J(text);
  if (j) {
    let items = null;
    if (cand.pick) items = dig(j, cand.pick);
    if (!Array.isArray(items)) {
      // find the longest array anywhere shallow — tells us where the data is
      const seen = [];
      const walk = (o, p, d) => {
        if (d > 3 || o == null || typeof o !== 'object') return;
        if (Array.isArray(o)) { seen.push([p, o.length]); return; }
        for (const k of Object.keys(o)) walk(o[k], p ? `${p}.${k}` : k, d + 1);
      };
      walk(j, '', 0);
      seen.sort((a, b) => b[1] - a[1]);
      return { kind: 'json', items: seen[0] ? seen[0][1] : 0, at: seen[0] ? seen[0][0] || '(root)' : null,
               arrays: seen.slice(0, 4) };
    }
    return { kind: 'json', items: items.length, at: cand.pick };
  }
  if (/<rss|<feed|<item[\s>]/i.test(text)) {
    return { kind: 'xml', items: (text.match(/<item[\s>]/gi) || text.match(/<entry[\s>]/gi) || []).length };
  }
  if (/<html/i.test(text)) {
    const nextData = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(text);
    return {
      kind: 'html',
      nextData: !!nextData,
      nextBytes: nextData ? nextData[1].length : 0,
      ldjson: (text.match(/application\/ld\+json/g) || []).length,
      hint: cand.html ? (text.toLowerCase().split(cand.html).length - 1) : 0,
    };
  }
  return { kind: 'unknown', items: 0 };
}

(async () => {
  const out = [];
  for (const c of CANDIDATES) {
    const mk = (s) => ({
      url: c.url(encodeURIComponent(s)),
      method: c.method,
      body: c.body ? c.body(s) : undefined,
      headers: c.headers,
    });

    const a = await hit(mk(T1).url, mk(T1));
    const row = {
      name: c.name, url: mk(T1).url, status: a.status, ct: a.ct.split(';')[0],
      bytes: a.bytes, error: a.error || null, shape: a.text ? shape(a.text, c) : null,
      sample: a.text ? a.text.slice(0, 160).replace(/\s+/g, ' ') : '',
    };

    // differential test — proves the search parameter is honoured
    if (c.q && a.status === 200 && a.bytes) {
      const b = await hit(mk(T2).url, mk(T2));
      row.differential = {
        term2Bytes: b.bytes,
        identical: b.text === a.text,
        verdict: b.text === a.text ? 'QUERY-IGNORED' : 'query-honoured',
      };
    }
    out.push(row);

    const s = row.shape || {};
    const n = s.items != null ? s.items : (s.nextData ? `next:${s.nextBytes}b` : `hint:${s.hint}`);
    console.log(
      `${c.name.padEnd(28)} ${String(row.status).padStart(3)} ${row.ct.padEnd(26)} ` +
      `${String(row.bytes).padStart(8)}b  ${(s.kind || '-').padEnd(7)} ${String(n).padStart(10)}` +
      (row.differential ? `  ${row.differential.verdict}` : '') +
      (row.error ? `  !! ${row.error}` : '')
    );
  }
  fs.writeFileSync(path.join(__dirname, 'probe-results.json'), JSON.stringify(out, null, 2));
  console.log('\nWrote probe-results.json');
})();
