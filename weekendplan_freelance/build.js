#!/usr/bin/env node
/*
 * build.js — turn the freelance sweep into a short, ranked bid list.
 *
 * Deliberately NOT shaped like weekendplan/build.js. That one maximises
 * coverage because job applications are free. Here the binding constraint is
 * the opposite: Freelancer's free tier gives 6 bids a month, Plus gives 100.
 * A list of 1,380 gigs is useless when you can act on a few dozen — so the
 * top folder is capped and ranked, and everything else is kept only as
 * overflow. Precision beats recall for the whole of this file.
 *
 * Reads  : ../freelance/results.json   (written by freelance/test.js)
 * Writes : weekendplan_freelance/1-bid-now/       the shortlist, capped
 *          weekendplan_freelance/2-worth-a-look/  next tier
 *          weekendplan_freelance/3-contract-roles/ longer contract engagements
 *          weekendplan_freelance/INDEX.txt
 */

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const ROOT = path.dirname(DIR);
const SRC = path.join(ROOT, 'freelance', 'results.json');

// How many make the shortlist. Sized to a month of Plus-tier bids (100), left
// deliberately under it so there is room to bid twice on the best ones.
const SHORTLIST = parseInt(process.env.SHORTLIST || '60', 10);
const SECOND_TIER = parseInt(process.env.SECOND_TIER || '120', 10);

const BUCKETS = [
  { n: 1, dir: '1-bid-now', title: 'BID NOW — biddable gigs, Flutter/Java, best fit' },
  { n: 2, dir: '2-worth-a-look', title: 'WORTH A LOOK — biddable gigs, weaker or unscored fit' },
  { n: 3, dir: '3-contract-roles', title: 'CONTRACT ROLES — longer engagements from job boards' },
];

function load() {
  if (!fs.existsSync(SRC)) {
    console.error(`No sweep found at ${SRC}. Run: node freelance/test.js`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(SRC, 'utf8'));
}

const money = (j) => {
  const b = j.budget;
  if (!b) return '';
  if (typeof b === 'string') return b;
  if (typeof b === 'object') {
    const lo = b.min ?? b.minimum ?? b.low;
    const hi = b.max ?? b.maximum ?? b.high;
    const cur = b.currency || b.code || 'USD';
    if (lo || hi) return `${cur} ${lo || '?'}–${hi || '?'}`;
  }
  return '';
};

/* A gig is worth bidding on when it names our stack and is not obviously
 * senior-only. Everything else is overflow. */
function rank(jobs) {
  return jobs
    .slice()
    .sort((a, b) => (b.score || 0) - (a.score || 0));
}

function render(b, jobs, meta) {
  const L = [];
  const bar = '='.repeat(78);
  L.push(bar);
  L.push(`FOLDER ${b.n} — ${b.title}`);
  L.push(`${jobs.length} item(s)`);
  L.push(`Swept ${meta.generated} · built ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`);
  L.push(bar);
  L.push('');
  if (b.n === 1) {
    L.push('Bids are the scarce resource, not gigs. Freelancer free tier = 6 bids/month;');
    L.push('the Plus trial = 100. This list is capped and ranked so you spend them on the');
    L.push('best fits first. Work top down and stop when you run out of bids.');
  } else if (b.n === 2) {
    L.push('Real gigs, but the fit is weaker or the posting never stated enough to score.');
    L.push('Only reach here once folder 1 is exhausted.');
  } else {
    L.push('Longer contract/freelance engagements found on job boards rather than gig');
    L.push('marketplaces. These are applications, not bids — no per-month cap.');
  }
  L.push('');
  L.push(`Sources: ${meta.sources}`);
  L.push('');

  jobs.forEach((j, i) => {
    L.push('-'.repeat(78));
    L.push(`${String(i + 1).padStart(4)}. ${j.title}`);
    const bits = [];
    if (j.company) bits.push(j.company);
    if (j.location) bits.push(j.location);
    const m = money(j);
    if (m) bits.push(m);
    if (bits.length) L.push(`      ${bits.join('  ·  ')}`);
    const stacks = j.stackLabels || j.stacks || j.inferredStacks;
    if (stacks && stacks.length) L.push(`      stack : ${[].concat(stacks).join(', ')}`);
    if (j.exp && j.exp.length) L.push(`      exp   : ${j.exp.map((w) => `${w[0]}-${w[1]}y`).join(', ')}`);
    L.push(`      via   : ${j.source}${j.posted ? '  ·  posted ' + String(j.posted).slice(0, 10) : ''}`);
    L.push(`      bid at: ${j.url}`);
  });
  if (!jobs.length) L.push('(nothing in this bucket in the current sweep)');
  return L.join('\n') + '\n';
}

function main() {
  const data = load();
  const all = data.jobs || [];

  // Biddable gig marketplaces vs. job-board contract postings. Only the former
  // consume a bid quota, and only the former need capping.
  const gigs = all.filter((j) => j.sourceKind === 'gig');
  const boardContract = all.filter((j) => j.sourceKind !== 'gig' && j.freelance && !j.senior);

  const priority = (j) => j.bestPriority || (j.stacks || []).some((s) => /flutter|dart|java|spring/i.test(s));
  const strong = rank(gigs.filter((j) => priority(j) && !j.senior));
  const rest = rank(gigs.filter((j) => !strong.includes(j)));

  const meta = {
    generated: String(data.generated || '').replace('T', ' ').slice(0, 19),
    sources: (data.diagnostics || [])
      .map((d) => `${d.source}(${d.unique ?? d.fetched ?? 0})`)
      .join(' '),
  };

  const out = [
    strong.slice(0, SHORTLIST),
    [...strong.slice(SHORTLIST), ...rest].slice(0, SECOND_TIER),
    rank(boardContract).slice(0, 80),
  ];

  console.log(`freelance sweep ${meta.generated}`);
  console.log(`  total postings   : ${all.length}`);
  console.log(`  biddable gigs    : ${gigs.length}`);
  console.log(`  board contract   : ${boardContract.length}`);
  console.log('');

  const idx = [
    '='.repeat(78),
    'WEEKEND PLAN — FREELANCE',
    `Swept ${meta.generated} · built ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`,
    '='.repeat(78),
    '',
    `Total postings : ${all.length}`,
    `Biddable gigs  : ${gigs.length}   (these consume bid quota)`,
    `Board contract : ${boardContract.length}   (applications, no cap)`,
    `Sources        : ${meta.sources}`,
    '',
    'Bids are the scarce resource. Folder 1 is capped on purpose — spend the',
    "month's bids there before opening folder 2.",
    '',
  ];

  BUCKETS.forEach((b, i) => {
    const dir = path.join(DIR, b.dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'gigs.txt'), render(b, out[i], meta));
    fs.writeFileSync(path.join(dir, 'gigs.json'), JSON.stringify(out[i], null, 1));
    console.log(`  ${b.dir.padEnd(20)} ${String(out[i].length).padStart(4)} items`);
    idx.push(`FOLDER ${b.n} — ${b.title}`);
    idx.push(`   ${out[i].length} item(s)  ->  ${b.dir}/gigs.txt`);
    idx.push('');
  });

  fs.writeFileSync(path.join(DIR, 'INDEX.txt'), idx.join('\n') + '\n');
  console.log('\nWrote weekendplan_freelance/INDEX.txt');
}

main();
