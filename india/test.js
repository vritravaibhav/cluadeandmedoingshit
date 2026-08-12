#!/usr/bin/env node
/*
 * test.js — India software roles by STACK, not by company initial.
 *
 * Target : Software Engineer, ~2 years experience
 * Stack  : Java / Spring Boot and Dart / Flutter first, Firebase alongside,
 *          then any other stack
 * Where  : India (or India-workable remote)
 * Output : india.txt (report) + results.json (everything fetched)
 *
 * Why this exists
 * ---------------
 * The per-letter sweeps are structurally too small. Across all 125 "W"
 * companies there were 964 India roles but only 8 that were Java/Flutter at the
 * 2-year mark — because a company list starting with one letter covers about 4%
 * of the market. Searching by stack instead reaches ~4,000 India roles in the
 * same stack, and picks up employers no alphabetical list would have contained.
 *
 * Honest limit: Instahyre's public API returns title, company, location and
 * skill tags but no description and no experience number, and its job pages are
 * 403 to non-browsers. So seniority here is inferred from the TITLE. A role
 * titled "Software Engineer" that secretly wants 6 years will still appear —
 * the report marks how each judgement was made.
 *
 * Usage:
 *   node test.js                     # full sweep
 *   node test.js --pages=4           # shallower (faster)
 *   node test.js --stack=flutter
 *   node test.js --report-only
 */

const fs = require('fs');
const path = require('path');
const { instahyre, remote } = require('./sources.js');

