#!/usr/bin/env node
/*
 * apply.js — drive Freelancer.com bids with Playwright.
 *
 * Why this shape
 * --------------
 * 505 of the 594 freelance postings are Freelancer.com, i.e. ONE login rather
 * than one account per employer. That is the only part of this pipeline worth
 * automating end to end — the other 89 sit on remote boards that redirect to a
 * different company ATS each, which is the wall ../applytest.js already
 * documented (per-employer signup + CAPTCHA).
 *
 * What actually limits how many you can apply to is not the automation, it is
 * the bid quota: Freelancer sells 50 / 100 / 300 / 1500 bids per month by tier
 * (free accounts get single digits). So the job here is to pick the best N and
 * write a real proposal for each — not to fire at all 505. A generic blast
 * burns the quota, wins nothing, and is what gets accounts actioned.
 *
 * Accordingly this script defaults to PREPARING bids, not sending them: it
 * fills the form and stops so you can read it. Add --submit once you trust it.
 *
 * It drives your real Chrome profile, so you are already logged in and no
 * credentials are handled here.
 *
 * Usage:
 *   node apply.js                      # rank + write apply-queue.txt, no browser
 *   node apply.js --open --max=5       # fill 5 bid forms, pause on each for review
 *   node apply.js --open --max=5 --submit
 *   node apply.js --min-score=70 --stack=flutter
 */

const fs = require('fs');
const path = require('path');

