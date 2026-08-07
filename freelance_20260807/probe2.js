#!/usr/bin/env node
/*
 * probe2.js — round two. Round one found 20-odd live sources and a pile of
 * near-misses. A 403 or 404 usually means the wrong path or the wrong headers,
 * not "this site has no data", so the near-misses get a second, better-informed
 * attempt here:
 *
 *   - Reddit 403s a bare fetch but serves the same content over .rss, and over
 *     old.reddit.com with a non-browser UA. r/forhire is worth the retry: its
 *     [Hiring] posts carry direct contact details, which is the whole point.
 *   - Craigslist has an open RSS gigs section per city ("cpg" = computer gigs).
 *     Reply-to addresses are anonymised but reachable, and the postings are
 *     small local contracts nobody else in this sweep covers.
 *   - freelancermap / artstation / uxjobsboard 404'd on a guessed path. Try the
 *     documented ones instead of inventing more.
 *
 * Same rule as round one: judge the body, not the status code.
 */

const fs = require('fs');
const path = require('path');

const UA_BROWSER =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
// Reddit is markedly friendlier to a self-identifying script UA than to a
// browser UA it can tell is not a browser.
const UA_BOT = 'freelance-sweep/1.0 (personal job search; contact via github.com/vritravaibhav)';

async function hit(url, opts = {}) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), opts.timeout || 25000);
  try {
    const r = await fetch(url, {
      method: opts.method || 'GET',
      headers: { 'user-agent': opts.ua || UA_BROWSER, accept: opts.accept || '*/*', ...(opts.headers || {}) },
      body: opts.body, redirect: 'follow', signal: c.signal,
    });
    const text = await r.text();
    return { status: r.status, ct: r.headers.get('content-type') || '', text, bytes: text.length };
  } catch (e) {
    return { status: 0, ct: '', text: '', bytes: 0, error: String(e.message || e) };
  } finally { clearTimeout(t); }
}

const J = (t) => { try { return JSON.parse(t); } catch { return null; } };
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

const CANDIDATES = [
  // ---- Reddit, three ways in ---------------------------------------------
  { name: 'reddit-forhire-rss', url: 'https://www.reddit.com/r/forhire/new.rss?limit=50', ua: UA_BOT },
  { name: 'reddit-forhire-json-bot', url: 'https://www.reddit.com/r/forhire/new.json?limit=50', ua: UA_BOT },
  { name: 'reddit-old-forhire', url: 'https://old.reddit.com/r/forhire/new.json?limit=50', ua: UA_BOT },
  { name: 'reddit-jobbit-rss', url: 'https://www.reddit.com/r/jobbit/new.rss?limit=50', ua: UA_BOT },
  { name: 'reddit-hiring-rss', url: 'https://www.reddit.com/r/hiring/new.rss?limit=50', ua: UA_BOT },
  { name: 'reddit-slavelabour-rss', url: 'https://www.reddit.com/r/slavelabour/new.rss?limit=50', ua: UA_BOT },
  { name: 'reddit-designjobs-rss', url: 'https://www.reddit.com/r/DesignJobs/new.rss?limit=50', ua: UA_BOT },
  { name: 'reddit-b4h-rss', url: 'https://www.reddit.com/r/BusinessForHire/new.rss?limit=50', ua: UA_BOT },

  // ---- Craigslist computer gigs — open RSS, real contact routes ----------
  { name: 'cl-sfbay-cpg', url: 'https://sfbay.craigslist.org/search/cpg?format=rss' },
  { name: 'cl-newyork-cpg', url: 'https://newyork.craigslist.org/search/cpg?format=rss' },
  { name: 'cl-london-cpg', url: 'https://london.craigslist.org/search/cpg?format=rss' },
  { name: 'cl-sfbay-web', url: 'https://sfbay.craigslist.org/search/web?format=rss' },
  { name: 'cl-sfbay-crg', url: 'https://sfbay.craigslist.org/search/crg?format=rss' },

  // ---- corrected paths for round-one 404s --------------------------------
  { name: 'freelancermap-rss-alt', url: 'https://www.freelancermap.com/project/rss' },
  { name: 'freelancermap-en', url: 'https://www.freelancermap.com/freelance-projects.html' },
  { name: 'artstation-jobs-alt', url: 'https://www.artstation.com/jobs.json' },
  { name: 'artstation-api2', url: 'https://www.artstation.com/api/v2/jobs.json?page=1' },
  { name: 'uxjobsboard-rss-alt', url: 'https://uxjobsboard.com/rss' },
  { name: 'uxjobsboard-feedxml', url: 'https://uxjobsboard.com/feed.xml' },
  { name: 'truelancer-retry', url: 'https://www.truelancer.com/freelance-jobs' },
  { name: 'web3career-real', url: 'https://web3.career/api/v1?token=test&limit=10' },

  // ---- design + 3D boards for the friends --------------------------------
  { name: 'authenticjobs-rss', url: 'https://authenticjobs.com/rss/custom.php' },
  { name: 'designerjobs-rss', url: 'https://www.designerjobsboard.com/feed' },
  { name: '99designs-api', url: 'https://99designs.com/api/contests?limit=10' },
  { name: 'cgtrader-jobs-alt', url: 'https://www.cgtrader.com/jobs' },
  { name: 'polycount-rss-alt', url: 'https://polycount.com/discussions/feed.rss' },
  { name: 'blenderartists-rss', url: 'https://blenderartists.org/c/jobs/28.rss' },
  { name: 'unity-connect', url: 'https://forum.unity.com/forums/commercial-job-offering.49/index.rss' },
  { name: 'itch-io-jobs', url: 'https://itch.io/jobs' },

  // ---- more open aggregators ---------------------------------------------
  { name: 'remotive-all', url: 'https://remotive.com/api/remote-jobs?limit=50' },
  { name: 'arbeitnow-p1', url: 'https://www.arbeitnow.com/api/job-board-api?page=1' },
  { name: 'jobspresso-rss', url: 'https://jobspresso.co/?feed=job_feed' },
  { name: 'workremotely-rss', url: 'https://weworkremotely.com/categories/remote-design-jobs.rss' },
  { name: 'dailyremote', url: 'https://dailyremote.com/api/jobs?page=1' },
  { name: 'remoteleaf', url: 'https://remoteleaf.com/api/jobs' },
  { name: 'echojobs-rss', url: 'https://echojobs.io/rss' },
  { name: 'wellfound-jobs-rss', url: 'https://wellfound.com/jobs.rss' },
  { name: 'workatastartup', url: 'https://www.workatastartup.com/companies.json' },
  { name: 'ycombinator-jobs', url: 'https://news.ycombinator.com/jobs' },
];

