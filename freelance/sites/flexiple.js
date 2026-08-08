/*
 * sites/flexiple.js — Flexiple (https://flexiple.com/jobs)
 *
 * WHAT THIS SOURCE IS
 * -------------------
 * Flexiple is an India-headquartered vetted freelance-developer network. Unlike
 * a job board, the things listed here are genuinely *projects*: every card
 * carries a Duration ("3-6 months"), an Hours Per Week ("40", "20") and a
 * Client Geography. That is contract work, not a salaried req, which is why
 * this is registered as kind:'gig'.
 *
 * There is NO public API, no RSS, and no __NEXT_DATA__ blob — flexiple.com is a
 * Next.js *App Router* site (streamed RSC; the HTML contains `self.__next_f`
 * chunks, not the classic `__NEXT_DATA__` script). The good news is that the
 * job cards are fully server-rendered into the HTML, so we can read them
 * straight out of the markup without executing any JavaScript.
 *
 * ACCESS IS EXPLICITLY PERMITTED. flexiple.com/robots.txt (last updated
 * 2026-05-21) names ClaudeBot / Claude-User / Claude-SearchBot in an
 * allow-list — "Allow: /", with only /pitch-deck, /deck/ and /component-library/
 * disallowed. We touch none of those. No login, no paywall, no bot challenge.
 *
 * VERIFIED LIVE ON 2026-08-08:
 *   /jobs                              HTTP 200, links to 37 skill pages
 *   /jobs/remote-java-developer-jobs   HTTP 200, 6 distinct gigs
 *   /jobs/remote-flutter-developer-jobs HTTP 200, 3 distinct gigs
 *   /jobs/remote-android-developer-jobs HTTP 200, 6 distinct gigs
 *   /jobs/remote-kotlin-developer-jobs  HTTP 200
 * The pages really do filter — the Flutter page returns Flutter projects, the
 * Java page returns Java/Spring projects. It is not one shared list reskinned.
 *
 * VOLUME — small and high-signal, like arc.dev. Expect roughly 10-15 unique
 * projects across the whole stack, not a firehose. Poll it daily.
 *
 * ------------------------------------------------------------------------
 * FOUR TRAPS THIS FILE EXISTS TO AVOID. Read before "simplifying" anything.
 * ------------------------------------------------------------------------
 *
 * 1. DO NOT GUESS SKILL SLUGS. `/jobs/remote-spring-boot-developer-jobs` is the
 *    obvious guess for a Spring Boot dev and it returns **HTTP 200** — but it is
 *    a completely different page ("Build Your Offshore India Team in Weeks")
 *    with ZERO job cards. A guessed slug here does not 404, it silently serves
 *    marketing copy. So the slug list is DISCOVERED from the /jobs hub at run
 *    time and only then filtered against our stack; VERIFIED_SLUGS below is a
 *    fallback of slugs actually confirmed to carry cards.
 *
 * 2. DO NOT CONSTRUCT THE ANCHOR. The deep-link anchor is *usually*
 *    `#<slug>-from-the-flexiple-network`, but the Node page breaks the pattern:
 *    slug `remote-node-js-developer-jobs` carries anchor id
 *    `remote-node-developer-jobs-from-the-flexiple-network`. So the anchor is
 *    read out of the HTML, never derived from the slug.
 *
 * 3. THERE IS NO PER-JOB URL. "Apply for this Job" is a <button> that opens
 *    Flexiple's signup flow — not an <a href>. There is no per-posting page and
 *    no posting id anywhere in the markup. So `url` is the skill page plus the
 *    real on-page anchor: a link that genuinely lands on the section containing
 *    that card. Do NOT "improve" this by inventing /jobs/<id> style URLs; they
 *    do not exist and would be fabricated links in the apply queue.
 *
 * 4. DO NOT PARSE BY CSS CLASS. The markup is Tailwind with build-hashed class
 *    names (`__className_4e0d06`, `h4 font-medium tracking-[-0.15px]`). Those
 *    hashes change on every Flexiple deploy. Every anchor in the parser below is
 *    a piece of literal *content* — the labels "Role Description", "Duration",
 *    "Client Geography", "Hours Per Week", "Project Type", "Apply for this Job"
 *    — which are user-visible text and therefore far more stable.
 *
 * ALSO WORTH KNOWING
 * ------------------
 * - Each card is rendered TWICE (a desktop carousel and a `max-md:hidden`
 *   mobile copy). Without de-duplication this source reports double. We de-dup
 *   on the normalised title, globally, which also collapses the genuine overlap
 *   between pages (the "Android Kotlin/ Java Developer" gig appears on both the
 *   Java and the Android page).
 * - There is NO posted/updated date on any card. `posted` is therefore left
 *   empty rather than filled with today's date, which would falsely make every
 *   listing look brand new on every single run.
 * - `Client Geography` is where the CLIENT sits, NOT a hiring restriction. Every
 *   listing is fully remote and Flexiple is an India-based network that recruits
 *   Indian freelancers, so a "USA" client geography does not exclude us. This is
 *   the opposite of arc.dev's `requiredCountries`, which IS a restriction —
 *   do not treat the two fields the same way.
 */

