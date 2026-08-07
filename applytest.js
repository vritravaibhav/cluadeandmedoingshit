#!/usr/bin/env node
/**
 * applytest.js — turn the careers.txt matches into a ready-to-submit apply queue.
 *
 * What this does NOT do: submit applications. 65 of 83 boards require creating an
 * account per employer with email verification, and the rest sit behind CSRF +
 * reCAPTCHA. Automated submission also risks getting the candidate's email flagged
 * across Greenhouse/Lever, which are shared across most of tech hiring.
 *
 * What it DOES do:
 *   1. Score every matched role against THIS candidate's real resume, not a generic filter
 *   2. Decide eligibility: India-based, or explicitly offers visa sponsorship / relocation
 *   3. Flag dealbreakers (citizenship, clearance, wrong primary stack, seniority)
 *   4. Emit apply-queue.txt: ordered, with prefilled standard answers per role
 *
 * Usage:
 *   node applytest.js            # build the queue
 *   node applytest.js --all      # include roles judged ineligible, for review
 */

const fs = require('fs');
const path = require('path');
const T = require('./test.js');

const DIR = __dirname;
const RAW = path.join(DIR, 'raw-jobs.json');
const OUT = path.join(DIR, 'apply-queue.txt');
const JSON_OUT = path.join(DIR, 'apply-queue.json');

/* ------------------------------------------------------------------ *
 * CANDIDATE — parsed from myresume.txt
 * ------------------------------------------------------------------ */

const ME = {
  name: 'Divyanshu Vaibhav',
  email: 'divaibhavyanshu@gmail.com',
  phone: '+91-9576671336',
  github: 'github.com/vritravaibhav',
  linkedin: 'linkedin.com/in/divyanshu-vaibhav',
  portfolio: 'vritravaibhav.github.io/portfolio',
  degree: 'B.E. Electronics & Communication, Panjab University (2020–2024)',
  currentTitle: 'Software Engineer',
  currentCompany: 'Longfloat Information Technology Pvt. Ltd., Dubai',
  startedWorking: '2024-03',      // Flutter Developer @ Connect 4 Digital India
  nationality: 'India',
  basedIn: 'India',
  needsSponsorshipOutsideIndia: true,

  // Weighted skills. `w` drives the fit score; higher = more central to this profile.
  skills: {
    // headline stack
    'java': 10, 'spring boot': 10, 'spring': 8, 'flutter': 10, 'dart': 10,
    'spring security': 6, 'spring data jpa': 6, 'hibernate': 6, 'spring mvc': 5,
    'jpa': 5, 'jwt': 4, 'microservices': 6, 'rest': 5, 'restful': 4, 'api': 3,
    // data
    'mysql': 6, 'sql': 5, 'mongodb': 5, 'redis': 5, 'firebase': 4, 'firestore': 3,
    'rabbitmq': 4, 'flyway': 2, 'maven': 3, 'indexing': 3, 'query optimization': 3,
    // mobile / native
    'android': 8, 'ndk': 5, 'jni': 5, 'c++': 5, 'bloc': 4, 'riverpod': 3,
    'ios': 3, 'mobile': 6, 'native': 4, 'webrtc': 5,
    // testing / devops
    'junit': 5, 'mockito': 4, 'docker': 5, 'swagger': 3, 'openapi': 3,
    'git': 2, 'github actions': 3, 'ci/cd': 3, 'postman': 2, 'unit test': 3,
    'integration test': 3,
    // other
    'llm': 4, 'ai agent': 4, 'stripe': 2, 'fcm': 2, 'crashlytics': 2,
    'websocket': 4, 'stomp': 3, 'data structures': 3, 'algorithms': 3,
  },

  // Things the resume does NOT support. Heavy presence => likely a bad fit.
  gaps: ['golang', ' go ', 'rust', 'scala', 'ruby', 'rails', 'php', 'laravel',
         '.net', 'c#', 'kubernetes', 'terraform', 'kafka', 'spark', 'hadoop',
         'elasticsearch', 'react', 'angular', 'vue', 'typescript', 'node.js',
         'python', 'django', 'salesforce', 'sap', 'abap', 'kotlin', 'swift'],
};

/** Total professional experience in years, as of today. */
function yearsOfExperience() {
  const [y, m] = ME.startedWorking.split('-').map(Number);
  const now = new Date();
  return (now.getFullYear() - y) + (now.getMonth() + 1 - m) / 12;
}

