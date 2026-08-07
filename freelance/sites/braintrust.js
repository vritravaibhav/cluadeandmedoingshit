/*
 * sites/braintrust.js — Braintrust (app.usebraintrust.com)
 *
 * Braintrust is a real contract marketplace (kind: 'gig'), not a salaried job
 * board: clients post projects and hire contractors, so almost everything here
 * is genuinely freelance work.
 *
 * WHY THIS SOURCE MATTERS FOR THIS CANDIDATE
 * Braintrust is a Spring-Boot-ish / backend-heavy marketplace far more than a
 * Flutter one. Do not expect mobile volume here — that lives elsewhere. What it
 * does give us that almost nothing else does is a per-posting country list, so
 * we can tell up front whether an India-based contractor is even eligible.
 * That is exposed as the extra top-level boolean `indiaOk`.
 *
 * THE API (probed live, no auth, no API key, no browser needed)
 *   GET https://app.usebraintrust.com/api/jobs/?page_size=100
 *   -> 200 { count, next, previous, results: [...], total_openings_count }
 *   Today: count = 126, i.e. two pages at page_size=100.
 *
 * Keys actually present on a LIST record (verified, not guessed):
 *   id, title, employer{}, budget_minimum_usd, budget_maximum_usd, payment_type,
 *   main_skills[], created, contract_type, deadline, timezones[],
 *   expected_hours_per_week, role{}, openings_left, job_skills[], locations[],
 *   start_date, job_type
 *
 * TWO TRAPS THE LIVE PAYLOAD SET, both handled below:
 *
 *  1. `job_skills` CHANGES SHAPE between endpoints.
 *       list   -> [121434, 121435]                      (bare integer ids)
 *       detail -> [{ id, skill: { id, name }, is_top }]  (nested objects)
 *     The bare integers are useless as skill names, so on the list endpoint the
 *     real skill names come from `main_skills` ([{ id, name, ... }]) only.
 *     skillNames() below accepts every shape and silently drops the ids.
 *
 *  2. The `next` URL comes back as **http://**, not https. It does redirect to
 *     https, but we rewrite it ourselves so we never make a plaintext hop.
 *
 * The list endpoint carries NO description text. Full text lives on the detail
 * endpoint (/api/jobs/<id>/ -> description, introduction, requirements), which
 * we fetch by default because the stack matching downstream is only as good as
 * the text it gets. Set { detail: false } to skip it and run list-only.
 */

const { get, strip, rec } = require('../sources.js');

const API = 'https://app.usebraintrust.com/api/jobs/';
const JOB_URL = (id) => `https://app.usebraintrust.com/jobs/${id}/`; // verified 200 against a real id

/* ------------------------------------------------------------------ helpers */
/* Everything below assumes the feed will lie about types at some point, because
 * it already has. Coerce first, then touch. */

/** Anything -> a trimmed string. Objects become '' rather than '[object Object]'. */
function str(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return ''; // objects/arrays are handled by the dedicated helpers, not here
}

/** Anything -> a real array. Guards every `.map` in this file. */
function list(v) {
  if (Array.isArray(v)) return v.filter((x) => x != null);
  if (v == null) return [];
  return [v]; // a single object where an array was promised
}

/**
 * Pull skill names out of main_skills / job_skills, whatever shape they arrive in:
 *   'Java'                          -> 'Java'
 *   { name: 'Java' }                -> 'Java'   (main_skills, list endpoint)
 *   { skill: { name: 'Java' } }     -> 'Java'   (job_skills, detail endpoint)
 *   121434                          -> dropped  (job_skills, list endpoint: a bare id)
 * De-duplicated case-insensitively, original casing kept.
 */
function skillNames(...groups) {
  const seen = new Set();
  const out = [];
  for (const group of groups) {
    for (const raw of list(group)) {
      let name = '';
      if (typeof raw === 'string') name = raw;
      else if (typeof raw === 'number') name = ''; // bare id, no name available here
      else if (typeof raw === 'object') {
        name = str(raw.name) || str(raw.title) || str(raw.label);
        // job_skills on the detail endpoint nests the real thing one level down
        if (!name && raw.skill && typeof raw.skill === 'object') name = str(raw.skill.name);
      }
      /* A field promised as a list sometimes arrives as one delimited string
       * ('Java, Spring Boot'). Split it, same as the shared arr() helper does,
       * so it becomes two matchable skills instead of one that matches nothing. */
      for (const part of strip(name).split(/[,;|]/)) {
        const clean = part.trim();
        if (!clean) continue;
        const key = clean.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(clean);
      }
    }
  }
  return out;
}

/** '350.00' -> '350', '82.50' -> '82.5', junk/0 -> ''. Values arrive as STRINGS. */
function money(v) {
  const n = Number(str(v));
  if (!Number.isFinite(n) || n <= 0) return '';
  return String(Math.round(n * 100) / 100);
}

/**
 * Build a human budget string in which an hourly rate and a fixed project are
 * unmistakably different things — that distinction is the whole point of the field.
 * payment_type values seen live: hourly (83%), annual, per_task, monthly.
 *   hourly + 80/120 -> '80-120 USD/hr'
 *   per_task + 350  -> '350 USD/task'   (min == max collapses to one number)
 */
