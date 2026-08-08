/*
 * sites/twine.js — Twine (https://www.twine.net/jobs)
 *
 * WHAT THIS SOURCE IS
 * -------------------
 * Twine is a marketplace where clients post a brief and freelancers pitch for
 * it. Twine's own vocabulary for a job posting is a "brief", and pitching is
 * bidding — so this is kind: 'gig'.
 *
 * Twine started as a creative marketplace (music, video, design) and the bare
 * /jobs firehose is still dominated by voice actors and photographers. That is
 * why this adapter never touches /jobs itself and instead sweeps the ROLE pages
 * under App & Web Development. Those are genuinely filtered — /jobs/back-end-
 * developers returns Golang and C#/.NET backend briefs, not photographers.
 *
 * HOW WE READ IT — AND WHY THIS IS NOT A GUESSED ENDPOINT
 * -------------------------------------------------------
 * Every /jobs page is server-rendered and ships its Redux store inline:
 *
 *     window.__data = { …, entities: { briefs: { "<id>": {…} } }, … }
 *
 * VERIFIED LIVE ON 2026-08-08 across 16 role/country URLs: all HTTP 200, all
 * carrying exactly 10 fully-formed briefs (160 unique after de-duplication, 126
 * of them active). Each brief is the complete posting — text, spec, budget,
 * currency, location, remote, role, timestamp, expires_at, status, links.main
 * and the pitch count. Nothing is scraped out of rendered markup and no
 * per-posting request is needed.
 *
 * There IS a /api/ behind the site (the store contains a failed /api/me call for
 * the logged-out visitor), but it is the authenticated app's API and is not used
 * here. Guessing at it would be exactly the "wrong endpoint that returns junk"
 * failure this sweep is meant to avoid.
 *
 * ROBOTS.TXT
 * ----------
 * https://www.twine.net/robots.txt disallows /browse, /hire, /v2find, /rss, /u,
 * /claim, /download, /thumb, /image, /js, /css, /font, /img, /swf. It does NOT
 * disallow /jobs or /projects. This adapter reads only /jobs paths, and never
 * follows through to a /projects detail page because it does not need to — the
 * full `spec` body is already in the listing store.
 *
 * NO PAGINATION — MEASURED, NOT ASSUMED
 * -------------------------------------
 * `?page=2`, `?p=2` and `?offset=10` were all tried against
 * /jobs/developers and all three returned the IDENTICAL ten ids as the bare
 * URL — the server ignores them, the real list is loaded by client-side
 * infinite scroll. `/jobs/developers/2` is a 404. So: exactly 10 briefs per
 * URL, and breadth comes from sweeping many role slugs rather than from paging.
 * Do not "add pagination"; there is none to add, and a page param that silently
 * returns page 1 would just triple the duplicate count.
 *
 * TWO KINDS OF BRIEF — THE DISTINCTION THAT MATTERS
 * -------------------------------------------------
 * `external` was true on 93 of the 160 sampled briefs. Those are listings Twine
 * imported from outside job boards; they carry an `external_url` pointing at
 * (e.g.) simplyhired, and applying happens off-platform. `external: false` is a
 * brief posted directly on Twine by a client, which is the one you actually
 * pitch for — Twine's UI badges these "Easy Apply". Both are emitted, tagged
 * with `twineFeed`, and typed differently so the report can separate "real
 * pitchable gig" from "aggregated listing".
 */

const { get, strip, rec } = require('../sources.js');

const BASE = 'https://www.twine.net/jobs';

/*
 * Role slugs to sweep, using Twine's own plural slugs (taken from the site's
 * `roleSkills['App & Web Development']` taxonomy in the same store, so these are
 * not invented). Each is 10 fresh briefs.
 *
 * The bare /jobs firehose is deliberately absent — see the header. It is the
 * only URL here that is not stack-filtered, and its ten slots go to voice
 * actors and photographers.
 */
