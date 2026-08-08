/*
 * sites/freelancermap.js — freelancermap.com (https://www.freelancermap.com/projects)
 *
 * WHAT THIS SOURCE IS
 * -------------------
 * freelancermap is a genuine freelance PROJECT marketplace (DACH-rooted, but
 * with an international board): a client posts a project, freelancers apply.
 * That is the shape this sweep wants — not another salaried remote-job board.
 *
 * There is no public API and no working RSS feed (see "THE RSS TRAP" below).
 * What there IS: /projects is server-rendered, and the fully-formed project
 * list is embedded in the HTML as a plain JSON blob:
 *
 *     <script type="application/json">{ ..., "initialResults": [ ... ] }</script>
 *
 * So, exactly like the Arc adapter's __NEXT_DATA__ trick, we read the model the
 * server handed to the view instead of scraping rendered markup.
 *
 * ACCESS / TERMS — checked, not assumed:
 *   robots.txt is `User-agent: * / Disallow:` (i.e. everything allowed) and
 *   advertises the sitemap. The Terms page was scanned for scrape/crawl/robot/
 *   spider/harvest/data-mining clauses — there are none. No login is required
 *   for the project list, and nothing is being bypassed here: this is the same
 *   anonymous HTML a browser gets.
 *
 * ------------------------------------------------------------------------
 * THREE VERIFIED TRAPS — all three produce plausible-looking junk if ignored
 * ------------------------------------------------------------------------
 *
 * 1. THE RSS TRAP. Every page on the site carries
 *      <link rel="alternate" type="application/rss+xml"
 *            href="https://www.freelancermap.com/feeds/projects/int-international.xml"/>
 *    That URL returns **HTTP 404 with a full HTML error page**. It is stale
 *    boilerplate in the layout template — the 404 page itself still advertises
 *    it. An adapter that "found the RSS feed" and parsed that response would
 *    quietly emit zero records forever. Do not resurrect it.
 *
 * 2. THE PAGINATION TRAP — the important one.
 *    The payload contains `initialPagination`, an HTML paginator with hrefs
 *    ending `...&sort=1&pagenr=2#list`. Those links are handled CLIENT-SIDE.
 *    Requesting them anonymously was tested three ways:
 *        ?query=java&pagenr=2..4                      -> same 22 rows as page 1
 *        + full param set incl. queryParts[0], sort   -> same 22 rows as page 1
 *        the exact href copied out of initialPagination -> same 22 rows, and
 *                                                          `currentPage` STILL 1
 *    In every case the server re-serves page 1 with HTTP 200. A paginating loop
 *    would therefore inflate the sweep with N copies of the same 22 projects and
 *    look like it was working. So this adapter DOES NOT PAGINATE.
 *
 *    Breadth comes from running several QUERIES instead and unioning by project
 *    id. If you ever want more depth, add a query term here — do not add pagenr.
 *
 * 3. THE `url` FIELD TRAP. Each project has a top-level `url` field. It is
 *    either null or an opaque syndication token like "JOBGATE3151826310". It is
 *    NOT a link. The real one is `links.project` ("/project/<slug>"), with
 *    "/project/<slug>" as the fallback. Using `url` would yield unusable records.
 *
 * 4. THE "IT IS ALL CONTRACT" TRAP. freelancermap looks like a pure freelance
 *    board, so it is tempting to hardcode `type: 'contract'`. It is not pure.
 *    `projectContractType.type` was measured across a live 33-record sweep as:
 *        contracting        23   real freelance project work  -> 'contract'
 *        permanent_position  8   Festanstellung, i.e. SALARIED -> 'remote'
 *        employee_leasing    2   Arbeitnehmerüberlassung (ANÜ)
 *    Hardcoding 'contract' silently files those 8 salaried roles as contract
 *    gigs — which is precisely the salaried-board inventory this sweep already
 *    established is worthless. The mapping lives in typeOf() below.
 *
 * VOLUME AND SIGNAL
 * -----------------
 * Measured live: 22 rows on an unfiltered query; with the 100%-remote filter,
 * java -> 17, microservices -> 10, spring boot -> 4, flutter/dart -> 1. This is
 * a small, high-signal source, not a firehose. Expect tens of records, not
 * hundreds.
 *
 * A NOTE ON RELEVANCE: freelancermap's search is fuzzy/semantic (each project
 * ships a 768-float `embedding`), so a query for "android" can return a "Live
 * Content Creator" ad. That is the site's ranking, not a parse bug. Full
 * description text and the skill list are carried through on every record so the
 * sweep's own keyword scoring can do the real filtering downstream.
 */

