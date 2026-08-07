/*
 * sites/arc.js — Arc.dev (https://arc.dev/remote-jobs)
 *
 * WHAT THIS SOURCE IS
 * -------------------
 * Arc.dev is a vetted remote-developer marketplace. It has no public API, but
 * the /remote-jobs pages are server-rendered by Next.js (the classic "pages"
 * router), which means the fully-formed job data is embedded in the HTML as a
 * single JSON blob:
 *
 *     <script id="__NEXT_DATA__" type="application/json">{ ... }</script>
 *
 * VERIFIED LIVE ON 2026-08-07: __NEXT_DATA__ is present on all five pages we
 * fetch (HTTP 200, ~220-250 KB each). Arc has NOT moved to streamed React
 * Server Components — there is no `self.__next_f` marker anywhere in the HTML.
 * So the parser below is written against a payload that genuinely exists.
 *
 * For a Java/Spring dev: think of __NEXT_DATA__ as the model the server handed
 * to the view. Instead of scraping the rendered HTML (brittle CSS selectors),
 * we read the model object directly. Far more stable — but the *shape* of that
 * model changes between deploys, which is why we search for the jobs array
 * rather than hardcoding a path (see findJobArrays below).
 *
 * VOLUME — this is a high-signal daily poll, NOT a firehose.
 * The research reported ~30 live Arc-native roles, and that is exactly what we
 * measured: `arcJobs` is 30 on the front page, and only 1-2 per skill page.
 * Do not expect this source to produce bulk. Expect it to produce a small
 * number of unusually well-qualified contract roles. Poll it daily.
 *
 * WHY THIS SOURCE IS DISPROPORTIONATELY VALUABLE
 * ---------------------------------------------
 * It is the only source in the whole sweep with a MACHINE-READABLE
 * India-eligibility field: `requiredCountries`, an array of ISO-3166 alpha-2
 * codes. Everywhere else we have to guess eligibility from prose like
 * "Remote (US only)". Here it is structured data, so we set a top-level
 * `indiaOk` boolean on every record.
 *
 * Measured on the live payload (183 postings across the five pages):
 *   - `requiredCountries: []`            => no restriction => global => indiaOk
 *   - `requiredCountries: ["IN"]`        => India explicitly listed
 *   - `requiredCountries: ["TT","CA",…]` => a 36-country LATAM/NA list with no
 *                                           "IN" => India NOT eligible
 * That last case is not hypothetical: the single "Senior Java/Spring Boot
 * Engineer" role on the spring-boot page is NA/LATAM-only. Without this field
 * we would have surfaced it as a perfect match and wasted an application.
 */

const { get, strip, rec } = require('../sources.js');

/* The skill pages to sweep, plus the bare /remote-jobs front page.
 * All five verified HTTP 200 with a parseable payload. The skill pages route
 * through /remote-jobs/[urlSearchQuery], and Arc DOES really filter by them —
 * the spring-boot page returns Spring Boot roles, not a generic fallback. */
const SKILLS = ['java', 'flutter', 'android', 'spring-boot'];

const BASE = 'https://arc.dev/remote-jobs';

/* Arc uses two different URL shapes depending on which array the job came from.
 * Both verified to return HTTP 200 with a real job page:
 *   arcJobs      -> https://arc.dev/remote-jobs/details/<urlString>-<randomKey>
 *   externalJobs -> https://arc.dev/remote-jobs/j/<urlString>-<randomKey>
 * Getting this wrong yields 404s that look like valid records, so it is keyed
 * off the path the record was found at, not guessed. */
const PATH_DETAILS = '/details/';
const PATH_EXTERNAL = '/j/';

/* ------------------------------------------------------------------ helpers */

/* Coerce anything to a trimmed string. These payloads are not schema-stable:
 * a field that is a string on one page is null or an object on the next, and
 * calling .trim() on null is what killed a whole source mid-run previously. */
function s(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    // Common wrapper shapes seen in feeds: { name }, { title }, { label }, { code }
    const inner = v.name || v.title || v.label || v.code || v.value;
    return typeof inner === 'string' ? inner.trim() : '';
  }
  return '';
}

/* Coerce anything to an array of strings. Handles: real array, single string,
 * comma/pipe separated string, array of objects, null. NEVER assume an array
 * is an array. */
function toList(v) {
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v.map(s).filter(Boolean);
  if (typeof v === 'string') {
    return v.split(/[,;|]/).map((x) => x.trim()).filter(Boolean);
  }
  if (typeof v === 'object') {
    return Object.values(v).map(s).filter(Boolean);
  }
  return [s(v)].filter(Boolean);
}

/* Is this key the posting's headline?
 * Deliberately does NOT include "name" — the nested `categories` arrays are
 * [{ name, urlString }, ...] and would otherwise be mistaken for jobs. That is
 * a real trap: the live payload contains 150+ such nested arrays. */
