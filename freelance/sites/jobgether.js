/*
 * sites/jobgether.js — Jobgether remote job board.
 *
 * WHY THIS SOURCE IS SANCTIONED
 * -----------------------------
 * Jobgether's robots.txt explicitly allows this exact path (verified live):
 *
 *     Allow: /astroapi/ai/jobs
 *     Allow: /astroapi/ai/jobs?*
 *     Disallow: /*?*            <- everything else with a query string is off-limits
 *     Crawl-delay: 2
 *
 * So the endpoint below is deliberately opened up for automated/AI clients, while
 * the rest of the site is not. Two consequences a future reader must respect:
 *   1. Do not "improve" this adapter by scraping /offer/<id> HTML pages for the
 *      job description — robots.txt disallows /offer/{*} patterns, and the plain
 *      listing pages are outside the Allow rules that cover this API.
 *   2. Crawl-delay is 2 seconds. We sleep between requests (see PAUSE_MS). Do not
 *      remove that to make the sweep faster.
 *
 * The API even self-documents at /astroapi/ai/jobs/docs — that is where the
 * pagination rules and the allowed contractType values below come from.
 *
 * FOR A JAVA/SPRING READER
 * ------------------------
 * Think of this file as one @Component implementing a `JobSource` interface. The
 * contract is the `module.exports` object at the bottom: a name, a kind, and an
 * async fetch() that returns List<Record> — or null to signal "source is down".
 */

const { get, strip, rec } = require('../sources.js');

/* The API is a search endpoint: no keyword means no useful stack filtering, so we
 * ask it once per term and merge. These five cover both halves of the candidate's
 * stack — the Spring Boot half and the Flutter/Android half — which, per the
 * research, do NOT co-occur on the same platforms. */
const KEYWORDS = ['flutter', 'java', 'spring boot', 'android', 'backend developer'];

/* PAGINATION — probed against the live API, not assumed.
 *
 * The response carries { pagination: { page, limit, hasMore } } and the docs say:
 * "increment `page` and re-request... `pagination.hasMore` tells you whether
 * another page exists."  Verified by hand:
 *   - page=1 and page=2 for the same keyword returned 25 records each with ZERO
 *     overlapping ids, so paging really does advance.
 *   - limit is capped at 25 server-side: asking for limit=50 silently returns 25
 *     and echoes back "limit": 25. Do not bother asking for more.
 *   - docs say page is capped at 10 (so ~250 records/keyword is the ceiling).
 * We stop early on hasMore === false, so MAX_PAGES is only a safety rail against
 * a runaway loop if the API ever stops setting that flag honestly. */
const PAGE_LIMIT = 25;
const MAX_PAGES = 4; // 4 x 25 = up to 100 per keyword; plenty for a daily sweep

const PAUSE_MS = 2000; // robots.txt Crawl-delay: 2
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ coercion */
/* sources.js keeps its `arr` helper private, so we define the small amount of
 * defensive coercion we need locally. The rule that burned a previous source:
 * a field that is a string today can be null, a number, or an object tomorrow.
 * Never hand a raw feed value straight to .trim() / .toLowerCase() / .map(). */
const str = (v) => {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  // Objects sometimes arrive as { name } / { label } / { title } wrappers.
  if (typeof v === 'object' && !Array.isArray(v)) return str(v.name || v.label || v.title || '');
  if (Array.isArray(v)) return v.map(str).filter(Boolean).join(', ');
  return '';
};

/* jobFunctions is an array of strings in every one of the 200 live records we
 * sampled — but "is an array" is exactly the assumption we are told never to
 * make, so this tolerates a bare string or a null too. */
const list = (v) => {
  if (Array.isArray(v)) return v.map(str).filter(Boolean);
  const s = str(v);
  return s ? s.split(/\s*[,;|]\s*/).filter(Boolean) : [];
};

/* ------------------------------------------------------- stack tagging  */
/* The report needs to separate Spring Boot demand from Flutter demand, because
 * they live on different platforms. Each posting gets tagged with which half of
 * the candidate's stack it actually matched.
 *
 * Note the \b word boundaries. /java/ would match "JavaScript", which is a
 * completely different job — \bjava\b does not, because there is no word
 * boundary between "java" and "script". Same reasoning for \bdart\b, which would
 * otherwise hit "dartboard"/"Dartmouth". */
