#!/usr/bin/env node
/*
 * apply-india.js — turn the India shortlist in careerv1 into applications you
 * can actually send.
 *
 * Deliberately NOT an auto-submitter. ../applytest.js already established why:
 * these boards want a per-employer account plus email verification, and the
 * rest sit behind CSRF + reCAPTCHA — and a bot-flagged address on Greenhouse or
 * Lever follows you across most of tech hiring. Four hand-sent applications
 * beat forty machine-sent ones at this volume anyway.
 *
 * So it does the part that is actually slow: re-fetches each posting, reads
 * what the role really asks for, matches that against the resume, and writes a
 * per-role cover note plus the answers every form asks for.
 *
 *   node apply-india.js              # top roles, fetch + write apply-india.txt
 *   node apply-india.js --top=12
 */

const fs = require('fs');
const path = require('path');

const ARGS = process.argv.slice(2);
const argVal = (k, d) => {
  const a = ARGS.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const TOP = parseInt(argVal('top', '10'), 10);

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const ME = {
  name: 'Divyanshu Vaibhav',
  email: 'divaibhavyanshu@gmail.com',
  phone: '+91-9576671336',
  portfolio: 'vritravaibhav.github.io/portfolio',
  github: 'github.com/vritravaibhav',
  linkedin: 'linkedin.com/in/divyanshu-vaibhav',
  degree: 'B.E. Electronics & Communication, Panjab University (2020–2024)',
  current: 'Software Engineer, Longfloat Information Technology Pvt. Ltd. (Dubai) — Jan 2026–present',
  startedWorking: '2024-03',
  location: 'India',
  noticePeriod: '30 days',
  workAuth: 'Indian citizen — no sponsorship needed to work in India',
};

const yearsExp = (() => {
  const [y, m] = ME.startedWorking.split('-').map(Number);
  const months = (new Date().getFullYear() - y) * 12 + (new Date().getMonth() + 1 - m);
  return (months / 12).toFixed(1);
})();

/* Each claim is checkable against the resume. `when` decides which ones a given
 * posting actually earns — a cover note that lists everything says nothing. */
const EVIDENCE = [
  { k: 'flutter', when: /\b(flutter|dart)\b/i, line: 'Shipped 9+ production Flutter apps and led a 5-person team on two of them (Uber/Rapido-style rider and captain apps), taking the crash-free rate from 67% to 94%.' },
  { k: 'spring', when: /\b(spring\s?boot|spring|java|hibernate|jpa|microservice)\b/i, line: 'Build Spring Boot REST microservices day to day — Spring Data JPA/Hibernate, JWT auth via Spring Security, Flyway migrations, Bean Validation, JUnit 5 + Mockito, Swagger/OpenAPI, Docker.' },
  { k: 'backend', when: /\b(rest\s?api|backend|server[\s-]?side|api design)\b/i, line: 'Designed a ride-hailing backend end to end — trip lifecycle, fare calculation and driver–rider matching on a Controller–Service–Repository layering.' },
  { k: 'db', when: /\b(sql|mysql|postgres|database|query|index|mongo|redis)\b/i, line: 'Tuned JPA/MySQL indexing and query design for low-latency geo lookups, and removed N+1 patterns that were dominating matching latency under load.' },
  { k: 'firebase', when: /\b(firebase|firestore|fcm|push|crashlytics|remote config)\b/i, line: 'Firebase in production: Firestore, FCM campaigns, Crashlytics, Remote Config and A/B testing — used Remote Config to decouple feature launches from store releases.' },
  { k: 'native', when: /\b(android|kotlin|ndk|jni|\bios\b|swift|jetpack|mobile app)\b/i, line: 'Wrote Android native where it mattered — NDK/JNI bridges and hardware-accelerated rendering that cut UI frame drops by 40%, plus 7+ native plugins for battery, overlay and geolocation.' },
  { k: 'maps', when: /\b(map|location|geo|gps|routing|logistics|delivery|fleet)\b/i, line: 'Built a Google Maps routing engine with a server-side tile cache that cut map API spend 85% and total infra cost more than 6×.' },
  { k: 'realtime', when: /\b(websocket|socket|real[\s-]?time|chat|stomp|webrtc|streaming)\b/i, line: 'Real-time systems: Spring Boot WebSocket/STOMP chat with persistence and read receipts, and WebRTC P2P audio/video with ICE/STUN/TURN signalling.' },
  { k: 'ai', when: /\b(ai|ml|llm|gpt|openai|genai|agent|nlp)\b/i, line: 'Shipped LLM-backed features — a multi-agent email authoring pipeline and an AI advisor that reads campaign engagement and recommends next actions.' },
  { k: 'payments', when: /\b(payment|stripe|razorpay|billing|checkout|fintech|woocommerce)\b/i, line: 'Integrated Stripe payments and 130+ WooCommerce REST endpoints inside Flutter clients.' },
  { k: 'testing', when: /\b(test|qa|automation|junit|selenium|quality)\b/i, line: 'Test discipline: JUnit 5 and Mockito unit/integration suites, plus Crashlytics-driven stability work that moved crash-free rate 27 points.' },
  { k: 'devops', when: /\b(docker|kubernetes|ci\/cd|jenkins|aws|cloud|deploy)\b/i, line: 'Containerised services with Docker for reproducible environments and ran the deploy path for the services I own.' },
];

const CLOSED = '\u0000CLOSED';

/* Several of these boards render the posting client-side, so fetching the job
 * URL returns an empty shell and the note falls back to generic. Where the
 * board has an API that already carries the description, read that instead. */
async function fetchViaApi(url) {
  const json = async (u) => {
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 20000);
      const r = await fetch(u, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: c.signal });
      const d = r.ok ? await r.json() : null;
      clearTimeout(t);
      return d;
    } catch {
      return null;
    }
  };

  // Lever: /<token>/<uuid>  ->  postings API carries the full description
  let m = url.match(/jobs\.lever\.co\/([^/]+)\/([0-9a-f-]{36})/i);
  if (m) {
    const d = await json(`https://api.lever.co/v0/postings/${m[1]}?mode=json`);
    if (Array.isArray(d) && d.length) {
      const hit = d.find((p) => p.id === m[2]);
      if (hit) return strip([hit.descriptionPlain || hit.description, ...(hit.lists || []).map((l) => `${l.text} ${l.content}`)].join(' '));
      // the board reads fine but this posting is no longer on it — it closed
      // between the sweep and now. Say so rather than writing a note for a
      // role that cannot be applied to.
      return CLOSED;
    }
  }

  // CVViz: job pages are JS-only, the employer feed has jobdescription
  m = url.match(/jobs\.cvviz\.com\/([^/]+)\/job_(\d+)/i);
  if (m) {
    const cfg = require('./companies.js').find((c) => c.ats && c.ats.type === 'cvviz' && c.ats.slug === m[1]);
    const emp = cfg && cfg.ats.token;
    if (emp) {
      const d = await json(`https://jobs.cvviz.com/api/career/employers/${emp}/jobs`);
      const arr = (d && d.data) || [];
      const hit = arr.find((x) => String(x.id) === m[2]);
      if (hit) return strip(hit.jobdescription || hit.title);
      if (arr.length) return CLOSED;
    }
  }

  // Keka
  m = url.match(/https:\/\/([^.]+)\.keka\.com\/careers\/jobdetails\/(\d+)/i);
  if (m) {
    const d = await json(`https://${m[1]}.keka.com/careers/api/jobs/default/active`);
    const arr = Array.isArray(d) ? d : (d && d.data) || [];
    const hit = arr.find((x) => String(x.id) === m[2]);
    if (hit) return strip(hit.description || hit.excerpt || hit.title);
    if (arr.length) return CLOSED;
  }

  // Greenhouse embedded on a company page: ?gh_jid=NNN
  m = url.match(/gh_jid=(\d+)/);
  if (m) {
    const tok = (url.match(/https?:\/\/(?:www\.)?([^./]+)\./) || [])[1];
    if (tok) {
      const d = await json(`https://boards-api.greenhouse.io/v1/boards/${tok}/jobs/${m[1]}`);
      if (d && d.content) return strip(d.content);
    }
  }
  return '';
}