const ARGS = process.argv.slice(2);
const argVal = (k, d) => {
  const a = ARGS.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const OPEN = ARGS.includes('--open');
const SUBMIT = ARGS.includes('--submit');
const MAX = parseInt(argVal('max', '5'), 10);
const MIN_SCORE = parseInt(argVal('min-score', '55'), 10);
/* Budget floor, in INR-equivalent. The median gig on this board tops out at
 * ₹12,500 (~$150) and 128 of 216 INR projects cap under ₹15k — bidding those
 * spends a metered bid on work worth less than a day's rate. Default to the
 * band that is actually worth winning; pass --min-budget=0 to see everything. */
const MIN_BUDGET = parseInt(argVal('min-budget', '75000'), 10);
const FX = { INR: 1, USD: 83, EUR: 90, GBP: 105, AUD: 55, CAD: 61, SGD: 62 };
const STACK = argVal('stack', null);
const HEADLESS = ARGS.includes('--headless');

const DIR = __dirname;
const STATE = path.join(DIR, 'applied.json');

/* ------------------------------------------------------------------ me */
/* Straight from myresume.txt. `evidence` is the bank the proposal draws on:
 * each entry is a concrete, checkable claim, matched to a gig by `when`. */
const ME = {
  name: 'Divyanshu Vaibhav',
  email: 'divaibhavyanshu@gmail.com',
  phone: '+91-9576671336',
  portfolio: 'vritravaibhav.github.io/portfolio',
  github: 'github.com/vritravaibhav',
  yearsExp: 2, // Mar 2024 -> now
  hourlyINR: 1200,
};

const EVIDENCE = [
  {
    when: /\b(flutter|dart)\b/i,
    line: 'I ship Flutter production apps for a living — 9+ released, including two Uber/Rapido-style ride-hailing apps (rider + captain), where I took the crash-free rate from 67% to 94%.',
  },
  {
    when: /\b(spring\s?boot|java|hibernate|jpa|microservice|rest\s?api|backend)\b/i,
    line: 'On the backend I build Spring Boot REST services — Spring Data JPA/Hibernate, JWT auth with Spring Security, Flyway migrations, JUnit/Mockito tests, Swagger docs, Dockerised.',
  },
  {
    when: /\b(firebase|firestore|fcm|push notification|crashlytics|remote config)\b/i,
    line: 'Firebase is day-to-day for me: Firestore, FCM campaigns, Crashlytics, Remote Config and A/B testing — I used Remote Config to decouple feature launches from store releases.',
  },
  {
    when: /\b(webrtc|video call|audio call|voip|streaming|real[\s-]?time)\b/i,
    line: 'I have built WebRTC P2P audio/video end to end — ICE/STUN/TURN with WebSocket signalling — plus WebRTC data-channel file transfer with chunked resume and SHA-256 verification.',
  },
  {
    when: /\b(map|maps|location|gps|geo|tracking|delivery|ride)\b/i,
    line: 'For a live ride-hailing platform I wrote the Google Maps routing engine and a server-side tile cache that cut map API spend by 85%, and tuned MySQL geo queries for low-latency driver matching.',
  },
  {
    when: /\b(payment|stripe|razorpay|checkout|woocommerce|ecommerce|e-commerce|subscription)\b/i,
    line: 'I have integrated Stripe payments and 130+ WooCommerce REST endpoints inside Flutter apps, so the commerce and checkout side is familiar ground.',
  },
  {
    when: /\b(android|kotlin|native|ndk|jni|performance|optimi[sz])\b/i,
    line: 'Where Flutter needs to touch the metal I write Android native — NDK/JNI bridges and hardware-accelerated rendering, which cut UI frame drops by 40% on one product.',
  },
  {
    when: /\b(ai|llm|gpt|openai|chatbot|agent|automation)\b/i,
    line: 'I have shipped LLM-backed features too — a multi-agent email authoring pipeline and an AI advisor that reads campaign engagement and recommends next actions.',
  },
  {
    when: /\b(websocket|socket|chat|messaging|notification)\b/i,
    line: 'Real-time is comfortable: Spring Boot WebSocket/STOMP group chat with persistence, delivery/read receipts and multi-room support.',
  },
];

/* -------------------------------------------------------------- proposal */

function buildProposal(j) {
  const hay = `${j.title} ${j.skills.join(' ')} ${j.text}`;
  const picked = EVIDENCE.filter((e) => e.when.test(hay)).slice(0, 3);
  // never send a bid with nothing specific in it
  if (!picked.length) return null;

  /* The report's stack labels are internal categories ("Other mobile (Android /
   * Kotlin / React Native / iOS)") and must never reach a client. Name the
   * actual technologies the brief mentions instead. */
  const TECH = [
    [/\bflutter\b/i, 'Flutter'],
    [/\bdart\b/i, 'Dart'],
    [/\bspring\s?boot\b/i, 'Spring Boot'],
    [/\bjava\b(?!\s*script)/i, 'Java'],
    [/\bfirebase\b/i, 'Firebase'],
    [/\bfirestore\b/i, 'Firestore'],
    [/\bandroid\b/i, 'Android'],
    [/\bkotlin\b/i, 'Kotlin'],
    [/\bios\b/i, 'iOS'],
    [/\breact\s?native\b/i, 'React Native'],
    [/\bnode\.?js\b/i, 'Node.js'],
    [/\breact\b(?!\s?native)/i, 'React'],
    [/\bwebrtc\b/i, 'WebRTC'],
    [/\bmysql\b/i, 'MySQL'],
    [/\bmongo/i, 'MongoDB'],
  ];
  const named = TECH.filter(([re]) => re.test(hay)).map(([, n]) => n);
  const stackNames = named.length
    ? named.slice(0, 4).join(', ').replace(/, ([^,]*)$/, ' and $1')
    : 'this stack';
  const first = (j.title || '').replace(/\s+/g, ' ').trim();

  const ask = [];
  if (/\bapi\b|backend|server/i.test(hay)) ask.push('which backend you already have (if any), and whether the API is yours or third-party');
  if (/\bios\b|app ?store|play ?store|publish/i.test(hay)) ask.push('whether store publishing is in scope or you handle release');
  if (/\bdesign|figma|ui\/ux|mockup/i.test(hay)) ask.push('whether designs/Figma are ready or need doing');
  if (!ask.length) ask.push('what the deadline looks like and whether there is an existing codebase');

  return [
    `Hi — I read the brief on "${first}".`,
    '',
    picked.map((p) => p.line).join(' '),
    '',
    `That maps directly onto what you are asking for on ${stackNames}. I work as a software engineer on exactly this stack day to day (about ${ME.yearsExp} years, currently building Spring Boot services and Flutter clients in production), so this is not a stretch project for me.`,
    '',
    `Before I quote a firm number I would want to know ${ask[0]}. Happy to start with a short paid milestone so you can judge the work before committing to the whole scope.`,
    '',
    `Portfolio: ${ME.portfolio}`,
    `GitHub: ${ME.github}`,
    '',
    ME.name,
  ].join('\n');
}

/* Bid inside the client's stated range: enough below the top to be credible,
 * never at the floor (bottom-of-range bids read as low quality on Freelancer). */
function bidAmount(j) {
  const m = String(j.budget || '').match(/(\d[\d,]*)\s*-\s*(\d[\d,]*)\s*([A-Z]{3})?/);
  if (!m) return null;
  const lo = +m[1].replace(/,/g, '');
  const hi = +m[2].replace(/,/g, '');
  const cur = m[3] || '';
  if (!(hi > 0)) return null;
  const amount = Math.round(lo + (hi - lo) * 0.55);
  return { amount, currency: cur, lo, hi };
}

function fitScore(j) {
  const hay = `${j.title} ${j.skills.join(' ')} ${j.text}`;
  let s = j.score || 0;
  const ev = EVIDENCE.filter((e) => e.when.test(hay)).length;
  s += ev * 8; // more of my actual experience is relevant
  if (j.stacks.includes('flutter')) s += 12;
  if (j.stacks.includes('springboot')) s += 10;
  if (j.stacks.includes('firebase')) s += 8;
  if (/\bINR\b/.test(j.budget)) s += 6; // Indian client, same timezone and currency
  if (j.expFits2) s += 6;
  if (/\b(10|8|7)\+?\s*(years|yrs)/i.test(hay)) s -= 15; // wants a decade, I have two
  return s;
}

/* ------------------------------------------------------------------ queue */

function loadQueue() {
  const R = JSON.parse(fs.readFileSync(path.join(DIR, 'results.json'), 'utf8'));
  const done = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};

  let rows = R.jobs
    .filter((j) => j.freelance && j.source === 'freelancer.com' && j.url)
    .filter((j) => !STACK || j.stacks.includes(STACK))
    .map((j) => ({ ...j, fit: fitScore(j), proposal: buildProposal(j), bid: bidAmount(j) }))
    .filter((j) => j.proposal) // nothing generic goes out
    .filter((j) => j.fit >= MIN_SCORE)
    .filter((j) => {
      if (!MIN_BUDGET) return true;
      // no stated range is not a reason to drop it — the client may just not
      // have set one, and those are often the larger jobs
      if (!j.bid) return true;
      return j.bid.hi * (FX[j.bid.currency] || 1) >= MIN_BUDGET;
    })
    .filter((j) => !done[j.url]);

  rows.sort((a, b) => b.fit - a.fit);
  return { rows, done };
}