function budgetOf(job) {
  const lo = money(job.budget_minimum_usd);
  const hi = money(job.budget_maximum_usd);
  if (!lo && !hi) return '';

  const unit =
    {
      hourly: ' USD/hr',
      annual: ' USD/yr',
      monthly: ' USD/mo',
      per_task: ' USD/task',
      weekly: ' USD/wk',
      daily: ' USD/day',
    }[str(job.payment_type).toLowerCase()] || ' USD'; // fixed-price project: no time unit

  const amount = !lo ? hi : !hi ? lo : lo === hi ? lo : `${lo}-${hi}`;
  return amount + unit;
}

/**
 * locations[] -> a readable label plus the India eligibility flag.
 *
 * Live shape: [{ location, place_id, custom_location, location_type, country, state, city }]
 *   location_type 'google' -> a real place, country is an ISO code ('IN', 'US')
 *   location_type 'custom' -> e.g. 'United States only', country 'US'
 *   continent rows ('Asia', 'Europe', 'North America') carry country: null
 *
 * indiaOk is true when an India-based contractor is plausibly eligible:
 *   - the list is empty                -> no restriction at all, i.e. global
 *   - any entry is India / IN
 *   - any entry reads worldwide/anywhere/global/remote
 *   - any entry is the continent 'Asia' (India is in it)
 * Everything else -> false. Callers can also relax this with the detail
 * endpoint's `locations_strongly_required` (see enrich()): when that is false
 * the country list is a preference, not a hard gate.
 */
function locationOf(job) {
  const rows = list(job.locations);
  const labels = [];
  let indiaOk = rows.length === 0; // empty list == unrestricted == fine for India

  for (const row of rows) {
    // a row is normally an object, but accept a bare string without dying
    const label = typeof row === 'string' ? row : str(row && row.location);
    const country = typeof row === 'string' ? '' : str(row && row.country).toUpperCase();
    if (label) labels.push(label);

    if (country === 'IN') indiaOk = true;
    if (/\b(india|worldwide|anywhere|global|remote)\b/i.test(label)) indiaOk = true;
    if (/^asia\b/i.test(label)) indiaOk = true; // continent row: country is null, India qualifies
  }

  // de-duplicate the labels, keep order, cap the string length
  const uniq = [...new Set(labels)];
  return { location: uniq.join(', ') || 'Global', indiaOk };
}

/**
 * ISO timestamp -> 'YYYY-MM-DD'.
 * Returns '' rather than a best guess when the value will not parse: `posted` is
 * contracted to be YYYY-MM-DD or empty, and leaking a junk string into it would
 * quietly corrupt any date sorting downstream.
 */
function day(v) {
  const s = str(v);
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s.slice(0, 10))) return s.slice(0, 10);
  const d = new Date(s);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

/* ------------------------------------------------------- one record -> rec() */
/**
 * Map a single API job. Throws are the CALLER's problem to swallow (see fetch):
 * one malformed posting must never take the whole batch down with it.
 */
function toRecord(job) {
  const id = job.id;
  const { location, indiaOk } = locationOf(job);

  // employer is an object: { id, name, link, full_link, logo, ... }
  const employer = job.employer;
  const company =
    typeof employer === 'string' ? employer : str(employer && employer.name);

  // role is an object too: { id, name, name_plural, color, ... } e.g. 'Software Engineer'
  const role = str(job.role && job.role.name);

  const skills = skillNames(job.main_skills, job.job_skills);

  /* The list endpoint has no description, so synthesise searchable text out of
   * what it does give us. enrich() overwrites this with the real description
   * when the detail fetch succeeds. */
  const text = [
    str(job.title),
    role,
    skills.join(', '),
    str(job.description) || str(job.introduction) || str(job.requirements),
    str(job.expected_hours_per_week) ? `${job.expected_hours_per_week} hrs/week` : '',
    str(job.contract_type) ? `${job.contract_type}-term contract` : '',
  ]
    .filter(Boolean)
    .join('. ');

  /* Braintrust is a contract marketplace, so 'contract' is the default. The two
   * fields that can override it: job_type 'direct_hire' (11% live) is a real
   * permanent role, and payment_type 'annual' is a salary, not a project rate. */
  const jobType = str(job.job_type).toLowerCase();
  const isPerm = jobType === 'direct_hire' || str(job.payment_type).toLowerCase() === 'annual';

  return {
    ...rec({
      title: job.title,
      company,
      url: id != null ? JOB_URL(id) : '',
      text,
      skills,
      location,
      budget: budgetOf(job),
      type: isPerm ? 'remote' : 'contract',
      posted: day(job.created),
    }),
    /* Extra top-level fields rec() does not know about. indiaOk is the headline
     * one: it is what lets the report drop postings this candidate cannot take. */
    indiaOk,
    indiaSoftOk: indiaOk, // upgraded by enrich() when the detail endpoint is fetched
    id: id != null ? String(id) : '',
    role,
    contractType: str(job.contract_type), // 'short' | 'long'
    hoursPerWeek: Number(job.expected_hours_per_week) || 0,
    openings: Number(job.openings_left) || 0,
  };
}

