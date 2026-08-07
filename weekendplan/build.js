#!/usr/bin/env node
/*
 * build.js — merge every letter folder's scan into the four weekend buckets.
 *
 * Reads  : ../<letter>/results.json  (or careerv1.results.json), a-z
 * Writes : weekendplan/<n>-<bucket>/jobs.txt   human-readable, grouped by company
 *          weekendplan/<n>-<bucket>/jobs.json  same data, machine-readable
 *          weekendplan/INDEX.txt               coverage + counts, letter by letter
 *
 * Buckets (India-only, engineering titles only, seniors filtered out):
 *   1  Java/Flutter  ~2 yrs   <- the priority list
 *   2  Java/Flutter  ~3 yrs
 *   3  Other software ~2 yrs  (excludes anything already in 1)
 *   4  Other software ~3 yrs  (excludes anything already in 2)
 *
 * A role asking "2-4 years" legitimately lands in both the 2yr and the 3yr
 * bucket — that is not double counting, it is the same opening being a valid
 * target under either framing. Duplicates are removed *within* a bucket by URL.
 */

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const ROOT = path.dirname(DIR);
const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');

const BUCKETS = [
  { n: 1, dir: '1-java-flutter-2yr', title: 'JAVA / FLUTTER — ~2 YEARS — INDIA', priority: true, years: 2 },
  { n: 2, dir: '2-java-flutter-3yr', title: 'JAVA / FLUTTER — ~3 YEARS — INDIA', priority: true, years: 3 },
  { n: 3, dir: '3-software-2yr', title: 'SOFTWARE DEVELOPER (other stacks) — ~2 YEARS — INDIA', priority: false, years: 2 },
  { n: 4, dir: '4-software-3yr', title: 'SOFTWARE DEVELOPER (other stacks) — ~3 YEARS — INDIA', priority: false, years: 3 },
];

/* ------------------------------------------------------------------ *
 * Load every letter's scan
 * ------------------------------------------------------------------ */