function writeQueue(rows) {
  const L = [];
  L.push('='.repeat(78));
  L.push('FREELANCER.COM BID QUEUE');
  L.push(`Candidate : ${ME.name}   (${ME.email})`);
  L.push(`Generated : ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`);
  L.push('='.repeat(78));
  L.push('');
  L.push(`${rows.length} project(s) ranked by fit to the resume, best first.`);
  L.push('');
  L.push('Bids are metered by your Freelancer membership (50/100/300/1500 per');
  L.push('month by tier), so treat this as a shortlist, not a to-do list. Each');
  L.push('entry has the proposal that would be submitted — read it before sending.');
  L.push('');
  rows.forEach((j, i) => {
    L.push('#'.repeat(78));
    L.push(`# ${i + 1}. ${j.title}`);
    L.push(`# fit ${j.fit}   budget ${j.budget || 'n/a'}   ${j.bid ? `-> bid ${j.bid.amount} ${j.bid.currency}` : '(no range given)'}`);
    L.push(`# stack: ${j.stackLabels.join(' + ') || '—'}${j.india ? '   [INDIA client]' : ''}`);
    L.push(`# ${j.url}`);
    L.push('#'.repeat(78));
    L.push(j.proposal);
    L.push('');
  });
  fs.writeFileSync(path.join(DIR, 'apply-queue.txt'), L.join('\n'));
  fs.writeFileSync(
    path.join(DIR, 'apply-queue.json'),
    JSON.stringify(rows.map((j) => ({ title: j.title, url: j.url, fit: j.fit, budget: j.budget, bid: j.bid, stacks: j.stacks, proposal: j.proposal })), null, 2)
  );
}