async function fetchText(url) {
  const viaApi = await fetchViaApi(url);
  if (viaApi === CLOSED) return { ok: false, closed: true, text: '' };
  if (viaApi && viaApi.length > 300) return { ok: true, text: viaApi };
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 25000);
    const r = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: c.signal });
    const h = await r.text();
    clearTimeout(t);
    const ld = h.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/i);
    if (ld) {
      try {
        const j = JSON.parse(ld[1]);
        const node = Array.isArray(j) ? j.find((x) => x['@type'] === 'JobPosting') : j;
        if (node && node.description) return { ok: true, text: strip(node.description) };
      } catch {}
    }
    return { ok: r.ok, text: strip(h) };
  } catch (e) {
    return { ok: false, text: '', err: String(e.message || e) };
  }
}

const strip = (s = '') =>
  String(s)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/\s+/g, ' ')
    .trim();

/* Pull the phrases the posting itself uses, so the note can quote them back
 * rather than describing the candidate in a vacuum. */
function asks(text) {
  const out = [];
  const t = text.toLowerCase();
  const probes = [
    ['Flutter', /\bflutter\b/],
    ['Dart', /\bdart\b/],
    ['Spring Boot', /\bspring ?boot\b/],
    ['Java', /\bjava\b(?!script)/],
    ['REST APIs', /\brest(ful)? api/],
    ['microservices', /\bmicroservice/],
    ['MySQL/SQL', /\b(mysql|postgres|sql)\b/],
    ['MongoDB', /\bmongo/],
    ['Redis', /\bredis\b/],
    ['Firebase', /\bfirebase|firestore/],
    ['Android/Kotlin', /\b(android|kotlin)\b/],
    ['iOS/Swift', /\b(ios|swift)\b/],
    ['Node.js', /\bnode\.?js\b/],
    ['React', /\breact\b/],
    ['Go', /\bgolang\b/],
    ['Python', /\bpython\b/],
    ['Docker', /\bdocker\b/],
    ['AWS/cloud', /\b(aws|gcp|azure|cloud)\b/],
    ['WebSockets', /\bwebsocket/],
    ['CI/CD', /\bci\/cd|jenkins|github actions/],
    ['unit testing', /\b(unit test|junit|pytest|jest)\b/],
  ];
  for (const [label, re] of probes) if (re.test(t)) out.push(label);
  return out;
}