const { get, strip, rec } = require('../sources.js');

const HOST = 'https://www.freelancermap.com';
const BASE = `${HOST}/projects`;

/*
 * One request per query — see THE PAGINATION TRAP. These are the candidate's
 * stack terms; each returns at most ~22 rows, and they overlap heavily, so the
 * union is deduplicated by project id.
 */
const QUERIES = [
  'java',
  'spring boot',
  'microservices',
  'flutter',
  'dart',
  'android',
  'kotlin',
  'backend developer',
];

/* Be a polite client: these are full ~1 MB HTML documents. */
const PAUSE_MS = 1200;
const TIMEOUT_MS = 30000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ helpers */

/* Coerce anything to a trimmed string. These payloads are not schema-stable:
 * `contractType` is null on some rows and "CONTRACT" on others, `country` is an
 * object, `budget` is null. Never call .trim() on a raw field. */
function s(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    const inner = v.en || v.name || v.title || v.label || v.value;
    return typeof inner === 'string' ? inner.trim() : '';
  }
  return '';
}

/*
 * Pull the project list out of the page.
 *
 * The page ships three <script type="application/json"> blobs; the one we want
 * is ~1.1 MB and is the only one with `initialResults`. Rather than indexing by
 * position (which would break the day a fourth blob is added), every blob is
 * parsed and the first one exposing a project array wins.
 *
 * `initialState.result.projects` is the same array under a second key; it is
 * accepted as a fallback in case the top-level alias is dropped.
 */
function extractProjects(html) {
  const blobs = [
    ...String(html || '').matchAll(
      /<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi
    ),
  ];

  for (const m of blobs) {
    const raw = m[1];
    // The interesting blob is ~1 MB; the other two are a few hundred bytes and
    // a ~23 KB nav config. Skip the small ones rather than JSON.parse'ing them.
    if (!raw || raw.length < 5000) continue;

    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      continue; // malformed/truncated blob is not fatal — try the next one
    }
    if (!data || typeof data !== 'object') continue;

    if (Array.isArray(data.initialResults)) return data.initialResults;

    const nested =
      data.initialState && data.initialState.result && data.initialState.result.projects;
    if (Array.isArray(nested)) return nested;
  }
  return null;
}

/*
 * Skills arrive as [{ de, en, url }, ...] — a localised pair, not a string.
 * Taking the objects straight through would render as "[object Object]", and
 * taking `de` would give a German skill list. We want `en`.
 */
function skillsOf(p) {
  const out = [];
  for (const src of [p.skills, p.subCategories]) {
    if (!Array.isArray(src)) continue;
    for (const sk of src) {
      const name = typeof sk === 'string' ? sk.trim() : s(sk);
      if (name && !out.includes(name)) out.push(name);
    }
  }
  return out;
}

/* Build the public project link. See THE `url` FIELD TRAP — `p.url` is a
 * syndication token, never a link. */
function urlOf(p) {
  const rel = (p.links && typeof p.links === 'object' && s(p.links.project)) || '';
  const path = rel || (p.slug ? `/project/${p.slug}` : '');
  if (!path) return '';
  return path.startsWith('http') ? path : HOST + path;
}

/* `created` is an ISO-8601 string with offset ("2026-08-07T23:03:14+02:00").
 * Guard against it arriving as a UNIX timestamp later — `updated` already is
 * one, so the two shapes coexist in this payload. */
function postedOf(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number' && Number.isFinite(v)) {
    const d = new Date(v > 1e11 ? v : v * 1000);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  }
  const str = s(v);
  if (!str) return '';
  if (/^\d+$/.test(str)) return postedOf(Number(str));
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

/* How remote is it? Lives at projectContractType.remoteInPercent (0-100), NOT
 * at the top level — a top-level `remoteInPercent` read returns undefined on
 * every row. */
function remotePctOf(p) {
  const pct = p.projectContractType && p.projectContractType.remoteInPercent;
  return Number.isFinite(Number(pct)) ? Number(pct) : null;
}

/*
 * Engagement -> the sweep's `type` vocabulary. See THE "IT IS ALL CONTRACT"
 * TRAP. Anything unrecognised falls back to 'contract', because this IS
 * predominantly a project board and 'contracting' is the majority value — but
 * the two known non-freelance values are called out explicitly.
 */