function loadLetter(letter) {
  const base = path.join(ROOT, letter);
  if (!fs.existsSync(base)) return null;
  // Prefer the newest results file the folder has.
  const candidates = ['careerv1.results.json', 'results.json']
    .map((f) => path.join(base, f))
    .filter((p) => fs.existsSync(p))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!candidates.length) return null;
  try {
    return { letter, file: candidates[0], data: JSON.parse(fs.readFileSync(candidates[0], 'utf8')) };
  } catch (e) {
    console.error(`  !! ${letter}: unreadable results (${e.message})`);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Experience windows
 * ------------------------------------------------------------------ */

/** Does any stated window [a,b] contain `y` years? */
const covers = (exp, y) => Array.isArray(exp) && exp.some(([a, b]) => a <= y && b >= y);

/* Some scans stored exp as [[a,b],...]; guard against odd shapes. */
function normExp(exp) {
  if (!Array.isArray(exp)) return [];
  return exp
    .filter((w) => Array.isArray(w) && w.length === 2 && Number.isFinite(+w[0]) && Number.isFinite(+w[1]))
    .map((w) => [+w[0], +w[1]]);
}

const fmtExp = (exp) => (exp.length ? exp.map(([a, b]) => `${a}-${b}y`).join(', ') : 'not stated');

/*
 * A posting often yields several windows: a real alternative requirement
 * ("2-6 years ML"), or boilerplate bleeding in from elsewhere on the page.
 * If a window covers the target year we keep the role — dropping it would
 * lose a real opening — but when some *other* window demands materially more
 * (e.g. 5-9y against a 2y target) the fit is ambiguous, so we mark it and
 * sink it below the clean matches instead of presenting it as a solid hit.
 */
function ambiguousFor(exp, y) {
  if (!exp.length) return false;
  return Math.max(...exp.map(([a]) => a)) > y + 2;
}

/* ------------------------------------------------------------------ *
 * Bucketing
 * ------------------------------------------------------------------ */

function collect(letters) {
  const rows = [];
  for (const L of letters) {
    for (const co of L.data) {
      for (const j of co.jobs || []) {
        const exp = normExp(j.exp);
        rows.push({
          letter: L.letter,
          company: co.company,
          country: co.country,
          board: co.source || '',
          title: j.title,
          location: j.location || '',
          url: j.url,
          india: !!j.india,
          isEng: !!j.isEng,
          senior: !!j.senior,
          java: !!j.java,
          flutter: !!j.flutter,
          score: +j.score || 0,
          exp,
          fits2: covers(exp, 2),
          fits3: covers(exp, 3),
          unstated: exp.length === 0,
        });
      }
    }
  }
  return rows;
}

function bucketOf(rows, b) {
  const stack = (r) => (b.priority ? r.java || r.flutter : !(r.java || r.flutter));
  // 2yr accepts an unstated window (a non-senior role that names no window is a
  // natural target at 2 years). 3yr demands the posting actually say ~3.
  const fitsYears = (r) => (b.years === 2 ? r.fits2 || r.unstated : r.fits3);

  const byUrl = new Set();
  const byRole = new Set();
  return rows
    .filter((r) => r.india && r.isEng && !r.senior && r.url && stack(r) && fitsYears(r))
    .filter((r) => {
      // Same posting reachable at two URLs.
      const u = r.url.split('#')[0].replace(/\/$/, '');
      if (byUrl.has(u)) return false;
      byUrl.add(u);
      // Same role re-posted under different job IDs (very common on Greenhouse).
      const k = `${r.company}|${r.title}|${r.location}`.toLowerCase().replace(/\s+/g, ' ');
      if (byRole.has(k)) return false;
      byRole.add(k);
      return true;
    })
    .map((r) => ({ ...r, ambiguous: ambiguousFor(r.exp, b.years) }))
    .sort((x, y) => {
      // Clean explicit match, then ambiguous match, then no window stated.
      const tier = (r) => (r.unstated ? 0 : r.ambiguous ? 1 : 2);
      return tier(y) - tier(x) || y.score - x.score;
    });
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function render(b, jobs, meta) {
  const byCompany = new Map();
  for (const j of jobs) {
    if (!byCompany.has(j.company)) byCompany.set(j.company, []);
    byCompany.get(j.company).push(j);
  }
  // Company order = its best role.
  const companies = [...byCompany.entries()].sort(
    (x, y) => Math.max(...y[1].map((j) => j.score)) - Math.max(...x[1].map((j) => j.score)),
  );

  const L = [];
  const bar = '='.repeat(78);
  L.push(bar);
  L.push(`FOLDER ${b.n} — ${b.title}`);
  L.push(`${jobs.length} role(s) across ${companies.length} company(s)`);
  L.push(`Generated ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`);
  L.push(bar);
  L.push('');
  if (b.n === 1) {
    L.push('This is the priority list: the posting mentions Java or Flutter/Dart, the');
    L.push('title is an engineering title, it is not a senior/lead role, the location is');
    L.push('in India, and the stated experience window covers ~2 years (or the posting');
    L.push('states no window at all, which is flagged below). Work top to bottom.');
  } else if (b.n === 2) {
    L.push('Same filter as folder 1, but the posting explicitly asks for ~3 years.');
    L.push('Worth applying to anyway at 2.4 years — 3y asks are routinely flexible.');
  } else if (b.n === 3) {
    L.push('Engineering roles in India at ~2 years that do NOT mention Java or');
    L.push('Flutter/Dart — other stacks (Python, Node, React, .NET, Go, QA, data...).');
    L.push('Anything Java/Flutter lives in folder 1, not here.');
  } else {
    L.push('Engineering roles in India where the posting explicitly asks ~3 years and');
    L.push('does NOT mention Java or Flutter/Dart. Anything Java/Flutter is in folder 2.');
  }
  L.push('');
  L.push(`Coverage: letters ${meta.letters.join(' ')} | ${meta.companies} companies scanned`);
  L.push('');

  let n = 0;
  for (const [company, list] of companies) {
    list.sort((a, b3) => b3.score - a.score);
    L.push('-'.repeat(78));
    L.push(`>> ${company}  [${list[0].country || '?'}]   via ${list[0].board || 'n/a'}`);
    for (const j of list) {
      n++;
      L.push(`   ${String(n).padStart(4)}. ${j.title}`);
      if (j.location) L.push(`         location : ${j.location}`);
      const expNote = j.unstated
        ? '   << no window stated'
        : j.ambiguous
          ? `   << mixed windows — also asks ${Math.max(...j.exp.map((w) => w[0]))}y+, read before applying`
          : '';
      L.push(`         exp asked: ${fmtExp(j.exp)}${expNote}`);
      const tags = [j.java && 'Java', j.flutter && 'Flutter/Dart'].filter(Boolean);
      if (tags.length) L.push(`         stack    : ${tags.join(' + ')}`);
      L.push(`         apply    : ${j.url}`);
    }
    L.push('');
  }
  if (!jobs.length) L.push('(no roles matched this bucket in the current scan)');
  return L.join('\n') + '\n';
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

function main() {
  const letters = LETTERS.map(loadLetter).filter(Boolean);
  if (!letters.length) {
    console.error('No letter results found. Run the per-letter scans first.');
    process.exit(1);
  }

  const companiesScanned = letters.reduce((n, L) => n + L.data.length, 0);
  const rows = collect(letters);
  const meta = { letters: letters.map((L) => L.letter), companies: companiesScanned };

  console.log(`Loaded ${letters.length} letter(s): ${meta.letters.join(' ')}`);
  console.log(`  companies scanned : ${companiesScanned}`);
  console.log(`  raw postings      : ${rows.length}`);
  console.log(`  India + eng + non-senior : ${rows.filter((r) => r.india && r.isEng && !r.senior).length}`);
  console.log('');

  const idx = [];
  idx.push('='.repeat(78));
  idx.push('WEEKEND PLAN — INDIA SOFTWARE ROLES, ~2 YEARS EXPERIENCE');
  idx.push(`Generated ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`);
  idx.push('='.repeat(78));
  idx.push('');
  idx.push(`Letters scanned : ${meta.letters.join(' ')}  (${letters.length}/26)`);
  const missing = LETTERS.filter((l) => !meta.letters.includes(l));
  idx.push(`Letters missing : ${missing.length ? missing.join(' ') : 'none'}`);
  idx.push(`Companies       : ${companiesScanned}`);
  idx.push(`Raw postings    : ${rows.length}`);
  idx.push('');

  for (const b of BUCKETS) {
    const jobs = bucketOf(rows, b);
    const out = path.join(DIR, b.dir);
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'jobs.txt'), render(b, jobs, meta));
    fs.writeFileSync(path.join(out, 'jobs.json'), JSON.stringify(jobs, null, 1));
    const companies = new Set(jobs.map((j) => j.company)).size;
    console.log(`  ${b.dir.padEnd(22)} ${String(jobs.length).padStart(5)} roles  ${String(companies).padStart(4)} companies`);
    idx.push(`FOLDER ${b.n} — ${b.title}`);
    idx.push(`   ${jobs.length} role(s), ${companies} company(s)   ->  ${b.dir}/jobs.txt`);
    idx.push('');
  }

  // Per-letter contribution, so a letter that silently produced nothing is visible.
  idx.push('-'.repeat(78));
  idx.push('PER-LETTER COVERAGE');
  idx.push('-'.repeat(78));
  for (const L of letters) {
    const co = L.data.length;
    const read = L.data.filter((c) => (c.jobs || []).length).length;
    const jobs = L.data.reduce((n, c) => n + (c.jobs || []).length, 0);
    const ind = rows.filter((r) => r.letter === L.letter && r.india && r.isEng && !r.senior).length;
    idx.push(
      `  ${L.letter}  companies ${String(co).padStart(4)}   boards-read ${String(read).padStart(4)}` +
      `   postings ${String(jobs).padStart(6)}   india-eng ${String(ind).padStart(5)}`,
    );
  }
  idx.push('');
  fs.writeFileSync(path.join(DIR, 'INDEX.txt'), idx.join('\n') + '\n');
  console.log(`\nWrote weekendplan/INDEX.txt`);
}

main();
