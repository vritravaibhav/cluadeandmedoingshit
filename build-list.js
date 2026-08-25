#!/usr/bin/env node
/*
 * build-list.js — rebuild apply-list.txt WITHOUT losing what you have applied to.
 *
 * The problem this solves
 * ----------------------
 * The first apply-list.txt was regenerated in place, and because the only
 * record of "I applied to these" was "everything printed in that file", the
 * rewrite destroyed it — 466 applications became indistinguishable from the
 * 1,471 that had never been seen. The old file was recoverable from git that
 * time. It will not always be.
 *
 * So applied-state now lives in its own file, applied.json, keyed by URL and
 * never rewritten by a rebuild. This script only ever ADDS to the list; it
 * moves nothing out of your history.
 *
 *   node build-list.js                       # rebuild, keeping applied.json
 *   node build-list.js --applied=<url>       # mark one as applied
 *   node build-list.js --applied-from=f.txt  # mark every URL in a file
 *   node build-list.js --stats               # how many left
 */

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const APPLIED = path.join(DIR, 'applied.json');
const SOURCE = path.join(DIR, 'apply-list.json');
const OUT = path.join(DIR, 'apply-list.txt');

const ARGS = process.argv.slice(2);
const argVal = (k) => {
  const a = ARGS.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : null;
};

/* Strip the query string so the same posting is recognised however it was
 * linked (utm tags, ?domain=, /apply suffixes vary between boards). */
const clean = (u) => String(u || '').split('#')[0].replace(/\?.*$/, '');

const readJson = (f, d) => {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; }
};

let applied = readJson(APPLIED, {});

/* ---- marking things applied ------------------------------------------- */
const one = argVal('applied');
const from = argVal('applied-from');
let marked = 0;

function mark(url) {
  const k = clean(url);
  if (!k || applied[k]) return;
  applied[k] = { url: url, appliedOn: new Date().toISOString().slice(0, 10) };
  marked++;
}

if (one) mark(one);
if (from) {
  const text = fs.readFileSync(from, 'utf8');
  (text.match(/https?:\/\/[^\s)]+/g) || []).forEach(mark);
}
if (marked) {
  fs.writeFileSync(APPLIED, JSON.stringify(applied, null, 1));
  console.log(`marked ${marked} newly applied — ${Object.keys(applied).length} total`);
}

/* ---- rebuild ----------------------------------------------------------- */
const src = readJson(SOURCE, null);
if (!src) {
  console.error('apply-list.json is missing — nothing to build from.');
  process.exit(1);
}

const TIERS = [
  ['TIER 1 - Java / Flutter on a real ATS', src.tier1 || [], 'Best fit, and every link is a live posting.'],
  ['TIER 2 - engineering, states a ~2-year window', src.tier2 || [], 'Same bar as Tier 1, just no Java/Flutter keyword in the listing.'],
  ['TIER 3 - engineering, experience not stated', src.tier3 || [], 'An unstated window often means they are flexible.'],
  ['UNVERIFIED - scraped from page headings', src.weak || [], 'Title or link may not be a real posting. Lowest priority.'],
];

const isApplied = (j) => Boolean(applied[clean(j.url)]);

if (ARGS.includes('--stats')) {
  let todo = 0, done = 0;
  TIERS.forEach(([name, rows]) => {
    const d = rows.filter(isApplied).length;
    todo += rows.length - d; done += d;
    console.log(`  ${name.padEnd(48)} ${String(rows.length - d).padStart(5)} left of ${rows.length}`);
  });
  console.log(`\n  applied ${done} - remaining ${todo}`);
  process.exit(0);
}

const L = [];
const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
const total = TIERS.reduce((n, t) => n + t[1].length, 0);
const doneCount = TIERS.reduce((n, t) => n + t[1].filter(isApplied).length, 0);

L.push('='.repeat(78));
L.push('APPLY LIST - DIRECT COMPANY BOARDS ONLY');
L.push('Divyanshu Vaibhav  |  Software Engineer, ~2 yrs  |  Java/Spring + Flutter/Firebase');
L.push(`Rebuilt ${now} UTC`);
L.push('='.repeat(78));
L.push('');
L.push(`  ${total - doneCount} still to apply to     ${doneCount} already applied`);
L.push('');
L.push('Applications you have already sent are NOT listed below — they live in');
L.push('applied.json and are filtered out, so this file is always just the work');
L.push('that is left. Rebuilding it can never lose that history again.');
L.push('');
L.push('  node build-list.js --applied=<url>        mark one as applied');
L.push('  node build-list.js --applied-from=f.txt   mark every URL in a file');
L.push('  node build-list.js --stats                how many left');
L.push('');
L.push('No aggregators: every link is a company\'s own ATS. LinkedIn / Naukri /');
L.push('Indeed / Instahyre are deliberately excluded.');
L.push('');

for (const [name, rows, note] of TIERS) {
  const open = rows.filter((j) => !isApplied(j));
  const sent = rows.length - open.length;
  L.push('');
  L.push('#'.repeat(78));
  L.push(`# ${name}  (${open.length} left${sent ? ` — ${sent} already applied, hidden` : ''})`);
  if (note) L.push(`# ${note}`);
  L.push('#'.repeat(78));
  L.push('');
  if (!open.length) {
    L.push('    All done in this tier.');
    L.push('');
    continue;
  }
  open.forEach((j, i) => {
    const tech = [j.java && 'Java', j.flutter && 'Flutter'].filter(Boolean).join(' + ') || '-';
    const exp = (j.exp && j.exp.length) ? j.exp.map((e) => e.join('-') + 'y').join(' / ') : 'not stated';
    L.push(`${String(i + 1).padStart(4)}. ${j.title}`);
    L.push(`      ${j.co}   [${j.ctry}]${j.indexPage ? '   (careers index page - find the role on it)' : ''}`);
    L.push(`      stack: ${tech}    exp: ${exp}    where: ${j.location || 'India'}`);
    L.push(`      ${j.url}`);
    L.push('');
  });
}

fs.writeFileSync(OUT, L.join('\n'));
console.log(`apply-list.txt rebuilt — ${total - doneCount} open, ${doneCount} applied and hidden`);