const { get, strip, rec } = require('../sources.js');

const HOME = 'https://flexiple.com';
const HUB = `${HOME}/jobs`;

/* Which of the hub's 37 skill pages are worth fetching for THIS candidate
 * (Java/Spring Boot backend + Flutter/Dart mobile, ~2 years).
 *
 * Matched against the slugs discovered on /jobs — a slug is fetched only if it
 * both exists on the hub AND matches one of these. That way a Flexiple rename
 * costs us one skill, and an invented slug can never sneak in (see trap #1).
 *
 * NOTE the absentee: there is no working spring-boot page. Spring roles surface
 * through the java page, where the skill tags literally read "JAVA / SPRING". */
const STACK_SLUGS = [
  'remote-java-developer-jobs',
  'remote-kotlin-developer-jobs',
  'remote-android-developer-jobs',
  'remote-flutter-developer-jobs',
];

/* Used only if the hub page itself fails to load. Each of these was verified by
 * hand to return real job cards — never add a slug here without fetching it and
 * confirming cards come back (trap #1: a bad slug returns 200, not 404). */
const VERIFIED_SLUGS = STACK_SLUGS.slice();

/* Hard ceiling on pages per run. Cheap insurance against a future hub page that
 * suddenly lists hundreds of slugs matching our filter. */
const MAX_PAGES = 8;

/* ------------------------------------------------------------------ helpers */

/* Decode the handful of entities that actually appear in this markup and
 * collapse whitespace. strip() from sources.js does the same for full HTML;
 * this is the text-node-only variant used inside the run extractor. */