const ARGS = process.argv.slice(2);
const argVal = (k, d) => {
  const a = ARGS.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const PAGES = parseInt(argVal('pages', '8'), 10);
const STACK = argVal('stack', null);
const OUT = argVal('out', null);
const NO_REMOTE = ARGS.includes('--no-remote');

/* ----------------------------------------------------------------- stacks */
const STACKS = [
  { key: 'springboot', label: 'Java / Spring Boot', priority: 1, re: /\b(spring\s?boot|spring|hibernate|jpa|\bjava\b(?!\s*script)|j2ee|servlet)\b/i },
  { key: 'flutter', label: 'Flutter / Dart', priority: 1, re: /\b(flutter|dart)\b/i },
  { key: 'firebase', label: 'Firebase / Firestore', priority: 1, re: /\b(firebase|firestore|fcm)\b/i },
  { key: 'mobile', label: 'Android / Kotlin / React Native / iOS', priority: 2, re: /\b(android|kotlin|react\s?native|swift|\bios\b|jetpack)\b/i },
  { key: 'backend', label: 'Other backend (Node / Python / Go / .NET)', priority: 3, re: /\b(node\.?js|express|nest\.?js|django|flask|fastapi|golang|\.net|c#|php|laravel|rails|python)\b/i },
  { key: 'web', label: 'Web / full-stack (React / Angular / Vue)', priority: 3, re: /\b(react\b(?!\s?native)|angular|vue|next\.?js|svelte|full[\s-]?stack|frontend)\b/i },
];

const RE_INDIA =
  /\b(india|bangalore|bengaluru|hyderabad|pune|mumbai|chennai|delhi|gurgaon|gurugram|noida|kolkata|ahmedabad|jaipur|indore|kochi|coimbatore|trivandrum|thiruvananthapuram|chandigarh|vadodara|nagpur|mysore|mysuru|remote)\b/i;

/* Title-based seniority. This is the only experience signal Instahyre gives,
 * so keep it explicit rather than pretending to know the years. */
const RE_SENIOR = /\b(senior|sr\.?|staff|principal|lead|architect|manager|head|director|vp|chief|iii|iv|expert|avp|specialist\s?iv)\b/i;
const RE_JUNIOR = /\b(junior|jr\.?|associate|entry|graduate|trainee|fresher|intern|sde[\s-]?1\b|engineer\s*i\b|\bi{1,2}\b)\b/i;
const RE_ENG =
  /(software|backend|back[\s-]?end|frontend|front[\s-]?end|full[\s-]?stack|application|platform|mobile|android|ios|web|java|python|node|golang|api|sde|systems?|qa|test|data|devops|cloud|ml|ai)\s*[-\s]*(engineer|developer|dev\b|programmer)|(\bengineer\b|\bdeveloper\b|\bsde\b|\bsdet\b|\bprogrammer\b)/i;

function classify(j) {
  const hay = `${j.title} ${j.skills.join(' ')} ${j.text}`;
  const stacks = STACKS.filter((s) => s.re.test(hay));
  const best = stacks.length ? Math.min(...stacks.map((s) => s.priority)) : 9;
  const senior = RE_SENIOR.test(j.title);
  const junior = RE_JUNIOR.test(j.title);
  const isEng = RE_ENG.test(j.title);
  const india = RE_INDIA.test(`${j.location} ${j.text.slice(0, 300)}`) || j.source === 'instahyre';

  let score = 0;
  if (best === 1) score += 40;
  else if (best === 2) score += 24;
  else if (best <= 3) score += 12;
  if (stacks.length > 1) score += 6;
  if (isEng) score += 20;
  if (india) score += 15;
  if (junior) score += 18; // explicitly at my level
  if (senior) score -= 30; // wants more than 2 years
  if (/\b(sde\s?2|engineer\s?ii|software engineer)\b/i.test(j.title)) score += 8;

  return {
    stacks: stacks.map((s) => s.key),
    stackLabels: stacks.map((s) => s.label),
    bestPriority: best,
    isEng,
    senior,
    junior,
    india,
    score,
  };
}

/* ------------------------------------------------------------------- run */

async function run() {
  console.log('India stack-first sweep (no alphabet filter)\n');
  const all = new Map();

  console.log('  instahyre — pulling by skill:');
  const rows = await instahyre.fetch({
    maxPages: PAGES,
    onProgress: (skill, got, total, info) =>
      console.log(
        `    ${skill.padEnd(16)} +${String(got).padStart(4)}   running total ${String(total).padStart(5)}` +
          (info && info.available != null ? `   (${info.available} exist)` : '') +
          (info && info.throttled ? '   !! RATE-LIMITED, partial' : '')
      ),
  });
  rows.forEach((r) => all.set(`instahyre:${r.id}`, r));
  const throttled = rows.throttled || [];
  if (throttled.length) console.log(`    (rate-limited on: ${throttled.join(', ')} — those are partial)`);

  if (!NO_REMOTE) {
    console.log('\n  remote boards (India-workable):');
    const rem = await remote.fetch();
    let added = 0;
    rem.forEach((r) => {
      const k = `${r.source}:${r.id}`;
      if (!all.has(k)) {
        all.set(k, r);
        added++;
      }
    });
    console.log(`    +${added} from ${new Set(rem.map((r) => r.source)).size} boards`);
  }

  let jobs = [...all.values()].map((j) => ({ ...j, ...classify(j) }));
  if (STACK) jobs = jobs.filter((j) => j.stacks.includes(STACK));
  jobs.sort((a, b) => b.score - a.score);

  const payload = { generated: new Date().toISOString(), pagesPerSkill: PAGES, throttled, total: jobs.length, jobs };
  const resultsFile = OUT ? `${OUT}.results.json` : 'results.json';
  const reportFile = OUT ? `${OUT}.txt` : 'india.txt';
  fs.writeFileSync(path.join(__dirname, resultsFile), JSON.stringify(payload, null, 2));
  writeReport(payload, reportFile);

  const prio = jobs.filter((j) => j.bestPriority === 1);
  const fit = prio.filter((j) => j.isEng && !j.senior);
  console.log(
    `\n  roles collected      : ${jobs.length}` +
      `\n  priority stack       : ${prio.length}  (Java/Spring, Flutter, Firebase)` +
      `\n  + engineering, non-senior : ${fit.length}` +
      `\n  distinct companies   : ${new Set(jobs.map((j) => j.company)).size}` +
      `\n\nWrote ${reportFile} + ${resultsFile}`
  );
}

function fmt(j, indent = '    ') {
  return (
    `${indent}${j.title}${j.company ? `   @ ${j.company}` : ''}\n` +
    `${indent}  stack    : ${j.stackLabels.join(' + ') || '—'}\n` +
    `${indent}  where    : ${j.location || 'n/a'}   [${j.source}${j.viaSkill ? ` via ${j.viaSkill}` : ''}]   score ${j.score}\n` +
    `${indent}  skills   : ${(j.skills || []).slice(0, 10).join(', ') || '—'}\n` +
    `${indent}  url      : ${j.url || 'n/a'}`
  );
}

function writeReport(payload, reportFile) {
  const { jobs } = payload;
  const L = [];
  L.push('='.repeat(78));
  L.push('INDIA SOFTWARE ROLES — BY STACK, NOT BY COMPANY INITIAL');
  L.push('Looking for : Software Engineer, ~2 years experience');
  L.push('Priority    : Java/Spring Boot, Dart/Flutter, Firebase — then any stack');
  L.push(`Generated   : ${payload.generated.replace('T', ' ').slice(0, 19)} UTC`);
  L.push('='.repeat(78));
  L.push('');
  L.push(`Roles collected   : ${jobs.length}`);
  L.push(`Distinct companies: ${new Set(jobs.map((j) => j.company)).size}`);
  if (payload.throttled && payload.throttled.length) {
    L.push('');
    L.push(`INCOMPLETE: the source rate-limited while reading ${payload.throttled.join(', ')}.`);
    L.push('Those skills are under-represented here — re-run to top them up.');
  }
  L.push('');
  L.push('HOW TO READ THIS. Instahyre — the source of most of these — publishes');
  L.push('title, company, location and skill tags, but NOT the job description or');
  L.push('the years-of-experience field, and its job pages block scripted fetches.');
  L.push('So "non-senior" below means the TITLE does not say senior/lead/principal.');
  L.push('A role titled "Software Engineer" that actually wants 6 years will still');
  L.push('be listed. Open the link before writing anything tailored.');
  L.push('');

  let n = 0;
  for (const s of STACKS) {
    const rows = jobs.filter((j) => j.stacks.includes(s.key));
    if (!rows.length) continue;
    const good = rows.filter((j) => j.isEng && !j.senior);
    const rest = rows.filter((j) => !(j.isEng && !j.senior));
    n++;
    L.push('#'.repeat(78));
    L.push(`# SECTION ${n} — ${s.label.toUpperCase()}`);
    L.push(`# ${rows.length} role(s): ${good.length} engineering & non-senior by title, ${rest.length} other`);
    L.push('#'.repeat(78));
    L.push('');
    L.push(`-- at my level (${good.length}) ------------------------------------------`);
    L.push('');
    good.slice(0, 80).forEach((j) => L.push(fmt(j)));
    if (good.length > 80) L.push(`    ... and ${good.length - 80} more (see results.json)`);
    L.push('');
    L.push(`-- senior / other titles, same stack (${rest.length}) --------------------`);
    L.push('');
    rest.slice(0, 20).forEach((j) => L.push(fmt(j)));
    if (rest.length > 20) L.push(`    ... and ${rest.length - 20} more (see results.json)`);
    L.push('');
  }

  // who is hiring most — useful for deciding where to spend a weekend
  const byCo = {};
  jobs.filter((j) => j.bestPriority === 1 && j.isEng && !j.senior).forEach((j) => {
    byCo[j.company] = (byCo[j.company] || 0) + 1;
  });
  const top = Object.entries(byCo).sort((a, b) => b[1] - a[1]).slice(0, 40);
  L.push('#'.repeat(78));
  L.push('# EMPLOYERS HIRING MOST IN THE PRIORITY STACK AT THIS LEVEL');
  L.push('#'.repeat(78));
  L.push('');
  top.forEach(([c, k]) => L.push(`  ${String(k).padStart(3)}  ${c}`));
  L.push('');

  fs.writeFileSync(path.join(__dirname, reportFile), L.join('\n'));
}

if (ARGS.includes('--report-only')) {
  const src = argVal('from', OUT ? `${OUT}.results.json` : 'results.json');
  const payload = JSON.parse(fs.readFileSync(path.join(__dirname, src), 'utf8'));
  writeReport(payload, OUT ? `${OUT}.txt` : 'india.txt');
  console.log(`Rebuilt from ${src} (${payload.jobs.length} roles)`);
} else {
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