const ROLES = [
  'developers',
  'app-developers',
  'back-end-developers',
  'full-stack-developers',
  'software-engineers',
  'programmers',
  'database-developers',
  'cloud-developers',
  'devops-developers',
  'qa-engineers',
  'web-developers',
  'ecommerce-developers',
  'game-developers',
];

/*
 * `/jobs/<role>/in/<country>` is a real server-side filter (verified: it changes
 * both the ids and the reported total — 3416 briefs for `developers` vs 154 for
 * `developers/in/india`). Sweeping a few India-scoped pages surfaces local
 * clients that the global recency ordering would never reach.
 */
const INDIA_ROLES = [
  'developers',
  'app-developers',
  'back-end-developers',
  'full-stack-developers',
];

/* Twine sits behind Cloudflare and did not complain during testing, but ~17
 * requests in a burst is still worth spacing out. Cheap insurance. */
const PACE_MS = 400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ helpers */

function s(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    const inner = v.name || v.title || v.label || v.value;
    return typeof inner === 'string' ? inner.trim() : '';
  }
  return '';
}

/*
 * Pull `window.__data = {...}` out of the HTML.
 *
 * Same reasoning as the PeoplePerHour adapter: the blob is a large JSON document
 * whose string values contain braces and `</script>`-shaped text, so a regex
 * truncates in the wrong place. Walk the characters counting brace depth,
 * respecting string literals and escapes.
 */