/* ---------------------------------------------------------------- browser */

/* Locate the bid form by behaviour rather than by selector.
 *
 * Logged out, a project page has literally zero inputs — the whole form is
 * gated — so these selectors cannot be verified without a session, and
 * Freelancer renames its Angular formcontrolnames between releases anyway.
 * Scoring each visible field on its own attributes survives both. Returns
 * unique CSS paths so the caller can act on them. */
async function findBidForm(page) {
  return page.evaluate(() => {
    const cssPath = (el) => {
      if (el.id) return `#${CSS.escape(el.id)}`;
      const fc = el.getAttribute('formcontrolname');
      if (fc) return `${el.tagName.toLowerCase()}[formcontrolname="${fc}"]`;
      if (el.name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(el.name)}"]`;
      const parent = el.parentElement;
      if (!parent) return el.tagName.toLowerCase();
      const idx = [...parent.children].filter((c) => c.tagName === el.tagName).indexOf(el);
      return `${cssPath(parent)} > ${el.tagName.toLowerCase()}:nth-of-type(${idx + 1})`;
    };
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 20 && r.height > 8 && getComputedStyle(el).visibility !== 'hidden';
    };
    // everything we might match on: own attributes plus nearby label text
    const context = (el) => {
      const own = [el.id, el.name, el.getAttribute('formcontrolname'), el.placeholder, el.getAttribute('aria-label')]
        .filter(Boolean)
        .join(' ');
      const near = (el.closest('label, .form-group, [class*="field"], div') || {}).textContent || '';
      return `${own} ${near.slice(0, 160)}`.toLowerCase();
    };

    /* A logged-out project page still shows a bid-shaped SIGNUP teaser
     * (app-project-view-logged-out-signup-bid-form). Filling that submits a
     * registration, not a bid, so discard anything inside the logged-out shell
     * before scoring. */
    const inSignupShell = (el) => !!el.closest('[class*="logged-out"], [class*="signup"], app-logged-out-shell, app-project-view-logged-out');
    if (document.querySelector('app-logged-out-shell, app-project-view-logged-out'))
      return { amount: null, period: null, body: null, reason: 'logged-out shell — sign in first' };

    const inputs = [...document.querySelectorAll('input')].filter((i) => visible(i) && !inSignupShell(i));
    const areas = [...document.querySelectorAll('textarea')].filter((t) => visible(t) && !inSignupShell(t));

    const amountEl =
      inputs.find((i) => /bid|amount|budget|price|\$|₹/.test(context(i)) && !/period|day|search/.test(context(i))) ||
      inputs.find((i) => i.type === 'number');
    const periodEl = inputs.find((i) => /period|days?|deliver|duration|timeline/.test(context(i)));
    // the proposal box is the largest textarea on the page
    const bodyEl = areas.sort((a, b) => {
      const A = a.getBoundingClientRect();
      const B = b.getBoundingClientRect();
      return B.width * B.height - A.width * A.height;
    })[0];

    return {
      amount: amountEl ? cssPath(amountEl) : null,
      period: periodEl && periodEl !== amountEl ? cssPath(periodEl) : null,
      body: bodyEl ? cssPath(bodyEl) : null,
      reason: inputs.length === 0 ? 'no inputs — not logged in, bidding closed, or already bid' : 'no bid-like field among ' + inputs.length + ' inputs',
    };
  });
}