/* --------------------------------------------------------- detail enrichment */
/**
 * Fetch /api/jobs/<id>/ and fold the real description + named job_skills back
 * into an already-built record. Best effort: any failure leaves the record as it
 * was rather than losing it.
 */
async function enrich(record, id) {
  const r = await get(`${API}${encodeURIComponent(id)}/`);
  if (!r.ok || !r.data || typeof r.data !== 'object') return record;
  const d = r.data;

  // description is HTML ('<p><span>...'), so strip() it like every other feed
  const body = [str(d.introduction), str(d.description), str(d.requirements)]
    .filter(Boolean)
    .join('\n');
  if (body) record.text = strip(`${record.text}. ${body}`).slice(0, 12000);

  // here job_skills finally carries names — merge them in on top of main_skills
  const merged = skillNames(record.skills, d.job_skills);
  if (merged.length) record.skills = merged.slice(0, 20);

  /* When locations_strongly_required is false, the country list is a stated
   * preference rather than a hard gate.
   *
   * Deliberately NOT folded into indiaOk. Live, that flag is false on ~85% of
   * postings, so folding it in took indiaOk from 24/126 to 117/126 and the field
   * stopped discriminating anything. Kept as two separate signals instead:
   *   indiaOk      strict — India is actually in the posting's country list
   *   indiaSoftOk  strict OR the country list is only a preference
   * Filter the report on indiaOk for high-confidence work, indiaSoftOk for the
   * wider "worth an application anyway" pile. */
  record.locationsRequired = d.locations_strongly_required === true;
  record.indiaSoftOk = record.indiaOk || d.locations_strongly_required === false;

  return record;
}

/** Run `fn` over `items` at most `limit` at a time. No deps — plain Promise.all batches. */
async function inBatches(items, limit, fn) {
  for (let i = 0; i < items.length; i += limit) {
    await Promise.all(items.slice(i, i + limit).map(fn));
  }
}

/* ------------------------------------------------------------------- adapter */
module.exports = {
  name: 'braintrust',
  kind: 'gig', // a real contract marketplace, not a salaried board
  homepage: 'https://www.usebraintrust.com/',

  /**
   * opts:
   *   maxPages    (10)   hard stop on pagination, so a broken `next` cannot loop forever
   *   pageSize    (100)  126 postings live == 2 pages
   *   detail      (true) fetch each posting's description; false = list-only, much faster
   *   maxDetail   (200)  cap on detail fetches, so a big day cannot stall the run
   *   concurrency (6)    parallel detail fetches
   *
   * Returns an array of records, or NULL when the source itself failed — the
   * runner uses that to tell "Braintrust is down" from "Braintrust had nothing".
   */
  async fetch(opts = {}) {
    const maxPages = Number(opts.maxPages) > 0 ? Number(opts.maxPages) : 10;
    const pageSize = Number(opts.pageSize) > 0 ? Number(opts.pageSize) : 100;
    const wantDetail = opts.detail !== false;
    const maxDetail = Number(opts.maxDetail) > 0 ? Number(opts.maxDetail) : 200;
    const concurrency = Number(opts.concurrency) > 0 ? Number(opts.concurrency) : 6;

    const out = [];
    let url = `${API}?page_size=${pageSize}`;
    let page = 0;

    while (url && page < maxPages) {
      const r = await get(url);

      if (!r.ok || !r.data || typeof r.data !== 'object') {
        // Page 1 failed => the source is down; anything later => keep what we have.
        if (page === 0) return null;
        break;
      }

      const results = list(r.data.results);
      if (page === 0 && results.length === 0) return []; // reachable, genuinely empty today

      for (const job of results) {
        // One bad posting must not lose the other 125.
        try {
          // must be a plain object (an array is typeof 'object' too) and must
          // carry something identifying, or it is noise rather than a posting
          if (!job || typeof job !== 'object' || Array.isArray(job)) continue;
          const record = toRecord(job);
          if (record.title || record.id) out.push(record);
        } catch {
          /* skip this posting and carry on */
        }
      }

      page += 1;

      /* `next` arrives as http:// and 301s to https — upgrade it ourselves so we
       * never make the plaintext hop. Ignore anything that is not a Braintrust
       * URL, so a poisoned `next` cannot redirect the crawl off-site. */
      const next = str(r.data.next);
      url = /^https?:\/\/app\.usebraintrust\.com\//i.test(next)
        ? next.replace(/^http:\/\//i, 'https://')
        : '';
    }

    if (wantDetail && out.length) {
      const targets = out.slice(0, maxDetail).filter((x) => x.id);
      try {
        await inBatches(targets, concurrency, async (record) => {
          try {
            await enrich(record, record.id);
          } catch {
            /* keep the list-level record as-is */
          }
        });
      } catch {
        /* enrichment is a bonus; never fail the whole source over it */
      }
    }

    return out;
  },
};