function typeOf(engagement) {
  const e = String(engagement || '').toLowerCase();
  // Festanstellung — a permanent salaried job that happens to be listed here.
  if (/permanent|festanstellung/.test(e)) return 'remote';
  return 'contract';
}

/*
 * India eligibility — a HEURISTIC, and deliberately labelled as one.
 *
 * Unlike Arc (which publishes a machine-readable `requiredCountries` allow-list),
 * freelancermap has NO eligibility field. Almost every client is European, and a
 * "100% remote" European project very often still means "remote, but you must be
 * resident in / authorised to work in the EU". There is no structured way to
 * tell those apart, so we do the only honest thing:
 *
 *   - require 100% remote (anything on-site in Europe is unreachable from India)
 *   - reject employee_leasing outright: Arbeitnehmerüberlassung is a German
 *     temp-EMPLOYMENT construct, so it structurally requires being employed
 *     locally. That one is a hard structural signal, not a guess.
 *   - then scan title+description for an explicit residency/work-permit/
 *     country demand and clear the flag when one is found. "Remote from
 *     <Country>" is included because it is this board's house style for a
 *     country-locked remote role.
 *
 * This is a triage hint to rank records, NOT a guarantee. `indiaOk: true` here
 * means "nothing in the posting rules India out", which is weaker than Arc's
 * `indiaOk` (which reads a real requiredCountries allow-list). Do not let a
 * downstream report present the two as equivalent.
 */
const RESIDENCY_RE = new RegExp(
  [
    'must (?:be )?(?:based|resid\\w+|located)',
    'only candidates? (?:based|residing|located)',
    'work(?:ing)? permit',
    'eu (?:citizen|national|passport|work)',
    'resid\\w+ in (?:the )?\\w+',
    // The board's house style for a country-locked remote role, e.g.
    // "Power Platform Architect - Remote from Romania - 6 months+".
    'remote from \\w+',
    'onsite|on-site|hybrid|relocat\\w+',
    'cet time ?zone|must overlap',
  ].join('|'),
  'i'
);

function indiaOkOf(p, text) {
  if (remotePctOf(p) !== 100) return false;
  const engagement = String(
    (p.projectContractType && p.projectContractType.type) || p.contractType || ''
  ).toLowerCase();
  if (/employee_leasing|leasing|arbeitnehmer/.test(engagement)) return false;
  return !RESIDENCY_RE.test(String(text || ''));
}

/* Which of the candidate's stack terms this posting actually matched, so the
 * report can keep Spring Boot work and Flutter work separate. Mirrors arc.js. */
const STACK = [
  ['java', /\bjava\b(?!script)/i],
  ['spring-boot', /spring[\s-]?boot|\bspring\b/i],
  ['microservices', /micro[\s-]?services?/i],
  ['mysql', /\bmysql\b|mariadb/i],
  ['sql', /\bsql\b|postgres|postgresql/i],
  ['docker', /\bdocker\b|kubernetes|\bk8s\b/i],
  ['flutter', /\bflutter\b|\bdart\b/i],
  ['android', /\bandroid\b|\bkotlin\b/i],
  ['webrtc', /\bwebrtc\b|livekit|\bsip\b|\bsfu\b/i],
  ['firebase', /\bfirebase\b|firestore/i],
];

function tagStack(text) {
  const hay = String(text || '');
  return STACK.filter(([, re]) => re.test(hay)).map(([tag]) => tag);
}

/* ------------------------------------------------------------ record mapping */

/*
 * Map one raw freelancermap project into the sweep's normalised record.
 *
 * NOTE: every project also carries `embedding`, a ~768-element float array used
 * by the site's semantic search. It is dropped on the floor here — pulling it
 * into records would balloon results.json by megabytes for zero downstream use.
 * Field selection below is explicit precisely so it can never leak in.
 *
 * As in arc.js, rec() returns a FIXED shape and drops unknown keys, so the
 * source-specific extras are attached AFTER the rec() call.
 */