/* ------------------------------------------------------------------ *
 * ELIGIBILITY
 * ------------------------------------------------------------------ */

const INDIA = /\b(india|bengaluru|bangalore|hyderabad|pune|chennai|mumbai|gurugram|gurgaon|noida|delhi|kolkata|ahmedabad|jaipur|kochi|coimbatore|karn[aā]taka|maharashtra|telangana|tamil nadu|haryana)\b/i;
const REMOTE_GLOBAL = /\b(remote\s*[-–—,]?\s*(global|worldwide|anywhere)|work from anywhere|fully remote)\b/i;

/** Phrases that mean "we will not sponsor" — a hard stop for a India-based applicant. */
const NO_SPONSOR = /\b(no (visa )?sponsorship|not (be )?(able|willing) to sponsor|does not (offer|provide) sponsorship|without (the need for )?sponsorship|must (be|have) (legally )?(authorized|authorised|eligible) to work|work authorization is required|u\.?s\.? citizen|citizenship (is )?required|security clearance|must reside in|must be located in|legally authorized to work in the (united states|us|u\.s\.))\b/i;
const YES_SPONSOR = /\b(visa sponsorship( is)? (available|provided|offered)|we sponsor|sponsorship (available|provided|offered)|relocation (support|assistance|package|allowance)|we (will )?(help|support) (you )?(with )?relocat|work permit)\b/i;

/* Countries whose standard work visa is realistically obtainable for an Indian
 * software engineer with ~2 yrs experience (employer-sponsored, no lottery).
 * The US is deliberately excluded: H-1B is a lottery and almost never offered
 * at this level, so those are a much longer shot. */
const SPONSOR_FRIENDLY = /\b(united kingdom|england|london|manchester|edinburgh|ireland|dublin|germany|berlin|munich|hamburg|netherlands|amsterdam|poland|warsaw|krakow|spain|madrid|barcelona|portugal|lisbon|france|paris|sweden|stockholm|denmark|copenhagen|norway|oslo|finland|helsinki|switzerland|zurich|austria|vienna|belgium|brussels|czech|prague|dubai|uae|abu dhabi|singapore|australia|sydney|melbourne|canada|toronto|vancouver)\b/i;

/**
 * Four honest buckets. "Sponsorship not mentioned" is NOT a refusal — most ads
 * simply stay silent — so it gets its own tier rather than being lumped in with
 * the explicit rejections.
 */
function eligibility(job) {
  const loc = job.location || '';
  const blob = `${job.location}\n${job.description}`;

  if (INDIA.test(loc)) return { ok: true, tier: 'india', why: 'India-based role' };

  if (NO_SPONSOR.test(blob)) {
    const m = blob.match(NO_SPONSOR);
    return { ok: false, tier: 'refused', why: `explicitly no sponsorship ("${m[0].slice(0, 46)}")` };
  }
  if (YES_SPONSOR.test(blob)) {
    const m = blob.match(YES_SPONSOR);
    return { ok: true, tier: 'sponsors', why: `sponsorship/relocation offered ("${m[0].slice(0, 38)}")` };
  }
  if (INDIA.test(blob)) return { ok: true, tier: 'india', why: 'India mentioned in posting' };
  if (REMOTE_GLOBAL.test(loc)) return { ok: true, tier: 'india', why: 'globally remote' };

  if (SPONSOR_FRIENDLY.test(loc)) {
    return { ok: true, tier: 'worth-a-shot',
             why: `${loc} — sponsorship not stated, but this market commonly sponsors` };
  }
  return { ok: false, tier: 'longshot',
           why: `outside India (${loc || 'location unstated'}); sponsorship not stated and market rarely sponsors at this level` };
}

/* ------------------------------------------------------------------ *
 * FIT SCORING — against the actual resume
 * ------------------------------------------------------------------ */

/* Programming languages a posting can be built around. What matters for fit is
 * which one is PRIMARY — not how many technologies the ad happens to name.
 * Almost every backend ad mentions Kubernetes and Kafka; that says nothing. */