const TITLE_KEYS = ['title', 'jobtitle', 'role', 'jobrole', 'position', 'positiontitle', 'headline'];

/* Secondary evidence that an object is a job rather than some other entity. */
const JOB_KEYS = [
  'company', 'employer', 'organization', 'jobtype', 'positiontype', 'postedat',
  'publishedat', 'createdat', 'urlstring', 'slug', 'salary', 'minannualsalary',
  'maxannualsalary', 'minhourlyrate', 'maxhourlyrate', 'requiredcountries',
  'experiencelevel', 'experiencelevels', 'location', 'remote',
];

function looksLikeJob(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  const keys = Object.keys(o).map((k) => k.toLowerCase());
  const hasTitle = keys.some((k) => TITLE_KEYS.includes(k));
  if (!hasTitle) return false;
  const hasSupport = keys.some((k) => JOB_KEYS.includes(k));
  return hasSupport;
}

/*
 * Recursively walk the parsed payload and return EVERY array that looks like a
 * list of job objects, together with the path it was found at.
 *
 * Why not hardcode props.pageProps.arcJobs? Because Next.js payload shapes
 * change between deploys, and a hardcoded path silently returns zero on the
 * day it changes — the worst possible failure mode for an unattended sweep.
 *
 * Why ALL arrays and not just the first? Because the live payload genuinely
 * contains TWO job arrays:
 *     props.pageProps.arcJobs       (Arc-native contract roles — the good stuff)
 *     props.pageProps.externalJobs  (aggregated third-party board listings)
 * Taking only the first would discard most of the data, and which one comes
 * first depends on key insertion order, which is not a guarantee we should
 * lean on. We take both and tag them.
 *
 * Once an array is accepted as a jobs array we do NOT descend into it, so the
 * per-job nested `categories` arrays cannot be reported as separate finds.
 */
function findJobArrays(root) {
  const found = [];
  const seen = new Set(); // guards against cycles in the object graph

  function walk(node, path, depth) {
    if (!node || typeof node !== 'object' || depth > 12) return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      // An array qualifies if a clear majority of its entries look like jobs.
      //
      // "Majority" rather than "all" is deliberate and load-bearing: a single
      // null or half-serialised entry in the feed must NOT disqualify the whole
      // array and cost us the entire batch. The ratio is computed over the full
      // array length, so an array of mostly-junk is still rejected.
      if (node.length) {
        const hits = node.filter(looksLikeJob).length;
        if (hits && hits >= Math.ceil(node.length * 0.6)) {
          found.push({ path, jobs: node });
          return; // accepted — do not descend into the individual jobs
        }
      }
      node.forEach((child, i) => walk(child, `${path}[${i}]`, depth + 1));
      return;
    }

    for (const k of Object.keys(node)) {
      walk(node[k], path ? `${path}.${k}` : k, depth + 1);
    }
  }

  walk(root, '', 0);
  return found;
}

/* Pull the __NEXT_DATA__ blob out of the HTML.
 * Non-greedy ([\s\S]*?) so we stop at the FIRST closing </script> rather than
 * swallowing the rest of the document. */
function extractNextData(html) {
  const m = String(html || '').match(
    /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i
  );
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch (e) {
    // Malformed / truncated JSON — treat as "could not parse", not as a crash.
    return null;
  }
}

/*
 * India eligibility.
 *
 * `requiredCountries` is Arc's allow-list of countries a candidate may sit in.
 * VERIFIED SEMANTICS on the live payload:
 *   absent / empty array  -> no geographic restriction -> globally open -> true
 *   contains IN/IND/India -> India explicitly allowed              -> true
 *   non-empty without IN  -> India excluded                        -> false
 *
 * Defensive: the field is an array of plain strings today, but this handles a
 * bare string ("IN"), a delimited string ("IN,US"), and an array of objects
 * ([{ code: 'IN' }]) in case Arc enriches the shape later.
 */
function isIndiaOk(requiredCountries) {
  const list = toList(requiredCountries);
  if (!list.length) return true; // no restriction recorded => open to everyone
  return list.some((c) => /^(IN|IND|INDIA)$/i.test(String(c).trim()));
}

/* Render requiredCountries into a short, human-readable location string.
 * The raw list can be 180+ codes, which would just be truncated to noise by
 * rec()'s 120-char cap, so long lists are summarised instead of dumped. */
function describeCountries(requiredCountries) {
  const list = toList(requiredCountries);
  if (!list.length) return 'Worldwide';
  if (list.length <= 8) return list.join(', ');
  const inIndia = list.some((c) => /^(IN|IND|INDIA)$/i.test(String(c).trim()));
  return `${list.length} countries${inIndia ? ' incl. IN' : ' (IN excluded)'}`;
}

