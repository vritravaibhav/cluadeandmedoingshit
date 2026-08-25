#!/usr/bin/env node
/*
 * merge-incoming.js — fold staged company lists into data/<letter>/companies.js
 *
 * Research agents write `Name|domain.com` lines into data/_incoming/*.txt rather
 * than editing companies.js directly. Twelve agents editing 26 shared files
 * concurrently would race and lose writes; staging plus one serial merge cannot.
 *
 * The merge is deliberately strict. Everything it rejects is something that has
 * already caused damage in this project at least once:
 *   - an `ats` field       -> a guessed token silently scrapes another company's
 *                             board (90 of these had to be stripped once)
 *   - a duplicate domain   -> wastes a scan slot and can double-count a role
 *   - an aggregator domain -> pulls a job board in as if it were an employer
 *   - a malformed line     -> becomes a company with no usable domain
 *
 *   node weekendplan/merge-incoming.js          # dry run, prints what would change
 *   node weekendplan/merge-incoming.js --apply
 */

const fs = require('fs');
const path = require('path');
const P = require('../engine/paths');

const APPLY = process.argv.includes('--apply');
const STAGE = path.join(P.DATA, '_incoming');

const AGGREGATOR =
  /(naukri|indeed|instahyre|cutshort|hirist|foundit|monster|shine|timesjobs|linkedin|glassdoor|wellfound|angel\.co|ziprecruiter|simplyhired|internshala|freshersworld|jobsdb|clutch\.co|goodfirms|sortlist|designrush)\./i;

const norm = (d) =>
  String(d || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .replace(/[^a-z0-9.-]/g, '');

/* ---------------------------------------------------------- existing state */
const existing = new Map(); // domain -> "letter/Name"
const byLetter = new Map(); // letter -> array
for (const L of P.LETTERS) {
  const f = path.join(P.letterDir(L), 'companies.js');
  if (!fs.existsSync(f)) continue;
  const arr = require(f);
  byLetter.set(L, arr);
  for (const c of arr) {
    const d = norm(c.site);
    if (d) existing.set(d, `${L}/${c.name}`);
  }
}
console.log(`existing: ${existing.size} companies across ${byLetter.size} letters`);

/* ------------------------------------------------------------- staged rows */
if (!fs.existsSync(STAGE)) {
  console.error(`No staging directory at ${STAGE} — nothing to merge.`);
  process.exit(0);
}
const files = fs.readdirSync(STAGE).filter((f) => f.endsWith('.txt'));
if (!files.length) {
  console.error('No staged .txt files — nothing to merge.');
  process.exit(0);
}

const stats = { lines: 0, malformed: 0, aggregator: 0, dupeExisting: 0, dupeIncoming: 0, noLetter: 0, added: 0 };
const seenIncoming = new Set();
const additions = new Map(); // letter -> [{name,country,site}]

for (const file of files.sort()) {
  const src = fs.readFileSync(path.join(STAGE, file), 'utf8');
  let fileAdded = 0;
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    stats.lines++;

    const parts = line.split('|');
    if (parts.length !== 2) { stats.malformed++; continue; }
    const name = parts[0].trim();
    const site = norm(parts[1]);
    if (!name || !site || !site.includes('.') || site.length < 4) { stats.malformed++; continue; }
    if (AGGREGATOR.test(site + '.')) { stats.aggregator++; continue; }

    if (existing.has(site)) { stats.dupeExisting++; continue; }
    if (seenIncoming.has(site)) { stats.dupeIncoming++; continue; }

    // File under the company's first letter, matching the a-z layout.
    const L = name.replace(/^the\s+/i, '').trim()[0];
    if (!L || !/[a-zA-Z]/.test(L)) { stats.noLetter++; continue; }
    const letter = L.toLowerCase();

    seenIncoming.add(site);
    if (!additions.has(letter)) additions.set(letter, []);
    // No `ats`, no `careers` — the scanner discovers both, and a guess poisons.
    additions.get(letter).push({ name, country: 'India', site });
    stats.added++;
    fileAdded++;
  }
  console.log(`  ${file.padEnd(18)} +${fileAdded}`);
}

console.log('');
console.log(`  lines read            : ${stats.lines}`);
console.log(`  malformed             : ${stats.malformed}`);
console.log(`  aggregators rejected  : ${stats.aggregator}`);
console.log(`  already in the list   : ${stats.dupeExisting}`);
console.log(`  duplicate in staging  : ${stats.dupeIncoming}`);
console.log(`  unusable first letter : ${stats.noLetter}`);
console.log(`  NEW companies         : ${stats.added}`);

if (!APPLY) {
  console.log('\n  dry run — re-run with --apply');
  process.exit(0);
}

let touched = 0;
for (const [letter, rows] of [...additions.entries()].sort()) {
  const dir = P.letterDir(letter);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'companies.js');
  const current = byLetter.get(letter) || [];
  const merged = [...current, ...rows];
  fs.writeFileSync(f, 'module.exports=' + JSON.stringify(merged, null, 1) + ';\n');
  touched++;
  console.log(`  ${letter}: ${current.length} -> ${merged.length}`);
}
console.log(`\nUpdated ${touched} letter(s). Staged files left in place; delete data/_incoming when satisfied.`);