const LANGS = {
  java: /\bjava\b(?!script)/gi, dart: /\bdart\b/gi, flutter: /\bflutter\b/gi,
  kotlin: /\bkotlin\b/gi, 'c++': /\bc\+\+\b/gi, python: /\bpython\b/gi,
  go: /\b(golang|go lang)\b/gi, rust: /\brust\b/gi, scala: /\bscala\b/gi,
  ruby: /\bruby\b/gi, php: /\bphp\b/gi, csharp: /\b(c#|\.net)\b/gi,
  typescript: /\b(typescript|javascript|node\.?js)\b/gi, swift: /\bswift\b/gi,
};
// How well this candidate covers each language.
const MY_LANGS = { java: 1.0, dart: 1.0, flutter: 1.0, 'c++': 0.7, kotlin: 0.35, typescript: 0.15 };

function primaryLanguages(title, description) {
  const counts = {};
  for (const [lang, re] of Object.entries(LANGS)) {
    const inTitle = (title.match(re) || []).length;
    const inBody = (description.match(re) || []).length;
    // A language named in the title is decisive; body mentions are weak evidence.
    const n = inTitle * 8 + inBody;
    if (n > 0) counts[lang] = n;
  }
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return { primary: [], counts };
  // Anything within half the top score counts as co-primary (e.g. "Java/Kotlin").
  const top = ranked[0][1];
  return { primary: ranked.filter(([, n]) => n >= top / 2).map(([l]) => l), counts };
}

function fit(job) {
  const title = job.title || '';
  const desc = job.description || '';
  const blob = `${title}\n${desc}`.toLowerCase();

  const matched = [];
  let skillScore = 0;
  for (const [skill, w] of Object.entries(ME.skills)) {
    const esc = skill.replace(/[.+*?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[^a-z0-9+#])${esc}([^a-z0-9+#]|$)`, 'i');
    if (!re.test(blob)) continue;
    matched.push(skill);
    // A skill in the TITLE is worth far more than one buried in a bullet list.
    const inTitle = new RegExp(`(^|[^a-z0-9+#])${esc}([^a-z0-9+#]|$)`, 'i').test(title);
    skillScore += inTitle ? w * 2.5 : w;
  }
  // Diminishing returns: a JD listing 30 technologies is not 3x better than one
  // listing 10. Compress so language fit stays the dominant signal.
  const breadth = Math.round(28 * (1 - Math.exp(-skillScore / 45)));

  const { primary, counts } = primaryLanguages(title, desc);
  const coverage = primary.length
    ? primary.reduce((s, l) => s + (MY_LANGS[l] || 0), 0) / primary.length
    : 0.5;                              // language-agnostic ad: neutral, not penalised

  // Language fit is the spine of the score: 0 coverage is a wrong-stack role.
  const langScore = Math.round(55 * coverage);
  const unmatchedPrimary = primary.filter((l) => !MY_LANGS[l]);

  const core = ['java', 'spring boot', 'flutter', 'dart', 'android'].filter((k) => matched.includes(k));
  const coreBonus = Math.min(17, core.length * 5);

  const total = Math.max(0, Math.round(langScore + breadth + coreBonus));
  return { score: total, matched, core, primary, unmatchedPrimary, counts, coverage: +coverage.toFixed(2) };
}

/* ------------------------------------------------------------------ *
 * WHAT THE APPLICATION ACTUALLY REQUIRES
 * ------------------------------------------------------------------ */

const APPLY_MECHANICS = {
  greenhouse:     { effort: 'easy',   note: 'public form; resume upload + a few fields' },
  lever:          { effort: 'easy',   note: 'public form; resume upload + a few fields' },
  ashby:          { effort: 'easy',   note: 'public form; resume upload' },
  workable:       { effort: 'easy',   note: 'public form; resume upload' },
  recruitee:      { effort: 'easy',   note: 'public form' },
  keka:           { effort: 'easy',   note: 'public form' },
  sensehq:        { effort: 'easy',   note: 'public form' },
  bamboohr:       { effort: 'easy',   note: 'public form' },
  breezy:         { effort: 'easy',   note: 'public form' },
  rippling:       { effort: 'easy',   note: 'public form' },
  comeet:         { effort: 'easy',   note: 'public form' },
  personio:       { effort: 'easy',   note: 'public form' },
  htmlBoard:      { effort: 'easy',   note: 'public form (JazzHR/Freshteam)' },
  teamtailorJson: { effort: 'easy',   note: 'public form' },
  workday:        { effort: 'ACCOUNT', note: 'create account + verify email, then a multi-step form' },
  jobvite:        { effort: 'ACCOUNT', note: 'Jobvite account or long form' },
  sitemap:        { effort: 'ACCOUNT', note: 'enterprise portal (SuccessFactors/Phenom); account required' },
  nextdata:       { effort: 'manual',  note: 'custom site form' },
  jsonapi:        { effort: 'manual',  note: 'custom site form' },
  rss:            { effort: 'manual',  note: 'custom site form' },
};

/* ------------------------------------------------------------------ *
 * PREFILLED ANSWERS
 * ------------------------------------------------------------------ */

function prefill(company, job, f) {
  const yrs = yearsOfExperience().toFixed(1);
  const top = f.core.length ? f.core.join(', ') : f.matched.slice(0, 5).join(', ');
  return {
    'Full name': ME.name,
    'Email': ME.email,
    'Phone': ME.phone,
    'Location': 'India',
    'LinkedIn': `https://${ME.linkedin}`,
    'GitHub': `https://${ME.github}`,
    'Portfolio': `https://${ME.portfolio}`,
    'Current company': ME.currentCompany,
    'Current title': ME.currentTitle,
    'Years of experience': `${yrs} years`,
    'Education': ME.degree,
    'Authorized to work in this location?':
      INDIA.test(job.location || '') ? 'Yes — Indian citizen, based in India'
        : 'No — Indian citizen; would require visa sponsorship',
    'Require sponsorship?':
      INDIA.test(job.location || '') ? 'No' : 'Yes',
    'Notice period': '[FILL IN — check your contract]',
    'Expected salary': '[FILL IN]',
    'Why this role (draft)':
      `My core stack is ${top}, which maps directly to this role. At ${ME.currentCompany.split(',')[0]} ` +
      `I build Spring Boot REST microservices (Spring Data JPA, Hibernate, Spring Security/JWT) ` +
      `consumed by Flutter clients, with JUnit/Mockito tests and Docker packaging. Previously I designed ` +
      `the Spring Boot backend for a production ride-hailing platform — trip lifecycle, fare calculation ` +
      `and driver–rider matching — and cut map API costs 85% with a server-side tile-caching layer.`,
  };
}

/* ------------------------------------------------------------------ *
 * BUILD
 * ------------------------------------------------------------------ */

function build({ includeIneligible = false } = {}) {
  if (!fs.existsSync(RAW)) {
    console.error('No raw-jobs.json — run: node test.js');
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(RAW, 'utf8'));

  const seen = new Set();
  const rows = [];
  for (const board of raw) {
    for (const job of board.jobs) {
      const cls = T.classify(job);
      if (cls.tier !== 'A' && cls.tier !== 'B') continue;
      const key = `${board.company}::${job.title.toLowerCase().replace(/\s+/g, ' ').trim()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const f = fit(job);
      const e = eligibility(job);
      rows.push({
        company: board.company, parent: board.parent, provider: board.provider,
        job, cls, fit: f, elig: e,
        mech: APPLY_MECHANICS[board.provider] || { effort: 'manual', note: 'unknown' },
      });
    }
  }

  const byScore = (a, b) => b.fit.score - a.fit.score;
  const G = (t) => rows.filter((r) => r.elig.tier === t).sort(byScore);
  const groups = [
    ['1. INDIA — apply now, no visa needed', G('india')],
    ['2. SPONSORSHIP OFFERED — posting explicitly says so', G('sponsors')],
    ['3. WORTH A SHOT — sponsor-friendly country, sponsorship not stated', G('worth-a-shot')],
    ['4. LONG SHOT — sponsorship unlikely at this level', G('longshot')],
    ['5. RULED OUT — posting explicitly refuses sponsorship', G('refused')],
  ];
  const eligible = rows.filter((r) => r.elig.ok).sort(byScore);
  const blocked = rows.filter((r) => !r.elig.ok).sort(byScore);
  const list = includeIneligible ? [...eligible, ...blocked] : eligible;

  const out = [];
  const bar = '='.repeat(78);
  out.push(bar);
  out.push(`APPLY QUEUE — ${ME.name}`);
  out.push(`${ME.email} | ${ME.phone} | based in India`);
  out.push(`Experience: ${yearsOfExperience().toFixed(1)} yrs | Core: Java/Spring Boot + Flutter/Dart`);
  out.push(`Generated: ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC`);
  out.push(bar);
  out.push('');
  out.push(`${rows.length} matched roles -> ${eligible.length} you can actually apply to, ` +
           `${blocked.length} blocked on work authorization.`);
  out.push('Ordered by fit against your resume. "easy" = public form, ~1 min with the answers below.');
  out.push('');

  const quick = eligible.filter((r) => r.mech.effort === 'easy');
  const acct = eligible.filter((r) => r.mech.effort !== 'easy');
  out.push(`  ${quick.length} quick applies (public form)`);
  out.push(`  ${acct.length} need an employer account first`);
  out.push('');
  for (const [heading, items] of groups) out.push(`  ${String(items.length).padStart(3)}  ${heading}`);
  out.push('');

  // Grouped by how realistically you can actually get the job, best group first.
  let n = 0;
  for (const [heading, items] of groups) {
    if (!items.length) continue;
    out.push('');
    out.push('#'.repeat(78));
    out.push(`${heading}   (${items.length})`);
    out.push('#'.repeat(78));
    items.forEach((r) => { n++; emit(r, n); });
  }

  function emit(r, i) {
    out.push('-'.repeat(78));
    out.push(`${String(i).padStart(3)}. ${r.job.title}`);
    out.push(`     Company    : ${r.company}${r.parent ? `  [board = ${r.parent}]` : ''}`);
    out.push(`     Location   : ${r.job.location || 'n/a'}`);
    out.push(`     Fit score  : ${r.fit.score}/100   (tier ${r.cls.tier}; primary lang: ${r.fit.primary.join("+")||"unspecified"})`);
    out.push(`     Experience : ${r.cls.exp.stated ? `${r.cls.exp.min}${r.cls.ranges.some((x) => x.max === null) ? '+' : ''} yrs required` : 'not stated in posting'}`);
    out.push(`     You match  : ${r.fit.matched.slice(0, 14).join(', ') || '-'}`);
    if (r.fit.unmatchedPrimary.length) out.push(`     Wrong stack: primary language is ${r.fit.unmatchedPrimary.join(", ")}`);
    out.push(`     Eligibility: ${r.elig.why}`);
    out.push(`     To apply   : [${r.mech.effort}] ${r.mech.note}`);
    out.push(`     URL        : ${r.job.url}`);
    out.push('');
  }

  out.push(bar);
  out.push('STANDARD ANSWERS — paste these into any form');
  out.push(bar);
  const sample = prefill('', { location: 'India' }, { core: ['java', 'spring boot', 'flutter'], matched: [] });
  for (const [k, v] of Object.entries(sample)) {
    if (k === 'Why this role (draft)') continue;
    out.push(`  ${k.padEnd(38)}: ${v}`);
  }
  out.push('');
  out.push('  Why this role (adapt per company):');
  out.push('  ' + sample['Why this role (draft)'].replace(/(.{92})\s/g, '$1\n  '));
  out.push('');
  out.push('  NOTE: "Notice period" and "Expected salary" are the two you must fill yourself.');

  fs.writeFileSync(OUT, out.join('\n'));
  fs.writeFileSync(JSON_OUT, JSON.stringify(
    list.map((r) => ({
      company: r.company, title: r.job.title, location: r.job.location,
      url: r.job.url, fitScore: r.fit.score, tier: r.cls.tier,
      eligible: r.elig.ok, eligibility: r.elig.why,
      effort: r.mech.effort, matched: r.fit.matched,
      prefill: prefill(r.company, r.job, r.fit),
    })), null, 2));

  console.log(`matched ${rows.length} | eligible ${eligible.length} | blocked ${blocked.length}`);
  console.log(`  quick applies (public form): ${quick.length}`);
  console.log(`  need employer account      : ${acct.length}`);
  console.log(`\nWrote apply-queue.txt and apply-queue.json`);

  console.log('\nTop 12 by fit:');
  eligible.slice(0, 12).forEach((r, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. [${String(r.fit.score).padStart(3)}] ${r.company.padEnd(20)} ${r.job.title.slice(0, 46).padEnd(46)} ${r.mech.effort}`);
  });
  return { eligible, blocked };
}

module.exports = { build, fit, eligibility, ME, yearsOfExperience };

if (require.main === module) build({ includeIneligible: process.argv.includes('--all') });
