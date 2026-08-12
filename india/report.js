/*
 * report.js — turn store.json (everything crawl.js has accumulated) into
 * india.txt. Kept separate from the crawler so the report can be rebuilt at any
 * time, including mid-pass, without refetching anything.
 */

const fs = require('fs');
const path = require('path');

const DIR = __dirname;

const STACKS = [
  { key: 'springboot', label: 'Java / Spring Boot', priority: 1, re: /\b(spring\s?boot|spring|hibernate|jpa|\bjava\b(?!\s*script)|j2ee|servlet)\b/i },
  { key: 'flutter', label: 'Flutter / Dart', priority: 1, re: /\b(flutter|dart)\b/i },
  { key: 'firebase', label: 'Firebase / Firestore', priority: 1, re: /\b(firebase|firestore|fcm)\b/i },
  { key: 'mobile', label: 'Android / Kotlin / React Native / iOS', priority: 2, re: /\b(android|kotlin|react\s?native|swift|\bios\b|jetpack)\b/i },
  { key: 'backend', label: 'Other backend (Node / Python / Go / .NET)', priority: 3, re: /\b(node\.?js|express|nest\.?js|django|flask|fastapi|golang|\.net|c#|php|laravel|rails|python)\b/i },
  { key: 'web', label: 'Web / full-stack (React / Angular / Vue)', priority: 3, re: /\b(react\b(?!\s?native)|angular|vue|next\.?js|svelte|full[\s-]?stack|frontend)\b/i },
];

const RE_SENIOR = /\b(senior|sr\.?|staff|principal|lead|architect|manager|head|director|vp|chief|iii|iv|expert|avp)\b/i;
const RE_JUNIOR = /\b(junior|jr\.?|associate|entry|graduate|trainee|fresher|intern|sde[\s-]?1\b|engineer\s*i\b)\b/i;
const RE_ENG =
  /(software|backend|back[\s-]?end|frontend|front[\s-]?end|full[\s-]?stack|application|platform|mobile|android|ios|web|java|python|node|golang|api|sde|systems?|qa|test|data|devops|cloud|ml|ai)\s*[-\s]*(engineer|developer|dev\b|programmer)|(\bengineer\b|\bdeveloper\b|\bsde\b|\bsdet\b|\bprogrammer\b)/i;

function classify(j) {
  const hay = `${j.title} ${(j.skills || []).join(' ')}`;
  const stacks = STACKS.filter((s) => s.re.test(hay));
  const best = stacks.length ? Math.min(...stacks.map((s) => s.priority)) : 9;
  const senior = RE_SENIOR.test(j.title);
  const junior = RE_JUNIOR.test(j.title);
  const isEng = RE_ENG.test(j.title);

  let score = 0;
  if (best === 1) score += 40;
  else if (best === 2) score += 24;
  else if (best <= 3) score += 12;
  if (stacks.length > 1) score += 6;
  if (isEng) score += 20;
  if (junior) score += 18;
  if (senior) score -= 30;
  if (/\b(sde\s?2|engineer\s?ii|software engineer)\b/i.test(j.title)) score += 8;

  return { stacks: stacks.map((s) => s.key), stackLabels: stacks.map((s) => s.label), bestPriority: best, isEng, senior, junior, score };
}

function fmt(j, indent = '    ') {
  return (
    `${indent}${j.title}${j.company ? `   @ ${j.company}` : ''}\n` +
    `${indent}  stack  : ${j.stackLabels.join(' + ') || '—'}     score ${j.score}\n` +
    `${indent}  where  : ${j.location || 'n/a'}     seen ${j.seenAt || '—'}\n` +
    `${indent}  skills : ${(j.skills || []).slice(0, 10).join(', ') || '—'}\n` +
    `${indent}  url    : ${j.url || 'n/a'}`
  );
}

function build() {
  const store = JSON.parse(fs.readFileSync(path.join(DIR, 'store.json'), 'utf8'));
  const state = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(DIR, 'crawl-state.json'), 'utf8')); } catch { return {}; }
  })();

  const jobs = Object.values(store).map((j) => ({ ...j, ...classify(j) })).sort((a, b) => b.score - a.score);

  const L = [];
  const covered = state.total ? Math.min(100, ((Object.keys(store).length / state.total) * 100)).toFixed(1) : '?';
  L.push('='.repeat(78));
  L.push('INDIA SOFTWARE ROLES — FULL CATALOGUE CRAWL');
  L.push('Looking for : Software Engineer, ~2 years experience');
  L.push('Priority    : Java/Spring Boot, Dart/Flutter, Firebase — then any stack');
  L.push(`Generated   : ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`);
  L.push('='.repeat(78));
  L.push('');
  L.push(`Roles stored      : ${jobs.length}`);
  L.push(`Catalogue size    : ${state.total ?? '?'}          coverage ${covered}%`);
  L.push(`Crawl position    : pass ${state.pass ?? 1}, offset ${state.offset ?? 0}`);
  L.push(`Distinct companies: ${new Set(jobs.map((j) => j.company)).size}`);
  L.push('');
  L.push('This is a rolling store: crawl.js walks the whole catalogue in slices and');
  L.push('accumulates, so the count only grows and re-runs refresh what changed.');
  L.push('');
  L.push('LIMIT: the source publishes title, company, location and skill tags but no');
  L.push('description and no years-of-experience field, and blocks scripted fetches of');
  L.push('job pages. "At my level" below therefore means the TITLE is not senior/lead/');
  L.push('principal. Open the link before writing anything tailored to it.');
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
    L.push(`-- at my level (${good.length}) ---------------------------------------------`);
    L.push('');
    good.slice(0, 120).forEach((j) => L.push(fmt(j)));
    if (good.length > 120) L.push(`    ... and ${good.length - 120} more (see store.json)`);
    L.push('');
    L.push(`-- senior / other titles, same stack (${rest.length}) ----------------------`);
    L.push('');
    rest.slice(0, 15).forEach((j) => L.push(fmt(j)));
    if (rest.length > 15) L.push(`    ... and ${rest.length - 15} more (see store.json)`);
    L.push('');
  }

  const byCo = {};
  jobs.filter((j) => j.bestPriority === 1 && j.isEng && !j.senior).forEach((j) => {
    byCo[j.company] = (byCo[j.company] || 0) + 1;
  });
  L.push('#'.repeat(78));
  L.push('# EMPLOYERS HIRING MOST IN THE PRIORITY STACK AT THIS LEVEL');
  L.push('#'.repeat(78));
  L.push('');
  Object.entries(byCo).sort((a, b) => b[1] - a[1]).slice(0, 60).forEach(([c, k]) => L.push(`  ${String(k).padStart(3)}  ${c}`));
  L.push('');

  fs.writeFileSync(path.join(DIR, 'india.txt'), L.join('\n'));
  return { roles: jobs.length, companies: new Set(jobs.map((j) => j.company)).size };
}

module.exports = { build, classify, STACKS };

if (require.main === module) {
  const r = build();
  console.log(`Rebuilt india.txt — ${r.roles} roles, ${r.companies} companies`);
}