/*
 * Stack tagging.
 *
 * The research surfaced an asymmetry that matters: Spring Boot demand and
 * Flutter demand do NOT live on the same platforms. So every record carries the
 * specific stack terms it matched, letting the report split "backend Java work"
 * from "mobile Flutter work" instead of lumping them into one relevance score.
 */
const STACK = [
  ['java', /\bjava\b(?!script)/i],
  ['spring-boot', /spring[\s-]?boot|\bspring\b/i],
  ['microservices', /micro[\s-]?services?/i],
  // MySQL specifically is the candidate's depth. Bare "SQL"/"PostgreSQL" is a
  // weaker, separate signal — tagging it as 'mysql' would be a false positive.
  ['mysql', /\bmysql\b|mariadb/i],
  ['sql', /\bsql\b|postgres|postgresql/i],
  ['docker', /\bdocker\b|kubernetes|\bk8s\b/i],
  ['flutter', /\bflutter\b|\bdart\b/i],
  ['android', /\bandroid\b|\bkotlin\b/i],
  ['ndk-jni', /\bndk\b|\bjni\b|native\s+android/i],
  ['webrtc', /\bwebrtc\b|livekit|\bsip\b|\bsfu\b/i],
  ['firebase', /\bfirebase\b|firestore/i],
];

function tagStack(text) {
  const hay = String(text || '');
  return STACK.filter(([, re]) => re.test(hay)).map(([tag]) => tag);
}

/* Money. arcJobs carry hourly rates (min/maxHourlyRate) and sometimes annual
 * salary; externalJobs carry no compensation fields at all — verified, 0/146
 * had any. So an empty budget on an external record is expected, not a bug. */
function budgetOf(j) {
  const minH = Number(j.minHourlyRate);
  const maxH = Number(j.maxHourlyRate);
  if (Number.isFinite(minH) && minH > 0) {
    return Number.isFinite(maxH) && maxH > 0
      ? `${minH}-${maxH} USD/hr`
      : `${minH}+ USD/hr`;
  }
  if (Number.isFinite(maxH) && maxH > 0) return `up to ${maxH} USD/hr`;

  const minA = Number(j.minAnnualSalary);
  const maxA = Number(j.maxAnnualSalary);
  if (Number.isFinite(minA) && minA > 0) {
    return Number.isFinite(maxA) && maxA > 0
      ? `${minA}-${maxA} USD/yr`
      : `${minA}+ USD/yr`;
  }
  if (Number.isFinite(maxA) && maxA > 0) return `up to ${maxA} USD/yr`;
  return '';
}

/* postedAt is a UNIX timestamp in SECONDS (verified: 1785962705 -> 2026-08-05).
 * Guard against it arriving as milliseconds or as an ISO string later. */
function postedOf(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number' && Number.isFinite(v)) {
    const ms = v > 1e11 ? v : v * 1000; // >1e11 means it is already milliseconds
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  }
  const str = s(v);
  if (!str) return '';
  if (/^\d+$/.test(str)) return postedOf(Number(str));
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------ record mapping */

/*
 * Map one raw Arc job into the sweep's normalised record.
 *
 * IMPORTANT: rec() returns a FIXED shape and silently drops any extra keys, so
 * the Arc-specific extras (indiaOk, stack, ...) are attached AFTER the rec()
 * call. Passing them into rec() would throw them away.
 *
 * NOTE ON `text`: the Next.js payload contains NO description/body field for
 * any job — verified across all 183 records on all five pages. The full
 * description only exists on the individual job page. So `text` here is
 * synthesised from the structured fields that DO exist (title, skill
 * categories, seniority, timezone). Downstream keyword scoring still works
 * because `categories` is a clean, explicit skill list — arguably better signal
 * than prose. But do not expect prose here, and do not "fix" it by assuming a
 * description field exists.
 */