async function drive(rows) {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    console.error('Playwright is not installed here. Run:  npm i playwright   (or: npx playwright install chromium)');
    process.exit(1);
  }

  // Use the real Chrome profile: you are already signed in, and a logged-in
  // human profile draws far fewer bot challenges than a fresh automation one.
  const userDataDir = path.join(process.env.HOME, 'Library/Application Support/Google/Chrome-playwright-jobs');
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: HEADLESS,
    channel: 'chrome',
    viewport: { width: 1400, height: 950 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto('https://www.freelancer.com/dashboard', { waitUntil: 'domcontentloaded', timeout: 60000 });

  const loggedIn = await page
    .locator('a[href*="/logout"], [data-uitest="user-menu"], app-navigation-user')
    .first()
    .isVisible({ timeout: 8000 })
    .catch(() => false);

  if (!loggedIn) {
    console.log('\n  Not signed in to Freelancer in this profile.');
    console.log('  A browser window is open — log in (and finish any 2FA), then press Enter here.');
    await new Promise((r) => process.stdin.once('data', r));
  }

  const done = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
  let placed = 0;

  for (const j of rows.slice(0, MAX)) {
    console.log(`\n[${placed + 1}/${Math.min(MAX, rows.length)}] ${j.title}`);
    console.log(`    fit ${j.fit}  budget ${j.budget || 'n/a'}  ${j.url}`);
    try {
      await page.goto(j.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(2500);

      // The bid form is gated behind login and Freelancer renames its Angular
      // form controls between releases, so hardcoded selectors rot. Find the
      // fields by what they ARE instead: the numeric input that talks about a
      // bid/amount, the one that talks about days, and the biggest textarea.
      const found = await findBidForm(page);
      if (!found.amount) {
        console.log(`    ! no bid form here (${found.reason}) — skipping`);
        continue;
      }
      if (j.bid) await page.locator(found.amount).fill(String(j.bid.amount));
      if (found.period) await page.locator(found.period).fill('7');
      if (found.body) await page.locator(found.body).fill(j.proposal);
      console.log(`    filled via ${found.amount}${found.body ? ` + ${found.body}` : ''}`);

      if (!SUBMIT) {
        console.log('    form filled — REVIEW MODE (no bid placed). Press Enter for the next one.');
        await new Promise((r) => process.stdin.once('data', r));
        continue;
      }

      const btn = page.locator('button:has-text("Place Bid"), button:has-text("Bid on this project"), button[type="submit"]').first();
      if (!(await btn.isVisible({ timeout: 5000 }).catch(() => false))) {
        console.log('    ! submit button not found — left filled for manual send');
        continue;
      }
      await btn.click();
      await page.waitForTimeout(4000);
      done[j.url] = { at: new Date().toISOString(), title: j.title, bid: j.bid };
      fs.writeFileSync(STATE, JSON.stringify(done, null, 2));
      placed++;
      console.log('    bid placed.');
      await page.waitForTimeout(6000); // don't hammer
    } catch (e) {
      console.log(`    ! ${String(e.message).slice(0, 120)}`);
    }
  }

  console.log(`\n${SUBMIT ? `${placed} bid(s) placed.` : 'Review run complete — nothing submitted.'}`);
  if (!HEADLESS) {
    console.log('Browser left open. Press Enter to close.');
    await new Promise((r) => process.stdin.once('data', r));
  }
  await ctx.close();
}

/* ------------------------------------------------------------------ main */
(async () => {
  const { rows } = loadQueue();
  writeQueue(rows);
  console.log(`Queue: ${rows.length} project(s) at fit >= ${MIN_SCORE}${STACK ? ` [stack=${STACK}]` : ''}`);
  console.log('Wrote apply-queue.txt + apply-queue.json');
  rows.slice(0, 10).forEach((j, i) =>
    console.log(`  ${String(i + 1).padStart(2)}. fit ${String(j.fit).padStart(3)}  ${j.title.slice(0, 52).padEnd(52)} ${j.budget || ''}`)
  );
  if (!OPEN) {
    console.log('\nAdd --open to fill the bid forms in a browser (review mode), then --submit to send.');
    return;
  }
  await drive(rows);
})();