function mapProject(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;

  const title = s(p.title);
  if (!title) return null; // a posting with no title is unusable

  const url = urlOf(p);
  if (!url) return null; // ...and one with no link cannot be applied to

  const skills = skillsOf(p);
  const country = s(p.country && p.country.nameEn) || s(p.country && p.country.name);
  const city = s(p.city);
  const pct = remotePctOf(p);

  // description is HTML; rec() runs strip() over `text`, so tags are removed.
  const desc = s(p.description);

  const where =
    pct === 100
      ? country
        ? `100% remote (client in ${country})`
        : '100% remote'
      : [city && city !== 'Not Specified' ? city : '', country].filter(Boolean).join(', ');

  const duration = s(p.durationText) || (p.duration ? `${p.duration} months` : '');
  const start = s(p.beginningText);

  // Engagement flavour. 'employee_leasing' is German Arbeitnehmerüberlassung
  // (temp-staffing) — legally a local-employment construct, so it is surfaced
  // rather than flattened into a generic "contract".
  const engagement = s(p.projectContractType && p.projectContractType.type) || s(p.contractType);

  const text = [
    title,
    p.company ? `Client: ${s(p.company)}` : '',
    where ? `Location: ${where}` : '',
    duration ? `Duration: ${duration}` : '',
    start ? `Start: ${start}` : '',
    engagement ? `Engagement: ${engagement.replace(/_/g, ' ')}` : '',
    skills.length ? `Skills: ${skills.join(', ')}` : '',
    desc,
  ]
    .filter(Boolean)
    .join('. ');

  const out = rec({
    title,
    company: s(p.company) || 'Undisclosed',
    url,
    text,
    skills,
    location: where,
    // `budget` exists in the schema but was null on every row measured. Kept in
    // case the field is ever populated; day rates otherwise live in the prose.
    budget: s(p.budget),
    // NOT hardcoded — see THE "IT IS ALL CONTRACT" TRAP. ~1 in 4 rows here is a
    // salaried Festanstellung wearing a project board's clothes.
    type: typeOf(engagement),
    posted: postedOf(p.created),
  });

  out.remotePct = pct;
  out.indiaOk = indiaOkOf(p, `${title} ${desc}`);
  out.stack = tagStack(`${title} ${skills.join(' ')} ${desc}`);
  out.engagement = engagement;
  out.duration = duration;
  out.id = String(p.id || p.slug || '');

  return out;
}

/* ------------------------------------------------------------------ adapter */

module.exports = {
  name: 'freelancermap',
  kind: 'gig',
  homepage: 'https://www.freelancermap.com/projects',

  async fetch(opts = {}) {
    const log = typeof opts.log === 'function' ? opts.log : () => {};

    const out = [];
    const seen = new Set(); // de-dup across queries: project id, else url
    let queriesOk = 0;

    for (let i = 0; i < QUERIES.length; i++) {
      const q = QUERIES[i];

      // Be polite between full ~1 MB page loads.
      if (i > 0) await sleep(PAUSE_MS);

      /* remoteInPercent[]=100 keeps this high-precision: an on-site project in
       * Germany is unreachable for an India-based candidate, and unfiltered
       * queries are dominated by exactly that. excludeDachProjects=1 matches the
       * site's own default for the international board. */
      const url =
        `${BASE}?query=${encodeURIComponent(q)}` +
        `&remoteInPercent%5B%5D=100&excludeDachProjects=1&currentPlatform=5&locale=en`;

      let r;
      try {
        r = await get(url, { json: false, timeout: TIMEOUT_MS });
      } catch (e) {
        // get() already swallows its own errors, but a throw here must never
        // escape and kill the sweep.
        log(`freelancermap: "${q}" fetch threw: ${e && e.message}`);
        continue;
      }

      if (!r || !r.ok || !r.text) {
        log(`freelancermap: "${q}" HTTP ${(r && r.status) || 0} — skipped`);
        continue;
      }

      const projects = extractProjects(r.text);
      if (!projects) {
        // If this fires for every query, the site has changed how it embeds the
        // project list and this adapter needs revisiting.
        log(`freelancermap: "${q}" — no parseable project JSON blob found`);
        continue;
      }

      queriesOk++;

      let added = 0;
      for (const raw of projects) {
        // Per-record try/catch: one malformed project must never take out the
        // whole batch.
        try {
          const mapped = mapProject(raw);
          if (!mapped) continue;
          const key = mapped.id || mapped.url;
          if (!key || seen.has(key)) continue;
          seen.add(key);
          out.push(mapped);
          added++;
        } catch (e) {
          log(`freelancermap: skipped a bad record — ${e && e.message}`);
        }
      }

      log(`freelancermap: "${q}" -> ${projects.length} rows, ${added} new`);
    }

    // Every query failed to fetch/parse => the SOURCE is down. Return null so
    // the runner can tell that apart from "nothing matched today" (empty array).
    if (!queriesOk) return null;
    return out;
  },
};