function shape(text) {
  const j = J(text);
  if (j) {
    const seen = [];
    const walk = (o, p, d) => {
      if (d > 3 || o == null || typeof o !== 'object') return;
      if (Array.isArray(o)) { seen.push([p || '(root)', o.length]); return; }
      for (const k of Object.keys(o)) walk(o[k], p ? `${p}.${k}` : k, d + 1);
    };
    walk(j, '', 0);
    seen.sort((a, b) => b[1] - a[1]);
    return { kind: 'json', items: seen[0] ? seen[0][1] : 0, at: seen[0] ? seen[0][0] : null };
  }
  if (/<rss|<feed|<item[\s>]|<entry[\s>]/i.test(text)) {
    const items = (text.match(/<item[\s>]/gi) || []).length;
    const entries = (text.match(/<entry[\s>]/gi) || []).length;
    return { kind: 'xml', items: items || entries };
  }
  if (/<html/i.test(text)) {
    const nd = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(text);
    return { kind: 'html', items: 0, nextBytes: nd ? nd[1].length : 0,
             ldjson: (text.match(/application\/ld\+json/g) || []).length };
  }
  return { kind: 'unknown', items: 0 };
}

(async () => {
  const out = [];
  for (const c of CANDIDATES) {
    const r = await hit(c.url, { ua: c.ua });
    const s = r.text ? shape(r.text) : { kind: '-', items: 0 };
    const emails = r.text ? [...new Set((r.text.match(EMAIL_RE) || []))].filter(
      (e) => !/\.(png|jpg|gif|svg|webp)$/i.test(e) && !/(sentry|example|wixpress|schema|w3\.org)/i.test(e)
    ) : [];
    const row = { name: c.name, url: c.url, status: r.status, ct: r.ct.split(';')[0],
                  bytes: r.bytes, shape: s, emails: emails.slice(0, 5), emailCount: emails.length,
                  error: r.error || null, sample: r.text.slice(0, 140).replace(/\s+/g, ' ') };
    out.push(row);
    console.log(
      `${c.name.padEnd(26)} ${String(r.status).padStart(3)} ${row.ct.padEnd(24)} ${String(r.bytes).padStart(8)}b  ` +
      `${s.kind.padEnd(7)} ${String(s.items).padStart(4)} items` +
      (s.at ? ` @${s.at}` : '') + (s.ldjson ? `  ld+json:${s.ldjson}` : '') +
      (s.nextBytes ? `  next:${s.nextBytes}b` : '') +
      (emails.length ? `  EMAILS:${emails.length}` : '') + (r.error ? `  !! ${r.error}` : '')
    );
    await new Promise((z) => setTimeout(z, 350)); // be polite; truelancer 429'd in round one
  }
  fs.writeFileSync(path.join(__dirname, 'probe2-results.json'), JSON.stringify(out, null, 2));
  console.log('\nWrote probe2-results.json');
})();