function coverNote(job, text) {
  const hay = `${job.title} ${text}`;
  const ev = EVIDENCE.filter((e) => e.when.test(hay));
  const want = asks(text);
  const overlap = want.filter((w) =>
    /flutter|dart|spring|java|rest|micro|sql|mongo|redis|firebase|android|kotlin|docker|websocket|test/i.test(w)
  );

  const body = ev.slice(0, 4).map((e) => `• ${e.line}`).join('\n');

  return [
    `Hi,`,
    ``,
    `I'd like to apply for ${job.title}${job.company ? ` at ${job.company}` : ''}.`,
    ``,
    `I'm a software engineer with ~${yearsExp} years building exactly this kind of system — currently ${ME.current}. ${
      overlap.length ? `The posting asks for ${overlap.slice(0, 5).join(', ')}; that is the stack I work in daily.` : ''
    }`,
    ``,
    `Most relevant to this role:`,
    body,
    ``,
    `I'm based in India, available on ${ME.noticePeriod} notice, and can share code for any of the above.`,
    ``,
    `Portfolio: ${ME.portfolio}`,
    `GitHub: ${ME.github}   LinkedIn: ${ME.linkedin}`,
    ``,
    `Thanks for your time,`,
    `${ME.name} — ${ME.email} — ${ME.phone}`,
  ].join('\n');
}

