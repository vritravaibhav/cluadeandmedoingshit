#!/usr/bin/env node
/* analyze.js — post-run triage of results.json.
 *
 * The point of the exercise is to be able to trust careers.txt, so this prints
 * the things that would make it untrustworthy:
 *   - companies whose board could not be read at all (and why)
 *   - companies that "read fine" but produced a suspiciously small job count
 *     via a scrape fallback, which usually means the real board was missed
 *   - the fallback sources in use, so weak ones stand out
 */
const R = require('./results.json');

const arg = process.argv[2] || 'summary';

const bySource = {};
for (const r of R) {
  const kind = String(r.source || r.error || 'none').split(':')[0];
  (bySource[kind] = bySource[kind] || []).push(r);
}

if (arg === 'summary' || arg === 'all') {
  console.log('\n=== SOURCES ===');
  Object.entries(bySource)
    .sort((a, b) => b[1].length - a[1].length)
    .forEach(([k, v]) => console.log(`  ${k.padEnd(34)} ${String(v.length).padStart(3)}   jobs=${v.reduce((n, r) => n + r.totalJobs, 0)}`));

  const read = R.filter((r) => !r.error);
  console.log('\n=== TOTALS ===');
  console.log(`  companies          : ${R.length}`);
  console.log(`  boards read        : ${read.length}`);
  console.log(`  with >0 jobs       : ${R.filter((r) => r.totalJobs > 0).length}`);
  console.log(`  read but 0 open    : ${R.filter((r) => !r.error && r.totalJobs === 0).length}`);
  console.log(`  NOT read           : ${R.filter((r) => r.error).length}`);
  console.log(`  total roles seen   : ${R.reduce((n, r) => n + r.totalJobs, 0)}`);
  console.log(`  MATCHES            : ${R.reduce((n, r) => n + r.matches.length, 0)} across ${R.filter((r) => r.matches.length).length} companies`);
  console.log(`  india roles seen   : ${R.reduce((n, r) => n + r.jobs.filter((j) => j.india).length, 0)}`);
}

if (arg === 'fail' || arg === 'all') {
  console.log('\n=== NOT READ ===');
  for (const r of R.filter((x) => x.error).sort((a, b) => (a.country === 'India' ? 0 : 1) - (b.country === 'India' ? 0 : 1)))
    console.log(`  ${(r.country === 'India' ? '[IN] ' : '     ') + r.company.padEnd(30)} ${String(r.error).padEnd(42)} ${r.careers}`);
}

if (arg === 'weak' || arg === 'all') {
  // A real ATS returns a real list. "headings"/"html"/"sitemap" with a tiny
  // count is the signature of a JS-shell page that was scraped, not read.
  console.log('\n=== WEAK / SUSPECT SOURCES (scrape fallback, low count) ===');
  for (const r of R.filter((x) => !x.error && /^(headings|html|jsonld|sitemap|feed|wp)/.test(String(x.source)) && x.totalJobs < 12))
    console.log(`  ${r.company.padEnd(30)} ${String(r.totalJobs).padStart(3)} jobs  via ${String(r.source).slice(0, 60)}`);
}

if (arg === 'match' || arg === 'all') {
  console.log('\n=== MATCHES ===');
  for (const r of R.filter((x) => x.matches.length))
    for (const m of r.matches) console.log(`  ${r.company.padEnd(24)} ${m.title.slice(0, 60).padEnd(60)} ${(m.location || '').slice(0, 28)}`);
}

if (arg === 'india' || arg === 'all') {
  const rows = [];
  for (const r of R) for (const j of r.jobs) if (j.india && j.isEng && !j.senior) rows.push({ c: r.company, ...j });
  rows.sort((a, b) => b.score - a.score);
  console.log(`\n=== INDIA, ENGINEERING, NON-SENIOR (${rows.length}) — top 40 ===`);
  rows.slice(0, 40).forEach((j) =>
    console.log(`  ${String(j.score).padStart(3)} ${j.c.padEnd(22)} ${j.title.slice(0, 54).padEnd(54)} ${(j.exp || []).map((e) => e.join('-')).join(',') || '-'}`)
  );
}