function clean(t) {
  return String(t || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

/*
 * Turn a fragment of HTML into the ordered list of its visible text runs.
 *
 * For a Java dev: this is the same idea as pulling the text nodes out of a DOM
 * in document order, except we do it with a regex because there is no DOM here
 * and we do not want a parser dependency. `>([^<>]+)<` matches every chunk of
 * text sitting between a closing and an opening angle bracket — i.e. exactly the
 * text nodes — and nothing inside a tag, because [^<>] cannot cross a bracket.
 *
 * A Flexiple job card reduces to a very regular run list:
 *
 *   [ TITLE, 'Role Description', DESCRIPTION, SKILL, SKILL,
 *     'Duration', '3-6 months', 'Client Geography', 'USA',
 *     'Hours Per Week', '40', 'Project Type', 'Remote Job' ]
 *
 * which is why the label-driven parse below works without touching any CSS
 * class. Script/style bodies are removed first so their contents cannot leak in
 * as fake runs.
 */
function textRuns(html) {
  const body = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const out = [];
  const re = />([^<>]+)</g;
  let m;
  while ((m = re.exec(body))) {
    const t = clean(m[1]);
    if (t) out.push(t);
  }
  return out;
}

/* The four label/value rows in each card's detail grid, in render order. */
const FIELD_LABELS = ['Duration', 'Client Geography', 'Hours Per Week', 'Project Type'];

/* De-dup key. Titles differ only in whitespace/case between the desktop and
 * mobile copies of the same card, so normalise both away. */
function keyOf(title) {
  return String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/*
 * Pull the section anchor id out of the page — see trap #2, it is NOT derivable
 * from the slug. Returns '' if the page has no such anchor, in which case the
 * caller falls back to the bare page URL (still a working link).
 */
function extractAnchor(html) {
  const m = String(html || '').match(/id="([a-z0-9-]*from-the-flexiple-network)"/i);
  return m ? m[1] : '';
}

/*
 * Extract every job card from one skill page.
 *
 * Strategy: '>Role Description<' appears exactly once per job card and nowhere
 * else on the page (the FAQ and the "General Information / About Client / Your
 * Role / Other Details" template block do not contain it), so it is the natural
 * card marker. From each marker we widen backwards to the preceding <h4> (the
 * title) and forwards to the card's "Apply for this Job" button, stopping early
 * if the next card's marker comes first — that bound is what stops one
 * malformed card from swallowing its neighbours.
 */
function parseCards(html) {
  const src = String(html || '');
  const MARKER = '>Role Description<';
  const cards = [];

  let i = src.indexOf(MARKER);
  while (i !== -1) {
    const next = src.indexOf(MARKER, i + 1);

    const h4 = src.lastIndexOf('<h4', i);
    const start = h4 === -1 ? i : h4;

    // End at this card's apply button, or at the next card, whichever is first.
    let end = src.indexOf('Apply for this Job', i);
    if (end === -1 || (next !== -1 && next < end)) end = next === -1 ? src.length : next;
    if (end <= start) { i = next; continue; }

    const runs = textRuns(src.slice(start, end));
    const ri = runs.indexOf('Role Description');

    // ri must be > 0: run 0 is the title, so a marker with nothing before it
    // means we failed to find the heading and the card is unusable.
    if (ri > 0) {
      const title = runs[0];
      const description = runs[ri + 1] || '';

      // Where the detail grid starts — everything between the description and
      // that point is a skill tag.
      let firstLabel = runs.length;
      const fields = {};
      for (const label of FIELD_LABELS) {
        const k = runs.indexOf(label, ri + 1);
        if (k === -1) continue;
        if (k < firstLabel) firstLabel = k;
        fields[label] = runs[k + 1] || '';
      }

      const skills = runs.slice(ri + 2, firstLabel).filter(Boolean);

      // A real gig card ALWAYS carries the detail grid. Requiring at least one
      // of those labels is what stops a stray "Role Description" appearing
      // elsewhere on a future page — or in an error page served with HTTP 200 —
      // from being emitted as a phantom posting with a plausible-looking URL.
      if (title && Object.keys(fields).length) {
        cards.push({ title, description, skills, fields });
      }
    }

    i = next;
  }

  return cards;
}

/*
 * Stack tagging — same vocabulary as sites/arc.js so the report can compare
 * sources on equal terms and keep backend Java work separate from Flutter work.
 */
const STACK = [
  ['java', /\bjava\b(?!script)/i],
  ['spring-boot', /spring[\s-]?boot|\bspring\b/i],
  ['microservices', /micro[\s-]?services?/i],
  ['mysql', /\bmysql\b|mariadb/i],
  ['sql', /\bsql\b|postgres|postgresql/i],
  ['docker', /\bdocker\b|kubernetes|\bk8s\b/i],
  ['flutter', /\bflutter\b|\bdart\b/i],
  ['android', /\bandroid\b|\bkotlin\b/i],
  ['ndk-jni', /\bndk\b|\bjni\b|native\s+android/i],
  ['webrtc', /\bwebrtc\b|livekit|\bsip\b|\bsfu\b|\brtmp\b|agora/i],
  ['firebase', /\bfirebase\b|firestore/i],
];

function tagStack(text) {
  const hay = String(text || '');
  return STACK.filter(([, re]) => re.test(hay)).map(([tag]) => tag);
}

/* ------------------------------------------------------------ record mapping */

function mapCard(card, pageUrl, anchor, slug) {
  const title = clean(card.title);
  if (!title) return null;

  const f = card.fields || {};
  const duration = clean(f.Duration);
  const geography = clean(f['Client Geography']);
  const hours = clean(f['Hours Per Week']);
  const projectType = clean(f['Project Type']);

  // See trap #3 — there is no per-posting page, so this is the honest link.
  const url = anchor ? `${pageUrl}#${anchor}` : pageUrl;

  const text = [
    title,
    card.description,
    card.skills.length ? `Skills: ${card.skills.join(', ')}` : '',
    duration ? `Duration: ${duration}` : '',
    hours ? `Hours per week: ${hours}` : '',
    geography ? `Client geography: ${geography}` : '',
    projectType ? `Engagement: ${projectType}` : '',
    'Applications go through Flexiple; there is no per-posting page.',
  ].filter(Boolean).join('. ');

  const out = rec({
    title,
    // Flexiple anonymises its clients — every card describes the client
    // ("a US-based Gaming Platform Startup") but never names it. Emitting ''
    // would render as a blank cell that reads like a scrape failure, so the
    // absence is labelled deliberately (same convention as sites/arc.js).
    company: 'Undisclosed (Flexiple client)',
    url,
    text,
    skills: card.skills,
    // Always remote. Client geography is shown as context, not as a restriction
    // — see "ALSO WORTH KNOWING" in the header.
    location: geography ? `Remote (client: ${geography})` : 'Remote',
    // Flexiple publishes no rate on these cards (verified: no currency symbol
    // appears anywhere in a card). Empty is the truthful value.
    budget: '',
    // Fixed-duration, part/full-time-hours project work. A card without a
    // duration is the odd one out, so it degrades to plain 'remote'.
    type: duration ? 'contract' : 'remote',
    // No date exists on the page. Do not synthesise one.
    posted: '',
  });

  // ---- Flexiple-specific extras, attached after rec() so they survive ----
  out.duration = duration;
  out.hoursPerWeek = hours;
  out.clientGeography = geography;
  out.projectType = projectType;
  out.skillPage = slug;

  // Not derived from a per-listing field, unlike arc.dev's indiaOk. Flexiple is
  // an India-based network, all of its work is fully remote, and no listing
  // carries a country restriction — so India is always eligible here. Kept as an
  // explicit field so reports can sort alongside arc.dev without special-casing.
  out.indiaOk = true;

  out.stack = tagStack(`${title} ${card.description} ${card.skills.join(' ')}`);

  return out;
}

/* ------------------------------------------------------------------ adapter */

module.exports = {
  name: 'flexiple',
  // 'gig': fixed-duration client projects with an hours-per-week commitment,
  // not salaried reqs.
  kind: 'gig',
  homepage: HUB,

  async fetch(opts = {}) {
    const log = typeof opts.log === 'function' ? opts.log : () => {};

    // ---- 1. Discover which skill pages actually exist (trap #1) ----
    let slugs = [];
    try {
      // get() from sources.js already sends a real Chrome User-Agent and aborts
      // on a timeout, so a hung server cannot stall the sweep.
      const hub = await get(HUB, { json: false, timeout: 20000 });
      if (hub && hub.ok && hub.text) {
        const found = new Set();
        const re = /href="\/jobs\/(remote-[a-z0-9-]+-developer-jobs)"/gi;
        let m;
        while ((m = re.exec(hub.text))) found.add(m[1].toLowerCase());
        slugs = STACK_SLUGS.filter((s) => found.has(s));
        log(`flexiple: hub listed ${found.size} skill pages, ${slugs.length} match our stack`);
      } else {
        log(`flexiple: hub HTTP ${(hub && hub.status) || 0} — falling back to verified slugs`);
      }
    } catch (e) {
      log(`flexiple: hub fetch threw (${e && e.message}) — falling back to verified slugs`);
    }

    if (!slugs.length) slugs = VERIFIED_SLUGS.slice();
    slugs = slugs.slice(0, MAX_PAGES);

    // ---- 2. Fetch and parse each skill page ----
    const out = [];
    const seen = new Set(); // normalised title -> collapses mobile/desktop copies
    let pagesOk = 0;

    for (const slug of slugs) {
      const pageUrl = `${HUB}/${slug}`;

      let r;
      try {
        r = await get(pageUrl, { json: false, timeout: 20000 });
      } catch (e) {
        log(`flexiple: ${slug} fetch threw: ${e && e.message}`);
        continue;
      }
      if (!r || !r.ok || !r.text) {
        log(`flexiple: ${slug} HTTP ${(r && r.status) || 0} — skipped`);
        continue;
      }

      pagesOk++;

      const anchor = extractAnchor(r.text);
      let cards;
      try {
        cards = parseCards(r.text);
      } catch (e) {
        // A parse failure on one page must not cost us the other pages.
        log(`flexiple: ${slug} parse failed — ${e && e.message}`);
        continue;
      }

      if (!cards.length) {
        // Expected for a page that exists but has no live projects. If it fires
        // for EVERY page, Flexiple has changed its markup and the card marker
        // ('>Role Description<') needs revisiting.
        log(`flexiple: ${slug} — page loaded but no job cards found`);
        continue;
      }

      let added = 0;
      for (const card of cards) {
        // Per-record try/catch: one malformed card never takes out the batch.
        try {
          const mapped = mapCard(card, pageUrl, anchor, slug);
          if (!mapped || !mapped.title || !mapped.url) continue;
          const key = keyOf(mapped.title);
          if (!key || seen.has(key)) continue;
          seen.add(key);
          out.push(mapped);
          added++;
        } catch (e) {
          log(`flexiple: skipped a bad card on ${slug} — ${e && e.message}`);
        }
      }

      log(`flexiple: ${slug} -> ${cards.length} cards, ${added} new after de-dup`);
    }

    // Every page failed to load => the SOURCE is down. null lets the runner tell
    // that apart from "Flexiple had nothing today" (an empty array).
    if (!pagesOk) return null;
    return out;
  },
};
