#!/usr/bin/env node
/*
 * test.js — find freelance / contract work for a given tech stack.
 *
 * Stacks wanted : Flutter/Dart, Spring Boot/Java, Firebase/Firestore first,
 *                 then every other stack the sources carry.
 * Preference    : India (or India-friendly remote), ~2 years experience.
 * Output        : freelance.txt   (report)
 *                 results.json    (raw diagnostics — proof of what was fetched)
 *
 * How it works
 * ------------
 * Freelance work does not live on company career pages, so this is the mirror
 * image of ../w/test.js: instead of one board per company, there are a handful
 * of marketplaces and remote boards, each read in full and then filtered.
 *
 *   1. every source in sources.js is fetched (some once, some once per stack
 *      term where their API supports search),
 *   2. postings are de-duplicated across sources by URL and by title+company,
 *   3. each posting is classified by stack, contract type, India-friendliness
 *      and experience level,
 *   4. everything is written out grouped by stack.
 *
 * A source that returns nothing is reported as such rather than silently
 * dropped — the same "prove you actually read it" rule as the company sweep.
 *
 * Usage:
 *   node test.js                      # all stacks, all sources
 *   node test.js --stack=flutter      # one stack
 *   node test.js --only=freelancer    # one source
 *   node test.js --out=freelancev1    # write elsewhere
 *   node test.js --report-only        # rebuild the report from results.json
 */

const fs = require('fs');
const path = require('path');
const SOURCES = require('./sources');