const STD_ANSWERS = [
  ['Full name', ME.name],
  ['Email', ME.email],
  ['Phone', ME.phone],
  ['Current location', 'India'],
  ['Willing to relocate', 'Yes, within India; open to hybrid/onsite'],
  ['Work authorisation', ME.workAuth],
  ['Notice period', ME.noticePeriod],
  ['Total experience', `~${yearsExp} years (since Mar 2024)`],
  ['Current company', 'Longfloat Information Technology Pvt. Ltd. (Dubai)'],
  ['Current title', 'Software Engineer'],
  ['Highest education', ME.degree],
  ['Portfolio', ME.portfolio],
  ['GitHub', ME.github],
  ['LinkedIn', ME.linkedin],
  ['Expected CTC', '(decide per role — leave blank or say "open, aligned to market for the level")'],
];

(async () => {
  const R = JSON.parse(fs.readFileSync(path.join(__dirname, 'careerv1.results.json'), 'utf8'));
  const rows = [];
  for (const r of R)
    for (const j of r.jobs)
      if (j.india && j.isEng && !j.senior && (j.expFits2 || !j.exp.length) && j.url)
        rows.push({ ...j, company: r.company, source: r.source });

  // one per company+title, best first
  const seen = new Set();
  const picks = rows
    .sort((a, b) => b.score - a.score)
    .filter((j) => {
      const k = `${j.company}|${j.title}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, TOP);

  console.log(`Preparing ${picks.length} applications (fetching each posting)…\n`);

  const out = [];
  for (const j of picks) {
    const got = await fetchText(j.url);
    const text = got.text || '';
    j._asks = asks(text);
    j._note = coverNote(j, text);
    j._fetched = got.ok && text.length > 300;
    j._closed = Boolean(got.closed);
    out.push(j);
    console.log(
      `  ${j.company.padEnd(22)} ${j.title.slice(0, 44).padEnd(46)} ` +
        (j._closed ? 'CLOSED — no longer on the board' : j._fetched ? `${j._asks.length} reqs read` : 'not readable — generic note')
    );
  }

  const L = [];
  L.push('='.repeat(78));
  L.push('INDIA APPLICATION PACK — top roles from careerv1.txt');
  L.push(`${ME.name}  |  ${ME.email}  |  ${ME.phone}`);
  L.push(`Generated ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`);
  L.push('='.repeat(78));
  L.push('');
  L.push('These are sent by hand, not submitted automatically: most of these boards');
  L.push('want an account per employer, and a bot-flagged address on Greenhouse or');
  L.push('Lever follows you across most of tech hiring. Everything slow is done for');
  L.push('you — the posting has been read and the note written against it.');
  L.push('');
  L.push('-'.repeat(78));
  L.push('ANSWERS EVERY FORM ASKS FOR');
  L.push('-'.repeat(78));
  for (const [q, a] of STD_ANSWERS) L.push(`  ${q.padEnd(22)}: ${a}`);
  L.push('');

  out.forEach((j, i) => {
    L.push('#'.repeat(78));
    L.push(`# ${i + 1}. ${j.company} — ${j.title}`);
    L.push('#'.repeat(78));
    if (j._closed) L.push('  !! THIS POSTING HAS CLOSED since the sweep — skip it.');
    L.push(`  apply at : ${j.url}`);
    L.push(`  board    : ${j.source}`);
    L.push(`  location : ${j.location || 'India'}`);
    L.push(`  exp asked: ${j.exp && j.exp.length ? j.exp.map(([a, b]) => `${a}-${b}y`).join(' / ') : 'not stated'}`);
    if (j._asks.length) L.push(`  they want: ${j._asks.join(', ')}`);
    L.push('');
    if (!j._closed) {
      L.push('  ---- cover note ----');
      j._note.split('\n').forEach((l) => L.push(`  ${l}`));
    }
    L.push('');
  });

  fs.writeFileSync(path.join(__dirname, 'apply-india.txt'), L.join('\n'));
  console.log(`\nWrote apply-india.txt (${out.length} roles)`);
})();