function mapJob(j, external) {
  // The array may legitimately contain holes/nulls — see findJobArrays.
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;

  const title = s(j.title);
  if (!title) return null; // a posting with no title is unusable

  const slug = s(j.urlString);
  const id = s(j.randomKey);

  // Both segments are needed; without them we cannot build a working link.
  const url = slug
    ? `${BASE}${external ? PATH_EXTERNAL : PATH_DETAILS}${slug}${id ? '-' + id : ''}`
    : '';

  // `categories` is [{ name, urlString }, ...] -> a clean skill list.
  const skills = toList(j.categories);

  // arcJobs are anonymised by Arc: company is always { randomKey: null } and
  // NEVER carries a name (verified 0/37). externalJobs always do (146/146).
  const companyObj = j.company && typeof j.company === 'object' ? j.company : {};
  const company = s(companyObj.name);

  // Seniority: arcJobs use `experienceLevel` (string), externalJobs use
  // `experienceLevels` (array). Same concept, different key AND different type.
  const levels = toList(j.experienceLevel).concat(toList(j.experienceLevels));

  const jobType = s(j.jobType).toLowerCase();
  const timeZone = s(j.timeZone);

  // Synthesised description — see NOTE ON `text` above.
  const text = [
    title,
    company ? `Company: ${company}` : 'Company: undisclosed (Arc anonymises its own listings)',
    skills.length ? `Skills: ${skills.join(', ')}` : '',
    levels.length ? `Level: ${levels.join(', ')}` : '',
    jobType ? `Engagement: ${jobType}` : '',
    timeZone && timeZone !== 'no-preference' ? `Timezone: ${timeZone}` : '',
    `Eligible countries: ${describeCountries(j.requiredCountries)}`,
  ].filter(Boolean).join('. ');

  const out = rec({
    title,
    // Arc anonymises its own listings (see the note above), so `company` is
    // empty for every arcJob. Emitting '' makes downstream reports render a
    // blank cell that reads like a scrape failure. Emit an explicit label
    // instead so the absence is visibly deliberate. externalJobs, which DO
    // carry a real name, are unaffected.
    company: company || 'Undisclosed (Arc network)',
    url,
    text,
    skills,
    location: describeCountries(j.requiredCountries),
    budget: budgetOf(j),
    // Arc's own vocabulary is 'contract' vs 'permanent'.
    type: /contract|freelance|part[\s-]?time/.test(jobType) ? 'contract' : 'remote',
    posted: postedOf(j.postedAt),
  });

  // ---- Arc-specific extras, attached after rec() so they survive ----

  // THE headline field for this source. See isIndiaOk above.
  out.indiaOk = isIndiaOk(j.requiredCountries);

  // Which of the candidate's stack terms this posting actually matched, so the
  // report can keep Spring Boot roles and Flutter roles separate.
  out.stack = tagStack(`${title} ${skills.join(' ')}`);

  // 'arc' = Arc-native vetted contract role (high signal, ~30 live).
  // 'external' = aggregated third-party listing (high volume, low precision).
  out.arcFeed = external ? 'external' : 'arc';
  out.id = id;

  return out;
}

/* ------------------------------------------------------------------ adapter */

module.exports = {
  name: 'arc.dev',
  // 'gig': the arcJobs feed is genuinely freelance/contract work (27 of 30 on
  // the front page were jobType 'contract'), not a salaried job board.
  kind: 'gig',
  homepage: 'https://arc.dev/remote-jobs',

  async fetch(opts = {}) {
    const log = typeof opts.log === 'function' ? opts.log : () => {};

    // Bare front page first, then each skill page.
    const pages = [{ label: 'all', url: BASE }].concat(
      SKILLS.map((k) => ({ label: k, url: `${BASE}/${encodeURIComponent(k)}` }))
    );

    const out = [];
    const seen = new Set(); // de-dup key: job id, else url
    let pagesOk = 0;

    for (const page of pages) {
      // json:false -> the helper hands back raw HTML on r.text
      let r;
      try {
        r = await get(page.url, { json: false });
      } catch (e) {
        log(`arc.dev: ${page.label} fetch threw: ${e && e.message}`);
        continue;
      }
      if (!r || !r.ok || !r.text) {
        log(`arc.dev: ${page.label} HTTP ${(r && r.status) || 0} — skipped`);
        continue;
      }

      const data = extractNextData(r.text);
      if (!data) {
        // If this fires for every page, Arc has changed its rendering (most
        // likely to streamed RSC) and this adapter needs revisiting.
        log(`arc.dev: ${page.label} — no parseable __NEXT_DATA__ found`);
        continue;
      }

      const arrays = findJobArrays(data);
      if (!arrays.length) {
        log(`arc.dev: ${page.label} — payload parsed but no job-like array found`);
        continue;
      }

      pagesOk++;

      for (const { path, jobs } of arrays) {
        // Log the discovered path. When Arc reshapes its payload, this line is
        // the difference between a five-minute fix and a silent zero.
        log(`arc.dev: ${page.label} -> ${jobs.length} jobs at ${path}`);

        // externalJobs use a different public URL prefix than arcJobs.
        const external = /external/i.test(path);

        for (const raw of jobs) {
          // Per-record try/catch: one malformed posting must never take out the
          // whole batch.
          try {
            const mapped = mapJob(raw, external);
            if (!mapped) continue;
            const key = mapped.id || mapped.url;
            if (!key || seen.has(key)) continue;
            seen.add(key);
            out.push(mapped);
          } catch (e) {
            log(`arc.dev: skipped a bad record — ${e && e.message}`);
          }
        }
      }
    }

    // Every page failed to fetch/parse => the SOURCE is down. Return null so the
    // runner can tell that apart from "Arc had nothing today" (an empty array).
    if (!pagesOk) return null;
    return out;
  },
};
