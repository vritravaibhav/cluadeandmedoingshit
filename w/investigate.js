#!/usr/bin/env node
/*
 * investigate.js — bulk triage for companies test.js could not read.
 *
 * For each named company it reports, in one pass:
 *   - what the configured careers URL actually does (status + final URL)
 *   - every ATS fingerprint on that page AND on the homepage
 *   - career-ish links found on the homepage (the usual way to find the real
 *     board when the configured URL is a marketing page)
 *
 * Run it, read the output, fix companies.js. Beats probing one URL at a time.
 *
 *   node investigate.js Wipro "Wells Fargo" Wayfair
 *   node investigate.js --failed          # everything with an error in results.json
 */

const COMPANIES = require('./companies');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const ATS_RE = [
  ['greenhouse',      /(?:boards|job-boards)\.greenhouse\.io\/(?:embed\/job_board(?:\/js)?\?for=)?([a-zA-Z0-9_-]+)/g],
  ['greenhouse-api',  /boards-api\.greenhouse\.io\/v1\/boards\/([a-zA-Z0-9_-]+)/g],
  ['lever',           /jobs\.(?:eu\.)?lever\.co\/([a-zA-Z0-9_-]+)/g],
  ['ashby',           /jobs\.ashbyhq\.com\/([a-zA-Z0-9_.-]+)/g],
  ['smartrecruiters', /careers\.smartrecruiters\.com\/([a-zA-Z0-9_-]+)/g],
  ['workable',        /apply\.workable\.com\/([a-zA-Z0-9_-]+)/g],
  ['workday',         /([a-zA-Z0-9_-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-zA-Z-]{2,5}\/)?([a-zA-Z0-9_-]+)/g],
  ['darwinbox',       /([a-zA-Z0-9_-]+)\.darwinbox\.(?:in|com)/g],
  ['zohorecruit',     /([a-zA-Z0-9_-]+)\.zohorecruit\.(?:com|in)/g],
  ['keka',            /([a-zA-Z0-9_-]+)\.keka\.com/g],
  ['freshteam',       /([a-zA-Z0-9_-]+)\.freshteam\.com/g],
  ['recruiterbox',    /([a-zA-Z0-9_-]+)\.(?:recruiterbox\.com|hire\.trakstar\.com)/g],
  ['icims',           /(?:careers-)?([a-zA-Z0-9_-]+)\.icims\.com/g],
  ['jobvite',         /jobs\.jobvite\.com\/([a-zA-Z0-9_-]+)/g],
  ['recruitee',       /([a-zA-Z0-9_-]+)\.recruitee\.com/g],
  ['taleo',           /([a-zA-Z0-9_-]+)\.taleo\.net/g],
  ['successfactors',  /([a-zA-Z0-9_-]+)\.(?:successfactors|sapsf)\.(?:com|eu)/g],
  ['avature',         /([a-zA-Z0-9_-]+)\.avature\.net/g],
  ['phenom',          /(phenompeople|ph-cdn\.com)/g],
  ['oracle-orc',      /([a-zA-Z0-9_-]+)\.oraclecloud\.com/g],
  ['eightfold',       /([a-zA-Z0-9_-]+)\.eightfold\.ai/g],
  ['peoplestrong',    /([a-zA-Z0-9_-]+)\.peoplestrong\.com/g],
  ['mynexthire',      /([a-zA-Z0-9_-]+)\.mynexthire\.(?:com|io)/g],
  ['smartapply',      /([a-zA-Z0-9_-]+)\.hire\.trakstar\.com/g],
  ['teamtailor',      /([a-zA-Z0-9_-]+)\.teamtailor\.com/g],
  ['bamboohr',        /([a-zA-Z0-9_-]+)\.bamboohr\.com/g],
];

async function get(url) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 22000);
    const r = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' }, redirect: 'follow', signal: c.signal });
    const text = await r.text();
    clearTimeout(t);
    return { status: r.status, url: r.url, text };
  } catch (e) {
    return { status: 0, url, text: '', err: String(e.message || e) };
  }
}

function fingerprints(html) {
  const out = new Set();
  for (const [name, re] of ATS_RE) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(html))) out.add(`${name}:${m[1] || ''}${m[2] ? '/' + m[2] : ''}${m[3] ? '/' + m[3] : ''}`);
  }
  return [...out];
}

function careerLinks(html, base) {
  const out = new Set();
  for (const m of html.matchAll(/href=["']([^"']+)["']/gi)) {
    const h = m[1];
    if (!/job|career|vacan|opening|hiring|recruit|apply|work-with|join/i.test(h)) continue;
    if (/mailto:|\.(png|jpg|svg|css|js)(\?|$)/i.test(h)) continue;
    try { out.add(new URL(h, base).href.split('#')[0]); } catch {}
  }
  return [...out].slice(0, 14);
}

(async () => {
  let names = process.argv.slice(2);
  if (names[0] === '--failed') {
    const R = require('./results.json');
    names = R.filter((r) => r.error).map((r) => r.company);
  }
  const list = names.length
    ? COMPANIES.filter((c) => names.some((n) => c.name.toLowerCase().includes(n.toLowerCase()) || n.toLowerCase().includes(c.name.toLowerCase())))
    : COMPANIES;

  // Investigate concurrently but print in list order, so the output stays
  // readable and diffable across runs.
  const CONC = 6;
  let i = 0;
  const reports = new Array(list.length);
  await Promise.all(
    Array.from({ length: Math.min(CONC, list.length) }, async () => {
      while (i < list.length) {
        const idx = i++;
        const c = list[idx];
        const L = [`\n${'='.repeat(72)}\n${c.name}  [${c.country}]  ${c.site}`];
        const cr = await get(c.careers || `https://${c.site}`);
        L.push(`  careers: ${cr.status} ${cr.err || ''} -> ${cr.url}`);
        const fp = fingerprints(cr.text);
        if (fp.length) L.push(`  ATS on careers page: ${fp.join('  ')}`);

        const home = await get(`https://${c.site}`);
        const hfp = fingerprints(home.text).filter((f) => !fp.includes(f));
        if (home.status !== 200) L.push(`  homepage: ${home.status} ${home.err || ''}`);
        if (hfp.length) L.push(`  ATS on homepage    : ${hfp.join('  ')}`);

        if (!fp.length && !hfp.length) {
          const links = careerLinks(home.text || cr.text, home.url || cr.url);
          L.push(`  career links: ${links.length ? '\n      ' + links.join('\n      ') : '(none)'}`);
        }
        reports[idx] = L.join('\n');
      }
    })
  );
  console.log(reports.join('\n'));
})();