const ARGS = process.argv.slice(2);
const argVal = (k, d) => {
  const a = ARGS.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const ONLY = argVal('only', null);
const STACK = argVal('stack', null);
const OUT = argVal('out', null);
const VERBOSE = ARGS.includes('--verbose');

/* --------------------------------------------------------------- stacks */
/* `terms` are what gets sent to searching APIs; `re` is what classifies a
 * posting once fetched. priority mirrors the brief: Flutter and Spring Boot
 * first, Firebase/Firestore alongside them, everything else still reported. */
const STACKS = [
  {
    key: 'flutter',
    label: 'Flutter / Dart',
    priority: 1,
    terms: ['flutter', 'dart'],
    re: /\b(flutter|dart\b)/i,
  },
  {
    key: 'springboot',
    label: 'Spring Boot / Java',
    priority: 1,
    terms: ['spring boot', 'java spring', 'java backend'],
    re: /\b(spring\s?boot|spring\s?mvc|spring\s?framework|hibernate|\bjava\b(?!\s*script))/i,
  },
  {
    key: 'firebase',
    label: 'Firebase / Firestore',
    priority: 1,
    terms: ['firebase', 'firestore'],
    re: /\b(firebase|firestore|cloud\s?functions|fcm\b)/i,
  },
  {
    key: 'mobile',
    label: 'Other mobile (Android / Kotlin / React Native / iOS)',
    priority: 2,
    terms: ['android', 'react native', 'kotlin'],
    re: /\b(android|kotlin|react\s?native|swift|ios\b|jetpack\s?compose)/i,
  },
  {
    key: 'backend',
    label: 'Other backend (Node / Python / Go / .NET)',
    priority: 3,
    terms: ['node.js backend', 'python backend'],
    // "go" as a bare word matches ordinary prose ("go live", "go-to-market")
    // and tagged 104 of 386 backend hits on its own. Require golang, or Go
    // sitting next to something that makes it the language.
    re: /\b(node\.?js|express|nest\.?js|django|flask|fastapi|golang|go\s+(?:developer|engineer|backend|programming|routines?)|(?:in|using|with|and)\s+go\b|\.net|laravel|rails)/i,
  },
  {
    key: 'web',
    label: 'Web / full-stack (React / Vue / Angular)',
    priority: 3,
    terms: ['react developer', 'full stack developer'],
    re: /\b(react\b|next\.?js|vue|angular|svelte|full[\s-]?stack|frontend|front[\s-]?end)/i,
  },
];

const RE_INDIA =
  /\b(india|indian|bangalore|bengaluru|hyderabad|pune|mumbai|chennai|delhi|gurgaon|gurugram|noida|kolkata|ahmedabad|jaipur|indore|kochi|coimbatore|trivandrum|chandigarh|vadodara|nagpur|mysore|mysuru|\bIST\b)\b/i;
// A remote posting that does not fence itself to another region is workable
// from India, so treat "worldwide/anywhere" as India-friendly.
const RE_ANYWHERE = /\b(worldwide|anywhere|global|any location|remote)\b/i;
const RE_REGION_LOCKED =
  /\b(only|must be|based in|authorized to work|eligible to work)\b[^.]{0,60}\b(us|usa|united states|uk|canada|emea|europe|eu\b|latam|apac|australia|germany|poland)\b/i;

const RE_FREELANCE = /\b(freelance|freelancer|contract|contractor|part[\s-]?time|hourly|project[\s-]?based|gig|consultant|c2c|corp[\s-]?to[\s-]?corp)\b/i;
const RE_SENIOR = /\b(senior|sr\.?|staff|principal|lead|architect|head|director|vp|chief|10\+|expert)\b/i;
const RE_JUNIOR = /\b(junior|jr\.?|entry|graduate|trainee|fresher|intern)\b/i;

function expWindows(text) {
  const out = [];
  const t = String(text).replace(/[–—]/g, '-');
  for (const m of t.matchAll(/(\d{1,2})\s*(?:-|to)\s*(\d{1,2})\s*\+?\s*(?:years?|yrs?)/gi)) out.push([+m[1], +m[2]]);
  for (const m of t.matchAll(/(\d{1,2})\s*\+\s*(?:years?|yrs?)/gi)) out.push([+m[1], +m[1] + 4]);
  for (const m of t.matchAll(/(?:minimum|min\.?|at\s?least|atleast)\s*(?:of\s*)?(\d{1,2})\s*(?:years?|yrs?)/gi)) out.push([+m[1], +m[1] + 4]);
  for (const m of t.matchAll(/(\d{1,2})\s*(?:years?|yrs?)\s*(?:of\s+)?(?:relevant\s+|hands[\s-]on\s+|professional\s+)?(?:experience|exp\b)/gi)) out.push([+m[1], +m[1] + 1]);
  const seen = new Set();
  return out.filter(([a, b]) => {
    if (!(a >= 0 && b >= a && b <= 30)) return false;
    const k = `${a}:${b}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/* Where a technology is named decides whether it is the stack or just scenery.
 * In the title or the skill tags it IS the stack. Buried in the description it
 * might be a device requirement — "Access to a smartphone (Android 5.0 or
 * higher, or iOS 14)" tagged a content-reviewing gig as Android development. So
 * a description-only mention has to look like engineering: either the tech is
 * repeated, or a build-ish word sits near it. */
const RE_DEV_CONTEXT = /\b(develop|developer|engineer|engineering|build|building|code|coding|programm|implement|integrat|architect|sdk|api|app\b|application|backend|frontend|framework|stack|deploy|migrat)/i;

/* Phrasing that means "you must own this device", not "you must build for it".
 * "Access to a smartphone (Android 5.0 or higher, or iOS 14 or higher)" should
 * never make a content-reviewing gig an Android job. */
const RE_DEVICE_REQ = /\b(smartphone|mobile device|own device|access to a|handset|operating system|or higher|browser|laptop|desktop|hardware requirement)\b/i;

function mentionsAsStack(re, text) {
  if (!text) return false;
  const g = new RegExp(re.source, 'gi');
  const spots = [];
  let m;
  while ((m = g.exec(text))) {
    spots.push(m.index);
    if (g.lastIndex === m.index) g.lastIndex++;
    if (spots.length > 40) break;
  }
  if (!spots.length) return false;

  // Two alternatives inside one parenthetical ("Android ... or iOS ...") are a
  // single mention, not repetition — only count hits that are far apart.
  const spread = spots.some((p, i) => i > 0 && p - spots[i - 1] > 300);

  const strong = spots.some((p) => {
    const near = text.slice(Math.max(0, p - 60), p + 60);
    if (RE_DEVICE_REQ.test(near)) return false; // device requirement, not the stack
    return RE_DEV_CONTEXT.test(text.slice(Math.max(0, p - 90), p + 90));
  });

  return strong || (spread && !spots.every((p) => RE_DEVICE_REQ.test(text.slice(Math.max(0, p - 60), p + 60))));
}

function classify(j, sourceKind) {
  const hay = `${j.title} ${j.skills.join(' ')} ${j.text}`;
  // title + skill tags are authoritative; description is corroborating only
  const decisive = `${j.title} ${j.skills.join(' ')}`;
  const stacks = [];
  const inferred = [];
  for (const s of STACKS) {
    if (s.re.test(decisive)) stacks.push(s);
    else if (mentionsAsStack(s.re, j.text)) {
      stacks.push(s);
      inferred.push(s.key);
    }
  }
  const wins = expWindows(hay);
  const fits2 = wins.some(([a, b]) => a <= 2 && b >= 2);

  const locHay = `${j.location} ${j.text.slice(0, 400)}`;
  const india = RE_INDIA.test(locHay) || /INR/i.test(j.budget);
  const anywhere = !j.location || RE_ANYWHERE.test(j.location);
  const regionLocked = RE_REGION_LOCKED.test(locHay) && !india;
  const indiaOk = india || (anywhere && !regionLocked);

  // a gig marketplace posting IS freelance by construction; a remote board
  // posting only counts if it says so
  const freelance = sourceKind === 'gig' || RE_FREELANCE.test(`${j.type} ${j.title} ${j.text.slice(0, 1500)}`);

  const senior = RE_SENIOR.test(j.title);
  const junior = RE_JUNIOR.test(j.title);
  const best = stacks.length ? Math.min(...stacks.map((s) => s.priority)) : 9;

  let score = 0;
  if (best === 1) score += 40;
  else if (best === 2) score += 22;
  else if (best <= 3) score += 12;
  if (stacks.length > 1) score += 6; // e.g. Flutter + Firebase together
  if (stacks.length && inferred.length === stacks.length) score -= 8; // description-only
  if (freelance) score += 25;
  if (indiaOk) score += 15;
  if (india) score += 10;
  if (fits2) score += 18;
  else if (!wins.length) score += 5;
  if (senior) score -= 15;
  if (junior) score += 5;
  if (j.budget) score += 3;

  return {
    stacks: stacks.map((s) => s.key),
    stackLabels: stacks.map((s) => s.label),
    // stacks only seen in the description, never in the title/skill tags
    inferredStacks: inferred,
    bestPriority: best,
    exp: wins.slice(0, 5),
    expFits2: fits2,
    india,
    indiaOk,
    freelance,
    senior,
    junior,
    score,
  };
}

/* ------------------------------------------------------------------- run */

const keyOf = (j) =>
  (j.url || '').replace(/[?#].*$/, '').toLowerCase() ||
  `${j.title}|${j.company}`.toLowerCase();

async function run() {
  let sources = SOURCES;
  if (ONLY) sources = sources.filter((s) => s.name.toLowerCase().includes(ONLY.toLowerCase()));
  let stacks = STACKS;
  if (STACK) stacks = stacks.filter((s) => s.key === STACK || s.label.toLowerCase().includes(STACK.toLowerCase()));

  const queries = [...new Set(stacks.flatMap((s) => s.terms))];
  console.log(`Reading ${sources.length} source(s); ${queries.length} query term(s)\n`);

  const diagnostics = [];
  const all = new Map();

  for (const src of sources) {
    const t0 = Date.now();
    let raw = [];
    let error = null;
    const calls = [];
    try {
      if (src.perQuery) {
        for (const q of queries) {
          const got = await src.fetch(q);
          calls.push({ query: q, got: got ? got.length : null });
          if (Array.isArray(got)) raw.push(...got);
        }
      } else {
        const got = await src.fetch();
        calls.push({ query: '(all)', got: got ? got.length : null });
        if (Array.isArray(got)) raw = got;
      }
    } catch (e) {
      error = String(e.message || e);
    }

    if (!error && !raw.length) error = 'source-returned-no-postings';

    let added = 0;
    for (const j of raw) {
      if (!j.title) continue;
      const k = keyOf(j);
      if (all.has(k)) continue;
      const c = classify(j, src.kind);
      all.set(k, { ...j, ...c, source: src.name, sourceKind: src.kind });
      added++;
    }

    diagnostics.push({
      source: src.name,
      kind: src.kind,
      fetched: raw.length,
      unique: added,
      error,
      calls,
      ms: Date.now() - t0,
    });
    console.log(
      `  ${src.name.padEnd(16)} ${String(raw.length).padStart(5)} fetched  ${String(added).padStart(5)} new` +
        (error ? `   !! ${error}` : '')
    );
  }

  const jobs = [...all.values()].sort((a, b) => b.score - a.score);
  const payload = { generated: new Date().toISOString(), diagnostics, jobs };

  const resultsFile = OUT ? `${OUT}.results.json` : 'results.json';
  const reportFile = OUT ? `${OUT}.txt` : 'freelance.txt';
  fs.writeFileSync(path.join(__dirname, resultsFile), JSON.stringify(payload, null, 2));
  writeReport(payload, reportFile);

  const prio = jobs.filter((j) => j.bestPriority === 1);
  console.log(
    `\n  postings collected : ${jobs.length}` +
      `\n  priority stacks    : ${prio.length}  (Flutter/Dart, Spring Boot/Java, Firebase)` +
      `\n  freelance/contract : ${jobs.filter((j) => j.freelance).length}` +
      `\n  India-workable     : ${jobs.filter((j) => j.indiaOk).length}` +
      `\n\nWrote ${reportFile} + ${resultsFile}`
  );
}

function fmt(j, indent = '    ') {
  const exp = j.exp && j.exp.length ? j.exp.map(([a, b]) => `${a}-${b}y`).join(' / ') : 'not stated';
  const tags = [
    j.freelance ? 'FREELANCE/CONTRACT' : 'salaried-remote',
    j.india ? 'INDIA' : j.indiaOk ? 'india-ok' : 'region-locked',
  ].join('  ');
  return (
    `${indent}${j.title}${j.company ? `   @ ${j.company}` : ''}\n` +
    `${indent}  ${tags}\n` +
    `${indent}  stack    : ${j.stackLabels.join(' + ') || '—'}\n` +
    `${indent}  exp req  : ${exp}${j.budget ? `    budget: ${j.budget}` : ''}    score: ${j.score}\n` +
    `${indent}  where    : ${j.location || 'n/a'}   [${j.source}]${j.posted ? `  posted ${j.posted}` : ''}\n` +
    `${indent}  url      : ${j.url || 'n/a'}`
  );
}

function writeReport(payload, reportFile) {
  const { diagnostics, jobs } = payload;
  const L = [];
  const now = payload.generated.replace('T', ' ').slice(0, 19);

  L.push('='.repeat(78));
  L.push('FREELANCE / CONTRACT WORK BY STACK');
  L.push('Wanted   : Flutter/Dart, Spring Boot/Java, Firebase/Firestore (then any stack)');
  L.push('Level    : ~2 years experience        Location preference : India / India-friendly remote');
  L.push(`Generated: ${now} UTC  by test.js`);
  L.push('='.repeat(78));
  L.push('');
  L.push(`Sources read       : ${diagnostics.filter((d) => !d.error).length} of ${diagnostics.length}`);
  L.push(`Postings collected : ${jobs.length}`);
  L.push(`Freelance/contract : ${jobs.filter((j) => j.freelance).length}`);
  L.push(`India-workable     : ${jobs.filter((j) => j.indiaOk).length}`);
  L.push('');
  L.push('Note: "FREELANCE/CONTRACT" means a gig-marketplace project or a posting that');
  L.push('says contract/freelance. "salaried-remote" postings are kept because they are');
  L.push('still remote work for the same stack, but they are not freelance — the tag on');
  L.push('each entry tells you which you are looking at.');
  L.push('');

  let n = 0;
  for (const s of STACKS) {
    const rows = jobs.filter((j) => j.stacks.includes(s.key));
    const gig = rows.filter((j) => j.freelance);
    const rest = rows.filter((j) => !j.freelance);
    n++;
    L.push('#'.repeat(78));
    L.push(`# SECTION ${n} — ${s.label.toUpperCase()}`);
    L.push(`# ${rows.length} posting(s): ${gig.length} freelance/contract, ${rest.length} salaried-remote`);
    L.push('#'.repeat(78));
    L.push('');
    /* Rank by how central THIS stack is to the posting. A Flutter gig that
     * happens to say "Java" once should not head the Spring Boot section, so
     * a stack named in the title/skill tags outranks one only inferred from
     * the description, and a title mention outranks a tag mention. */
    const centrality = (j) => (s.re.test(j.title) ? 0 : j.inferredStacks.includes(s.key) ? 2 : 1);
    const indiaFirst = (a, b) =>
      centrality(a) - centrality(b) || (b.indiaOk ? 1 : 0) - (a.indiaOk ? 1 : 0) || b.score - a.score;
    L.push(`-- freelance / contract (${gig.length}) ---------------------------------------`);
    L.push('');
    if (!gig.length) L.push('    (nothing freelance for this stack in this run)');
    for (const j of [...gig].sort(indiaFirst).slice(0, 60)) L.push(fmt(j));
    if (gig.length > 60) L.push(`    ... and ${gig.length - 60} more (see results.json)`);
    L.push('');
    L.push(`-- salaried remote, same stack (${rest.length}) --------------------------------`);
    L.push('');
    for (const j of [...rest].sort(indiaFirst).slice(0, 25)) L.push(fmt(j));
    if (rest.length > 25) L.push(`    ... and ${rest.length - 25} more (see results.json)`);
    L.push('');
  }

  const unmatched = jobs.filter((j) => !j.stacks.length);
  L.push('#'.repeat(78));
  L.push(`# SECTION ${n + 1} — OTHER STACKS  (${unmatched.length})`);
  L.push('# Freelance/contract postings that matched none of the stacks above — kept so');
  L.push('# the run is not silently discarding work you might still want.');
  L.push('#'.repeat(78));
  L.push('');
  for (const j of unmatched.filter((j) => j.freelance).sort((a, b) => b.score - a.score).slice(0, 40)) L.push(fmt(j));
  L.push('');

  L.push('#'.repeat(78));
  L.push(`# SECTION ${n + 2} — SOURCE VERIFICATION`);
  L.push('# What each source actually returned this run. A source listed with 0 fetched');
  L.push('# was reached but gave nothing back — that is a source problem, not "no work".');
  L.push('#'.repeat(78));
  L.push('');
  for (const d of diagnostics) {
    L.push(`>> ${d.source}  [${d.kind}]  ${d.error ? `!! ${d.error}` : 'ok'}`);
    L.push(`    fetched ${d.fetched}, ${d.unique} unique after de-dup, ${d.ms} ms`);
    L.push(`    calls  : ${d.calls.map((c) => `${c.query}=${c.got === null ? 'null' : c.got}`).join('  ')}`);
    L.push('');
  }

  fs.writeFileSync(path.join(__dirname, reportFile), L.join('\n'));
}

if (ARGS.includes('--report-only')) {
  const src = argVal('from', OUT ? `${OUT}.results.json` : 'results.json');
  const dest = OUT ? `${OUT}.txt` : 'freelance.txt';
  const payload = JSON.parse(fs.readFileSync(path.join(__dirname, src), 'utf8'));
  writeReport(payload, dest);
  console.log(`Rebuilt ${dest} from ${src} (${payload.jobs.length} postings)`);
} else {
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