function extractData(html) {
  const KEY = 'window.__data=';
  const src = String(html || '');

  let start = src.indexOf(KEY);
  if (start < 0) {
    const m = src.match(/window\.__data\s*=\s*\{/);
    if (!m) return null;
    start = m.index + m[0].length - 1;
  } else {
    start += KEY.length;
  }

  const brace = src.indexOf('{', start);
  if (brace < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;

  for (let i = brace; i < src.length; i++) {
    const c = src[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) return null;

  try {
    return JSON.parse(src.slice(brace, end + 1));
  } catch (e) {
    return null;
  }
}

/*
 * Is this brief still worth pitching for?
 *
 * The store is NOT pre-filtered: of 160 sampled briefs, 126 were 'active', 31
 * 'expired' and 3 'inactive'. `expires_at` is checked as well as `status`
 * because a brief can pass its expiry before the status field is swept — and a
 * dead brief looks completely normal otherwise, which is exactly how junk gets
 * into an apply queue.
 */
function isLive(b, now) {
  if (b.active !== true) return false;
  if (s(b.status).toLowerCase() !== 'active') return false;
  if (s(b.deleted_at) || s(b.blocked_at)) return false;
  const exp = s(b.expires_at);
  if (exp) {
    const d = new Date(exp);
    if (!Number.isNaN(d.getTime()) && d.getTime() < now.getTime()) return false;
  }
  return true;
}

/*
 * Money.
 *
 * `budget` is in MINOR UNITS (cents), not whole currency. VERIFIED against the
 * live project pages: budget 1000000 renders as "$10,000", 500000 as "$5,000",
 * 648000 as "$6,480". Emitting the raw number would overstate every budget by
 * 100x and would make a $600 job look like a $60,000 one — the single most
 * damaging thing this file could get wrong.
 *
 * `-1` is Twine's sentinel for "Negotiable" (it was the value on 154 of the 160
 * sampled briefs), NOT a missing value and NOT a real amount.
 *
 * `amount` is the same figure less Twine's 20% commission — i.e. what the
 * freelancer receives. The client-facing `budget` is what is emitted, because
 * that is the number shown on the posting, but the take-home is kept as an
 * extra so the report can show both.
 */
function money(minorUnits, currency) {
  const n = Number(minorUnits);
  if (!Number.isFinite(n) || n <= 0) return '';
  const cur = s(currency).toUpperCase() || 'USD';
  const major = n / 100;
  return `${major.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${cur}`;
}

function budgetOf(b) {
  const v = money(b.budget, b.currency);
  if (!v) return 'Negotiable';
  return b.day_rate === true ? `${v}/day` : `${v} fixed`;
}

function isoDate(v) {
  const str = s(v);
  if (!str) return '';
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

/*
 * India eligibility.
 *
 * Twine's own filter copy defines the semantics: "Remote Jobs — Jobs with no
 * specified location, open to the global network". So `remote === true` means
 * unrestricted, and a named `location` means the client wants someone there.
 * That is a stronger signal than prose-guessing, but it is still Twine's
 * geography model rather than an explicit eligibility allow-list, so it is
 * marked `indiaOkInferred` — do not treat it like PeoplePerHour's
 * `where_can_bid`.
 */
const INDIA_RE = /\bindia\b|\bindian\b/i;

function indiaOkOf(b) {
  if (b.remote === true) return true;
  const loc = s(b.location);
  if (!loc) return true;              // no stated location == not restricted
  return INDIA_RE.test(loc);
}

const STACK = [
  ['java', /\bjava\b(?!script)/i],
  ['spring-boot', /spring[\s-]?boot|\bspring\b/i],
  ['microservices', /micro[\s-]?services?/i],
  ['mysql', /\bmysql\b|mariadb/i],
  ['sql', /\bsql\b|postgres|postgresql/i],
  ['docker', /\bdocker\b|kubernetes|\bk8s\b/i],
  ['flutter', /\bflutter\b|flutterflow|\bdart\b/i],
  ['android', /\bandroid\b|\bkotlin\b/i],
  ['ndk-jni', /\bndk\b|\bjni\b|native\s+android/i],
  ['webrtc', /\bwebrtc\b|livekit|\bsip\b|\bsfu\b/i],
  ['firebase', /\bfirebase\b|firestore/i],
];

function tagStack(text) {
  const hay = String(text || '');
  return STACK.filter(([, re]) => re.test(hay)).map(([tag]) => tag);
}

/* ------------------------------------------------------------ record mapping */

function mapBrief(b, now) {
  if (!b || typeof b !== 'object') return null;
  if (!isLive(b, now)) return null;   // see isLive — not optional

  /* Twine calls the headline `text` and the body `spec`. Getting these the wrong
   * way round would emit a 3 KB description as the title. */
  const title = s(b.text);
  if (!title) return null;

  const links = b.links && typeof b.links === 'object' ? b.links : {};
  const url = s(links.main) ||
    (s(links.main_relative) ? `https://www.twine.net${s(links.main_relative)}` : '');
  if (!url) return null;

  const spec = s(b.spec);
  const role = s(b.role);
  const external = b.external === true;
  const remote = b.remote === true;
  const loc = s(b.location);

  /* `roles` (plural) is the full role list; `skill` is usually empty on the
   * listing store. Both are folded in so a brief tagged with several roles keeps
   * them all. */
  const roles = Array.isArray(b.roles)
    ? b.roles.map(s).filter(Boolean)
    : [];
  const skills = [...new Set([role, ...roles, s(b.skill)].filter(Boolean))].slice(0, 20);

  const pitches = Number(b.num_of_pitches);
  const takeHome = money(b.amount, b.currency);

  const text = [
    title,
    spec,
    role ? `Role: ${role}` : '',
    remote ? 'Remote (open to the global network)' : (loc ? `Location: ${loc}` : ''),
    external
      ? `Aggregated listing — apply off-platform${s(b.external_url) ? ` at ${s(b.external_url)}` : ''}`
      : 'Posted directly on Twine (pitch on-platform)',
    takeHome ? `Freelancer take-home after Twine commission: ${takeHome}` : '',
    Number.isFinite(pitches) && pitches > 0 ? `Pitches so far: ${pitches}` : '',
  ].filter(Boolean).join('. ');

  const out = rec({
    title,
    /* Briefs carry a numeric `user` id, not a client name — the poster's display
     * name lives on a separate entity that the listing store does not populate.
     * Say so explicitly rather than rendering a blank that reads as a scrape
     * failure. Aggregated listings usually name their company in the title
     * ("GeekSoft Consulting - Java Developer"). */
    company: external ? 'See listing (aggregated by Twine)' : 'Private client (Twine)',
    url,
    text,
    skills,
    location: remote ? 'Remote (worldwide)' : (loc || 'Unspecified'),
    budget: budgetOf(b),
    /* A directly-posted brief is contract work you pitch for. An aggregated one
     * is a third-party listing that may well be salaried, so it is not claimed
     * as contract. */
    type: external ? 'remote' : 'contract',
    posted: isoDate(b.timestamp) || isoDate(b.approved_at),
  });

  // ---- Twine-specific extras, attached after rec() (rec drops unknown keys) --

  out.indiaOk = indiaOkOf(b);
  out.indiaOkInferred = true;  // Twine geography, not an eligibility allow-list
  out.stack = tagStack(`${title} ${spec} ${skills.join(' ')}`);
  out.id = String(b.id || '');
  /* 'twine' = posted directly, pitchable on-platform (the good stuff).
   * 'external' = imported from another board, apply off-platform. */
  out.twineFeed = external ? 'external' : 'twine';
  out.externalUrl = s(b.external_url);
  out.role = role;
  out.currency = s(b.currency).toUpperCase();
  out.takeHome = takeHome;                       // after Twine's 20% commission
  out.pitches = Number.isFinite(pitches) ? pitches : null;  // competition signal
  out.expires = isoDate(b.expires_at);

  return out;
}

/* ------------------------------------------------------------------ adapter */

module.exports = {
  name: 'twine',
  kind: 'gig', // clients post briefs, freelancers pitch — a real marketplace
  homepage: 'https://www.twine.net/jobs',

  async fetch(opts = {}) {
    const log = typeof opts.log === 'function' ? opts.log : () => {};
    const now = new Date();

    const pages = ROLES.map((r) => ({ label: r, url: `${BASE}/${r}` })).concat(
      INDIA_ROLES.map((r) => ({ label: `${r}@india`, url: `${BASE}/${r}/in/india` }))
    );

    const out = [];
    const seen = new Set();
    let pagesOk = 0;
    let skippedDead = 0;
    let first = true;

    for (const page of pages) {
      if (!first) await sleep(PACE_MS);
      first = false;

      let r;
      try {
        // json:false -> the helper hands back raw HTML on r.text
        r = await get(page.url, { json: false });
      } catch (e) {
        log(`twine: ${page.label} fetch threw: ${e && e.message}`);
        continue;
      }
      if (!r || !r.ok || !r.text) {
        log(`twine: ${page.label} HTTP ${(r && r.status) || 0} — skipped`);
        continue;
      }

      const data = extractData(r.text);
      if (!data) {
        /* If this fires for every page, Twine has stopped inlining its store and
         * this adapter needs revisiting. */
        log(`twine: ${page.label} — no parseable window.__data`);
        continue;
      }

      const briefs =
        data.entities && data.entities.briefs && typeof data.entities.briefs === 'object'
          ? data.entities.briefs
          : null;
      if (!briefs) {
        log(`twine: ${page.label} — store parsed but entities.briefs missing`);
        continue;
      }

      pagesOk++;
      const ids = Object.keys(briefs);
      let added = 0;

      for (const id of ids) {
        // Per-record try/catch: one malformed brief must not lose the batch.
        try {
          const mapped = mapBrief(briefs[id], now);
          if (!mapped) { skippedDead++; continue; }
          const key = mapped.id || mapped.url;
          if (!key || seen.has(key)) continue;
          seen.add(key);
          out.push(mapped);
          added++;
        } catch (e) {
          log(`twine: skipped a bad record — ${e && e.message}`);
        }
      }

      log(`twine: ${page.label} -> ${ids.length} in store, ${added} new live briefs`);
    }

    if (skippedDead) {
      log(`twine: dropped ${skippedDead} expired/inactive briefs`);
    }

    /* Every page failed => the SOURCE is down, as opposed to "Twine had nothing
     * new in these roles today". */
    if (!pagesOk) return null;
    return out;
  },
};
