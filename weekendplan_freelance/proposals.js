#!/usr/bin/env node
/*
 * proposals.js — draft a bid proposal for each gig in the shortlist.
 *
 * NOT the same job as w/apply-india.js. A job cover letter can open with the
 * candidate ("I'd like to apply for X"); a freelance client is skimming twenty
 * bids and stops reading anything that opens that way. So each proposal opens
 * on what THEY asked for, then offers only the evidence that gig earns.
 *
 * What it deliberately does NOT do is invent a project-specific insight. It
 * cannot know one, and a manufactured line reads as template -- which wastes a
 * bid. Instead it leaves a marked slot for the single human sentence that wins
 * the bid, and quotes the client's own words underneath so writing it does not
 * mean reopening the posting.
 *
 * Everything claimed here is checkable against the resume — the `when` test on
 * each evidence line decides which claims a given gig actually earns. A
 * proposal that lists every skill says nothing.
 *
 * Deliberately drafts rather than sends. Bids are the scarce resource
 * (Freelancer free tier = 6/month), and a templated-looking bid wastes one.
 * These are meant to be skimmed, edited in a sentence or two, and pasted.
 *
 *   node weekendplan_freelance/proposals.js            # top 20 of 1-bid-now
 *   node weekendplan_freelance/proposals.js --top=40
 *   node weekendplan_freelance/proposals.js --from=2-worth-a-look
 */

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const ARGS = process.argv.slice(2);
const argVal = (k, d) => {
  const a = ARGS.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const TOP = parseInt(argVal('top', '20'), 10);
const FROM = argVal('from', '1-bid-now');

const ME = {
  name: 'Divyanshu Vaibhav',
  email: 'divaibhavyanshu@gmail.com',
  phone: '+91-9576671336',
  portfolio: 'vritravaibhav.github.io/portfolio',
  github: 'github.com/vritravaibhav',
  years: '2.4',
};

/* Same proof points as the job pack, phrased for a client buying an outcome
 * rather than a hiring manager filling a seat. */
const EVIDENCE = [
  { when: /\b(flutter|dart|cross[- ]?platform)\b/i, line: 'Shipped 9+ production Flutter apps, including Uber/Rapido-style rider and captain apps — took one from a 67% to a 94% crash-free rate.' },
  { when: /\b(android|kotlin|native|ndk|jni)\b/i, line: 'Android native where it earns its keep: NDK/JNI bridges and hardware-accelerated rendering that cut frame drops 40%, plus 7+ native plugins (battery, overlay, geolocation).' },
  { when: /\b(ios|swift|app ?store)\b/i, line: 'Shipped the same Flutter codebases to iOS and through App Store review.' },
  { when: /\b(spring|java|backend|rest|api|microservice)\b/i, line: 'Spring Boot REST services day to day — JPA/Hibernate, JWT auth, Flyway, JUnit 5 + Mockito, Swagger, Docker.' },
  { when: /\b(firebase|firestore|fcm|push|crashlytics)\b/i, line: 'Firebase in production: Firestore, FCM campaigns, Crashlytics, Remote Config — shipping features without a store release.' },
  { when: /\b(map|location|gps|geo|track|delivery|logistics|fleet|ride)\b/i, line: 'Built a Maps routing engine with a server-side tile cache that cut map API spend 85%.' },
  { when: /\b(payment|razorpay|stripe|checkout|billing|subscription|in[- ]app purchase)\b/i, line: 'Payments integrated end to end — Stripe, in-app purchases, and 130+ WooCommerce REST endpoints inside Flutter clients.' },
  { when: /\b(chat|socket|real[- ]?time|webrtc|video|call|stream)\b/i, line: 'Real-time: WebSocket/STOMP chat with persistence and read receipts, and WebRTC audio/video with ICE/STUN/TURN signalling.' },
  { when: /\b(sql|mysql|postgres|mongo|database|redis)\b/i, line: 'Schema and query work — JPA/MySQL index tuning and removing N+1 patterns that dominated latency under load.' },
  { when: /\b(ai|ml|llm|gpt|openai|chatbot|agent)\b/i, line: 'LLM features in production — a multi-agent authoring pipeline and an advisor that reads engagement data and recommends next actions.' },
  { when: /\b(ecommerce|e-commerce|marketplace|shop|store|cart)\b/i, line: 'Marketplace apps end to end: catalogue, cart, payments and order lifecycle.' },
  { when: /\b(admin|dashboard|panel|cms|erp)\b/i, line: 'Built the admin side too — dashboards and operator panels over the same APIs.' },
];

/* What the gig is actually asking for, in the client's own words where possible. */
const ASK_TERMS = [
  ['Flutter', /\bflutter\b/i], ['Dart', /\bdart\b/i], ['Android', /\bandroid|kotlin\b/i],
  ['iOS', /\bios|swift\b/i], ['Java/Spring', /\bjava|spring\b/i], ['REST APIs', /\brest|api\b/i],
  ['Firebase', /\bfirebase|firestore\b/i], ['payments', /\bpayment|stripe|razorpay|checkout\b/i],
  ['maps/GPS', /\bmap|gps|location|track\b/i], ['real-time', /\bchat|socket|real[- ]?time|webrtc\b/i],
  ['database', /\bsql|mysql|postgres|mongo\b/i], ['AI/LLM', /\bai\b|\bml\b|llm|gpt|chatbot/i],
  ['admin panel', /\badmin|dashboard|cms\b/i], ['UI/UX', /\bui\/?ux|design|figma\b/i],
];

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function asks(gig) {
  const hay = `${gig.title || ''} ${[].concat(gig.skills || []).join(' ')} ${gig.text || ''}`;
  return ASK_TERMS.filter(([, re]) => re.test(hay)).map(([label]) => label);
}

/* One or two sentences that prove the posting was read, not skimmed. Uses the
 * client's own first substantive sentence rather than paraphrasing it. */
function theirBrief(gig) {
  const t = clean(gig.text).replace(/^[*#\s]+/, '');
  const sentences = t.split(/(?<=[.!?])\s+/).filter((s) => s.length > 40);
  return sentences.slice(0, 2).join(' ').slice(0, 260);
}

function proposal(gig) {
  const want = asks(gig);
  const hay = `${gig.title || ''} ${[].concat(gig.skills || []).join(' ')} ${gig.text || ''}`;
  const proof = EVIDENCE.filter((e) => e.when.test(hay)).slice(0, 3).map((e) => e.line);
  const L = [];

  L.push('Hi,');
  L.push('');
  /*
   * The opener must not manufacture insight. An earlier version wrote "the part
   * that usually decides whether it works is getting X right early" — which is
   * filler, and on a single-skill gig it degenerated into "you're after Flutter
   * ... getting Flutter right early". A client reading twenty bids spots that
   * instantly, and a template-looking bid wastes one of six monthly bids.
   *
   * So state only what is actually known: what they asked for, and that it has
   * been built before. The one line worth personalising is left for the human —
   * marked, because a real sentence about THEIR project is what wins the bid and
   * this script cannot honestly write it.
   */
  L.push(`On your ${gig.title.replace(/\.$/, '')} — you're after ${want.slice(0, 3).join(', ') || 'this build'}. I've shipped that in production, not just used it.`);
  L.push('');
  L.push('  [one line here about THEIR project — the single highest-value edit you');
  L.push('   can make. What they wrote is quoted below so you do not have to reopen');
  L.push('   the posting.]');
  L.push('');
  if (proof.length) {
    L.push("Closest work I've done to it:");
    proof.forEach((p) => L.push(`• ${p}`));
    L.push('');
  }
  L.push(
    `I'm a software engineer with ~${ME.years} years on exactly this stack, based in India so there's timezone overlap with most clients. Happy to start with a short paid milestone so you can see the code before committing to the whole scope.`,
  );
  L.push('');
  L.push(`Portfolio: ${ME.portfolio}   GitHub: ${ME.github}`);
  L.push(`${ME.name} — ${ME.email}`);
  return L.join('\n');
}

function main() {
  const src = path.join(DIR, FROM, 'gigs.json');
  if (!fs.existsSync(src)) {
    console.error(`No shortlist at ${src}. Run: node weekendplan_freelance/build.js`);
    process.exit(1);
  }
  const gigs = JSON.parse(fs.readFileSync(src, 'utf8')).slice(0, TOP);

  const L = [];
  const bar = '='.repeat(78);
  L.push(bar);
  L.push(`FREELANCE PROPOSAL PACK — top ${gigs.length} of ${FROM}`);
  L.push(`${ME.name}  |  ${ME.email}  |  ${ME.phone}`);
  L.push(`Generated ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`);
  L.push(bar);
  L.push('');
  L.push('Drafts, not sends. Each one is written against that specific gig — read');
  L.push('it, change a sentence so it sounds like you, then paste. A bid that reads');
  L.push('like a template wastes one of six free bids a month.');
  L.push('');
  L.push('Slots are spread across platforms on purpose: a Freelancer bid is the');
  L.push('scarce one, so if the work is reachable on PeoplePerHour, Twine or');
  L.push('Freelancermap, send the free proposal there first.');
  L.push('');

  gigs.forEach((g, i) => {
    L.push('#'.repeat(78));
    L.push(`# ${i + 1}. ${g.title}`);
    L.push('#'.repeat(78));
    L.push(`  bid at   : ${g.url}`);
    L.push(`  platform : ${g.source}${g.posted ? '   posted ' + String(g.posted).slice(0, 10) : ''}`);
    if (g.budget) L.push(`  budget   : ${typeof g.budget === 'string' ? g.budget : JSON.stringify(g.budget)}`);
    const want = asks(g);
    if (want.length) L.push(`  they want: ${want.join(', ')}`);
    const brief = theirBrief(g);
    if (brief) {
      L.push('');
      L.push('  ---- what they wrote ----');
      brief.replace(/(.{1,72})(\s|$)/g, '$1\n').split('\n').filter(Boolean).forEach((x) => L.push('  | ' + x.trim()));
    }
    L.push('');
    L.push('  ---- proposal ----');
    proposal(g).split('\n').forEach((line) => L.push('  ' + line));
    L.push('');
  });

  const out = path.join(DIR, FROM, 'proposals.txt');
  fs.writeFileSync(out, L.join('\n') + '\n');
  console.log(`Wrote ${path.relative(path.dirname(DIR), out)} (${gigs.length} proposals)`);
}

main();