const STACK_TAGS = [
  ['java-backend', /\bjava\b|\bspring\s*boot\b|\bspring\b|\bmicroservices?\b|\bmy\s*sql\b|\bdocker\b|\bkubernetes\b|\bhibernate\b|\bjpa\b/i],
  ['flutter-mobile', /\bflutter\b|\bdart\b/i],
  ['android-native', /\bandroid\b|\bndk\b|\bjni\b|\bkotlin\b/i],
  ['webrtc', /\bwebrtc\b|\bsip\b|\bjanus\b|\bmediasoup\b/i],
  ['firebase', /\bfirebase\b|\bfirestore\b/i],
];

const tagStack = (haystack) => STACK_TAGS.filter(([, re]) => re.test(haystack)).map(([tag]) => tag);

/* ------------------------------------------------------------ location logic */
/* A GENUINE TRAP, found by reading the live data rather than guessing:
 * one record's location is "Germany, Indiana (USA)". A naive /india/i test
 * returns TRUE for that, and also for "Indianapolis" and "British Indian Ocean
 * Territory" — three false positives that would tell an India-based candidate he
 * can take a US-state-locked job. So India must be matched as a whole token,
 * bounded by string edges, commas, slashes or parentheses.
 * Verified: matches "India" and "Poland, Romania, India, Portugal";
 *           rejects "Indiana (USA)", "Indianapolis", "British Indian Ocean Territory". */
const INDIA_RE = /(^|[,;/&]|\s)india($|[,;/&()]|\s)/i;

/* "Anywhere" is the value Jobgether actually uses for a globally-open role (18 of
 * our 200 sampled records). The others are defensive synonyms in case the
 * taxonomy shifts. */
const GLOBAL_RE = /\b(anywhere|worldwide|world\s*wide|global(ly)?|any\s*location|no\s*location\s*restriction)\b/i;

/* --------------------------------------------------------------- type logic */
/* contractType is a closed vocabulary. The docs list the filter values as
 * full-time / part-time / fixed-term / freelance / internships, and the values
 * that come back in records are title-cased: observed across 200 live records
 * were exactly "Full time" (167), "Part time" (21), "Freelance" (6),
 * "Fixed term" (5), "Internships" (1).
 *
 * Freelance and Fixed term are the two that mean "contract work" for this sweep.
 * Everything else is a salaried remote role, which is still worth reporting but
 * must not be mislabelled — hence 'remote' as the default. */
const CONTRACT_RE = /\b(freelance|fixed[\s-]*term|contract(or|ing)?|temporary|interim|b2b)\b/i;

/* ---------------------------------------------------------------- one record */
/* Kept as its own function so the caller can wrap each call in try/catch: one
 * malformed posting must never take down the whole batch. */
