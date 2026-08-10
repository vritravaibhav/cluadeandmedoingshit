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

/*
 * Spread the shortlist across platforms instead of taking the global top N.
 *
 * Bid quotas are PER PLATFORM — Freelancer's 6-a-month cap says nothing about
 * how many proposals you may send on PeoplePerHour or Twine. A shortlist ranked
 * purely by score was 60/60 freelancer.com, because its records carry richer
 * text (skills, budget) and therefore score higher, so 646 gigs from the other
 * eight marketplaces never appeared at all. That is the opposite of what more
 * sources were added for: it concentrates the list on the one platform where
 * the candidate has the least room to act.
 *
 * Round-robin by source, best-first within each, so every platform contributes
 * its strongest gigs and a scarce Freelancer bid is never spent on something
 * that could have been a free proposal elsewhere.
 */
function spreadBySource(jobs, limit) {
  const bySource = new Map();
  for (const j of rank(jobs)) {
    const k = j.source || 'unknown';
    if (!bySource.has(k)) bySource.set(k, []);
    bySource.get(k).push(j);
  }
  // Strongest platform first, so ties in an early round still favour quality.
  const queues = [...bySource.values()].sort((a, b) => (b[0].score || 0) - (a[0].score || 0));
  const out = [];
  let round = 0;
  while (out.length < limit) {
    let took = false;
    for (const q of queues) {
      if (round >= q.length) continue;
      out.push(q[round]);
      took = true;
      if (out.length >= limit) break;
    }
    if (!took) break; // every queue exhausted
    round++;
  }
  return out;
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
    L.push('');
    L.push('Slots are shared across platforms on purpose. Quotas are PER platform, so');
    L.push('a Freelancer bid is the expensive one - if the same work is reachable on');
    L.push('PeoplePerHour, Twine or Freelancermap, spend the free proposal there first.');
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

  /*
   * `bestPriority` cannot be used to pick the shortlist: it is true for all
   * 1,155 gigs, so it separates nothing and ranking collapses to raw score.
   * That let "UI/UX designer", "ERP Hosting and Deployment" and a blockchain
   * integration into a Flutter/Java bid list. Only 430 of the 1,155 gigs
   * actually name the stack — match on that directly instead.
   */
  const STACK = /\b(flutter|dart|java|spring\s?boot|spring|android|kotlin|firebase|firestore|jetpack)\b/i;
  /*
   * A note on near-misses, since this looks wrong at a glance: a "Flutterwave
   * App Developer" gig sits in the shortlist. Flutterwave is an African
   * payments company, not Flutter — but the match is not a substring bug. The
   * STACK regex is word-bounded (\bflutter\b does not match "Flutterwave"),
   * and the evidence is a genuine standalone "Flutter / Dart" label that Twine
   * itself attached to the listing. So the gig really is tagged for this stack
   * upstream; whether the client wants Flutter is a judgement the data cannot
   * settle. Left in deliberately — one borderline gig in sixty is cheaper than
   * a heuristic that starts dropping real ones.
   */
  const onStack = (j) =>
    STACK.test(
      `${j.title || ''} ${j.text || ''} ${[].concat(j.stackLabels || j.stacks || j.inferredStacks || []).join(' ')}`,
    );

  /*
   * The sweep already works out whether a gig can be done from India
   * (`indiaOk` — geo restrictions, residency requirements, timezone demands),
   * and this file simply never read it. 14 of the 60 shortlisted gigs were
   * Europe- or US-only. On a six-bids-a-month budget that is a quarter of the
   * list spent on work the candidate cannot take. They stay available in
   * folder 2, they just no longer consume a scarce top slot.
   */
  /*
   * `indiaOk` is populated for every source, but it is not equally reliable
   * across them: freelancermap (a German marketplace) marks all 33 of its gigs
   * India-OK, including one titled "Java Developer Remote Across Europe".
   * So back the flag with an explicit reading of the posting — a stated region
   * or right-to-work restriction is the strongest possible evidence, and much
   * more trustworthy than a per-source default.
   */
  const GEO_LOCKED =
    /\b(across europe|within europe|europe only|eu[- ]only|eea\b|uk only|us only|usa only|north america only|must (be|reside|live) (based )?in|residents? of|based in (the )?(us|usa|uk|eu|europe|germany|canada|australia)\b|work (authorization|authorisation|permit) in|eligible to work in (the )?(us|uk|eu)|no (agencies|c2c|visa sponsorship)|onsite in)\b/i;

  const workable = (j) =>
    j.indiaOk !== false && !GEO_LOCKED.test(`${j.title || ''} ${String(j.location || '')} ${j.text || ''}`);

  /* A trainee gig pays trainee rates and is not what two years of experience
   * should be bidding on — same reasoning as the internship filter on the jobs
   * side, which was fixed last cycle but never applied here. */
  const TRAINEE = /\b(intern|internship|trainee|apprentice)\b/i;
  const SERVICE = /^(hire|outsource|offshore)\b/i;

  /*
   * Apply the exclusions to EVERY tier, not just the shortlist. A trainee gig
   * was filtered out of 1-bid-now and landed in 2-worth-a-look instead, which
   * is the same mistake in a smaller font — folder 2 is where you go when
   * folder 1 is spent, so it has to be clean too.
   */
  const eligible = gigs.filter((j) => !j.senior && !TRAINEE.test(j.title || '') && !SERVICE.test(j.title || ''));
  const strong = rank(eligible.filter((j) => onStack(j) && workable(j)));
  const strongSet = new Set(strong.map((j) => j.url));
  const rest = rank(eligible.filter((j) => !strongSet.has(j.url)));

  const meta = {
    generated: String(data.generated || '').replace('T', ' ').slice(0, 19),
    sources: (data.diagnostics || [])
      .map((d) => `${d.source}(${d.unique ?? d.fetched ?? 0})`)
      .join(' '),
  };

  const shortlist = spreadBySource(strong, SHORTLIST);
  const picked = new Set(shortlist.map((j) => j.url));
  const out = [
    shortlist,
    spreadBySource([...strong.filter((j) => !picked.has(j.url)), ...rest], SECOND_TIER),
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
