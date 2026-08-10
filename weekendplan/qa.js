#!/usr/bin/env node
/*
 * qa.js — the hand-audit, as a check that runs every time.
 *
 * Reading the output files by hand has found a real defect in every cycle it
 * was done, and none of them were visible in any count: blog posts ranked #2 in
 * the priority folder, a Stripe internship at #15, 60 "Hire a Developer"
 * adverts, a quarter of the freelance bid list unworkable from India, cover
 * letters with an empty evidence list. Each was fixed — but nothing stops the
 * next extractor reintroducing one, and a count of "286 roles" looks identical
 * either way.
 *
 * So every known failure mode gets an assertion here. This does not replace
 * reading the files (a NEW failure mode still needs eyes), but it means no OLD
 * one can come back unnoticed.
 *
 *   node weekendplan/qa.js          # exits non-zero if anything regressed
 */

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const ROOT = path.dirname(DIR);

const JOB_FOLDERS = ['1-java-flutter-2yr', '2-java-flutter-3yr', '3-software-2yr', '4-software-3yr'];
const GIG_FOLDERS = ['1-bid-now', '2-worth-a-look', '3-contract-roles'];

/* Every pattern here is a bug that actually shipped. */
const BLOG = /^(top|how|why|what|which)\b|\b(a comprehensive guide|complete guide|cost to hire|cost of hiring)\b|\?\s*$/i;
const SERVICE = /^(hire|outsource|offshore)\b/i;
const INTERN = /\b(intern|internship|trainee|apprentice)\b/i;
const SENIOR = /\b(senior|staff|principal|head of|director|vp)\b/i;

const problems = [];
const note = (folder, what, n, sample) =>
  problems.push(`${folder.padEnd(20)} ${String(n).padStart(4)}  ${what}${sample ? `   e.g. "${sample}"` : ''}`);

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/* ---------------------------------------------------------------- jobs */
let jobTotal = 0;
for (const f of JOB_FOLDERS) {
  const rows = readJson(path.join(DIR, f, 'jobs.json'));
  if (!rows) { note(f, 'jobs.json missing or unreadable', 0); continue; }
  jobTotal += rows.length;

  const check = (re, label) => {
    const hits = rows.filter((r) => re.test(r.title || ''));
    if (hits.length) note(f, label, hits.length, hits[0].title);
  };
  check(BLOG, 'blog/marketing headlines');
  check(SERVICE, 'service pages ("Hire a X Developer")');
  check(INTERN, 'internships / trainee roles');
  check(SENIOR, 'senior-level titles');

  const noUrl = rows.filter((r) => !r.url);
  if (noUrl.length) note(f, 'entries with no apply URL', noUrl.length);

  const notIndia = rows.filter((r) => r.india === false);
  if (notIndia.length) note(f, 'entries not marked India', notIndia.length, notIndia[0].title);

  /*
   * Same role listed twice in one folder.
   *
   * The city must be normalised the way build.js does it. A first version used
   * location.split(',')[0], but boards write "India, Bengaluru" and
   * "India, Chennai" — both reduce to "India", so two genuinely different
   * postings in different cities were reported as duplicates. The check was
   * wrong, not the data.
   */
  const city = (v) =>
    String(v || '').toLowerCase().replace(/\b(india|in|remote|hybrid|onsite|on-site)\b/g, ' ')
      .replace(/[^a-z]+/g, ' ').trim().split(' ')[0] || '';
  const seen = new Set();
  let dupes = 0;
  for (const r of rows) {
    const k = `${r.company}|${r.title}|${city(r.location)}`.toLowerCase();
    if (seen.has(k)) dupes++;
    seen.add(k);
  }
  if (dupes) note(f, 'duplicate company+title+city rows', dupes);

  // Folders 1/2 are the Java/Flutter list; 3/4 must be everything else.
  const wrongStack = rows.filter((r) =>
    f.includes('java-flutter') ? !(r.java || r.flutter) : r.java || r.flutter,
  );
  if (wrongStack.length) note(f, 'rows on the wrong side of the stack split', wrongStack.length, wrongStack[0].title);
}

/* ------------------------------------------------------------ freelance */
const FREEL = path.join(ROOT, 'weekendplan_freelance');
let gigTotal = 0;
if (fs.existsSync(FREEL)) {
  for (const f of GIG_FOLDERS) {
    const rows = readJson(path.join(FREEL, f, 'gigs.json'));
    if (!rows) continue;
    gigTotal += rows.length;
    const hire = rows.filter((r) => SERVICE.test(r.title || ''));
    if (hire.length) note(`freelance/${f}`, 'service pages', hire.length, hire[0].title);
    const trainee = rows.filter((r) => INTERN.test(r.title || ''));
    if (trainee.length) note(`freelance/${f}`, 'trainee gigs', trainee.length, trainee[0].title);
    if (f === '1-bid-now') {
      const geo = rows.filter((r) => r.indiaOk === false);
      if (geo.length) note(`freelance/${f}`, 'gigs not workable from India', geo.length, geo[0].title);
      const sources = new Set(rows.map((r) => r.source));
      // The whole point of adding 8 marketplaces was to stop spending scarce
      // Freelancer bids; a single-platform shortlist means that regressed.
      if (sources.size < 3) note(`freelance/${f}`, `shortlist spans only ${sources.size} platform(s)`, rows.length);
    }
  }
}

/* ---------------------------------------------------------------- packs */
for (const f of JOB_FOLDERS.slice(0, 2)) {
  const p = path.join(DIR, f, 'apply-pack.txt');
  if (!fs.existsSync(p)) continue;
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  let empty = 0;
  lines.forEach((l, i) => {
    if (/Most relevant to this role:|What I bring:/.test(l) && !/•/.test(lines[i + 1] || '')) empty++;
  });
  if (empty) note(`pack/${f}`, 'cover notes with an empty evidence list', empty);
  const placeholders = lines.filter((l) => /UNAVAILABLE|undefined|\[object Object\]/.test(l)).length;
  if (placeholders) note(`pack/${f}`, 'placeholder junk in the text', placeholders);
}

/* --------------------------------------------------------------- report */
console.log(`QA — ${jobTotal} job rows, ${gigTotal} gig rows\n`);
if (!problems.length) {
  console.log('  all checks pass');
  process.exit(0);
}
console.log('  REGRESSIONS:');
problems.forEach((p) => console.log('   ' + p));
process.exit(1);