function mapJob(j) {
  const id = str(j.id);
  const title = str(j.title);
  const url = str(j.url);

  // A record with no title and no url is not a job posting; skip it.
  if (!title && !url) return null;

  const company = str(j.company);
  const place = str(j.location); // e.g. "Mexico", "Anywhere", "Spain, France"
  const remote = str(j.remote); // e.g. "Full Remote" (the only value observed)
  const contractType = str(j.contractType);
  const experience = str(j.experience); // e.g. "Mid-level (2-5 years)", often ""
  const functions = list(j.jobFunctions); // e.g. ["Flutter Developer"]

  /* Requested display form: "Full Remote — Mexico". Either half can be missing,
   * so join only the parts that actually exist rather than emitting a stray dash. */
  const location = [remote, place].filter(Boolean).join(' — ');

  /* THE ONE FIELD THIS API DOES NOT PROVIDE: there is no description/summary/body
   * key anywhere in the payload (confirmed — the record has exactly 11 possible
   * keys and none of them is prose). The downstream scorer keyword-matches
   * `text`, so leaving it empty would make every Jobgether posting score zero.
   * We therefore synthesise a text from the structured fields we DO have. This is
   * a real summary of the posting, not invented content — every token in it came
   * out of the payload. Full descriptions live on the /offer/ page, which
   * robots.txt disallows, so this is the honest ceiling for this source. */
  const text = [
    title,
    company ? `at ${company}` : '',
    functions.length ? `Job functions: ${functions.join(', ')}.` : '',
    experience ? `Experience: ${experience}.` : '',
    contractType ? `Contract type: ${contractType}.` : '',
    location ? `Location: ${location}.` : '',
  ]
    .filter(Boolean)
    .join(' ');

  /* salaryRange is OPTIONAL and usually absent — only 3 of 200 sampled records
   * carried it (e.g. "57600-67200 EUR"). It is already a human-readable string
   * in exactly the shape `budget` wants, so pass it straight through. */
  const budget = str(j.salaryRange);

  const out = rec({
    title,
    company,
    url,
    text,
    // jobFunctions is the only skill-ish signal available; the title carries the
    // rest, and the scorer reads `text` anyway.
    skills: functions,
    location,
    budget,
    type: CONTRACT_RE.test(contractType) ? 'contract' : 'remote',
    // postedAt is a full ISO timestamp ("2026-08-05T14:30:25.586Z") -> YYYY-MM-DD
    posted: str(j.postedAt).slice(0, 10),
  });

  /* rec() builds a fixed-shape object, so anything extra has to be attached
   * afterwards. The runner spreads the record ({ ...j, ...c }) so these survive
   * into the report. */
  out.indiaOk = GLOBAL_RE.test(place) || INDIA_RE.test(place);
  out.stack = tagStack(`${title} ${functions.join(' ')}`);
  out.experience = experience;
  out.contractType = contractType;
  out.id = id;

  return out;
}

/* -------------------------------------------------------------------- source */
module.exports = {
  name: 'jobgether',
  kind: 'remote', // a job board, not a gig marketplace — mostly salaried, some freelance
  homepage: 'https://jobgether.com',

  async fetch() {
    const byKey = new Map(); // de-dup: id (preferred) or url
    let anyOk = false; // did at least one HTTP call actually succeed?
    let first = true;

    for (const keyword of KEYWORDS) {
      for (let page = 1; page <= MAX_PAGES; page++) {
        // Be a polite client: robots.txt asks for 2s between hits. Skip the wait
        // before the very first request so a single-source run is not needlessly slow.
        if (first) first = false;
        else await sleep(PAUSE_MS);

        const url =
          'https://jobgether.com/astroapi/ai/jobs' +
          `?keyword=${encodeURIComponent(keyword)}` +
          `&limit=${PAGE_LIMIT}&page=${page}&sort=date`;

        const r = await get(url);

        /* A failed page is not a failed source. Break out of this keyword's page
         * loop and let the other keywords carry on — partial data beats none. */
        if (!r.ok || !r.data) break;

        const jobs = r.data.jobs;
        if (!Array.isArray(jobs) || jobs.length === 0) {
          anyOk = true; // valid response that simply had no results
          break;
        }
        anyOk = true;

        for (const j of jobs) {
          try {
            if (!j || typeof j !== 'object') continue;
            const key = str(j.id) || str(j.url);
            if (!key || byKey.has(key)) continue; // same job found by two keywords
            const mapped = mapJob(j);
            if (mapped) byKey.set(key, mapped);
          } catch {
            // One malformed posting must never lose the batch. Skip it silently.
            continue;
          }
        }

        /* The API tells us whether another page exists. Trust it, but treat a
         * short page as the end too, in case hasMore is ever wrong. */
        const pg = r.data.pagination;
        const hasMore = pg && typeof pg === 'object' ? pg.hasMore === true : false;
        if (!hasMore || jobs.length < PAGE_LIMIT) break;
      }
    }

    /* The distinction the runner depends on:
     *   null  -> the source is DOWN (every request failed)
     *   []    -> the source is UP and simply had nothing today */
    if (!anyOk) return null;
    return [...byKey.values()];
  },
};
