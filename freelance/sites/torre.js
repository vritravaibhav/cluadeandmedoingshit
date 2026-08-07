/*
 * sites/torre.js — Torre (torre.ai), read through its public search API.
 *
 * WHAT TORRE IS
 * -------------
 * Torre is a talent marketplace. It carries two different kinds of posting in
 * one index, and the distinction is the whole reason this adapter is worth
 * having:
 *
 *   opportunity: 'flexible-job'  a gig / freelance / contract engagement
 *   opportunity: 'employee'      a normal salaried job
 *   opportunity: 'intern'        an internship
 *
 * In a 360-posting live sample only ~16% were 'flexible-job', so the honest
 * classification for the whole source is kind: 'remote' (a job board that
 * carries a contract minority), not kind: 'gig'. It is not a bidding
 * marketplace — you apply, you do not bid. Each record is still individually
 * tagged type:'contract' vs type:'remote' so the report can split them.
 *
 * WHY THIS SOURCE IS ON THE LIST AT ALL
 * -------------------------------------
 * Torre is one of the few open sources where BOTH halves of this candidate's
 * stack show up. Live totals for the 1-plus-year experience band:
 *   java 3336 | backend 3107 | react native 2204 | android 748
 *   flutter 428 | spring boot 218
 * Spring Boot depth and Flutter depth normally live on different platforms;
 * here they coexist, so every record gets a `stack` tag (see tagStack) and the
 * report can separate "Spring Boot demand" from "Flutter demand" rather than
 * treating one number as evidence for the other.
 *
 *
 * ============================ VERIFIED, NOT GUESSED =======================
 * Everything below was read off a live payload before it was written. Three
 * things in the original spec turned out to be WRONG on the wire, and are
 * corrected here. If you ever revisit this file, re-probe before you "fix" it.
 *
 * 1. THE URL FORM IS NOT /post/<slug>.
 *      https://torre.ai/post/<slug>          -> 302 to https://torre.ai/404
 *      https://torre.ai/post/<id>            -> 301 to /post/<id>-<slug>
 *      https://torre.ai/post/<id>-<slug>     -> 200   <-- the canonical form
 *    So the URL is built from BOTH id and slug. Slug can be null (seen live),
 *    in which case the bare /post/<id> form is used and Torre redirects.
 *
 * 2. THE ?offset= PARAM IS A NO-OP. This is the dangerous one.
 *    Requesting offset=0, offset=20 and offset=40 for the same term returned
 *    the SAME 20 records all three times, and the response echoed "offset": 0
 *    every time. A naive offset loop therefore does not fail — it silently
 *    returns page 1 over and over, and after de-duplication you are left with
 *    20 postings while believing you fetched 100. Real pagination is a
 *    search_after style cursor:
 *        response.pagination.next  ->  send back as  ?after=<cursor>
 *    Only `after` works; `next`, `page`, `lastId`, `pagination`, and a
 *    body-level pagination object were all tested and all returned page 1.
 *    Verified: 5 sequential cursor pages per term = 100 unique ids, 0 dupes.
 *
 * 3. THERE IS NO DESCRIPTION FIELD. The search payload carries `objective`
 *    (the title) and `tagline` (one sentence) and nothing longer. `text` is
 *    therefore built from tagline + skill names. See UNMAPPED at the bottom.
 *
 *
 * WHY A LOCAL postJson()
 * ----------------------
 * This endpoint requires POST with a JSON body. The shared get() helper in
 * ../sources.js is GET-only — it calls fetch() with no method and no body
 * option, so there is no way to make it POST. sources.js is shared by every
 * other adapter and is deliberately NOT modified here; instead this file
 * carries a small node:https POST helper that returns the exact same
 * { ok, status, data } shape get() returns, so the code below reads the same
 * as every other adapter in the project.
 *
 *
 * A NOTE ON DEFENSIVENESS (for a Java/Spring dev reading this)
 * -----------------------------------------------------------
 * There is no schema and no compiler here. A field that is a string today is
 * null tomorrow and an object the day after — that is normal for these feeds,
 * and one such field already killed a whole source mid-run in this project.
 * So: every value is coerced before it is touched, nothing is assumed to be an
 * array just because it was an array last time, and each record is mapped
 * inside its own try/catch so one malformed posting is skipped instead of
 * throwing away the other 99. Think of it as every field being Optional<Object>
 * rather than a typed DTO.
 */

const https = require('node:https');
const { strip, rec } = require('../sources.js');

/* Search terms, one query each, results merged and de-duplicated by id.
 * These are deliberately split across both halves of the candidate's stack. */
const TERMS = ['flutter', 'java', 'spring boot', 'android', 'react native', 'backend'];

/* Torre's experience bands. '1-plus-year' is the right floor for a ~2-year
 * developer: it excludes pure-junior postings without demanding senior. */
const EXPERIENCE = '1-plus-year';

const HOST = 'search.torre.co';
const PATH = '/opportunities/_search/';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* ------------------------------------------------------------------ helpers */

/* Coerce anything to a plain string. null/undefined/objects never reach the
 * string methods below, which is where these feeds usually blow up. */
const s = (v) => {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return ''; // objects/arrays are never meaningfully a string here
};

/* Coerce anything to an array. Never trust Array.isArray to be true. */
const list = (v) => (Array.isArray(v) ? v.filter((x) => x != null) : v == null ? [] : [v]);

/* A finite number, or null. Torre sends 0 for "to be agreed" and null for an
 * open-ended maximum, so both have to be distinguishable from a real amount. */
const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(s(v));
  return Number.isFinite(n) ? n : null;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * postJson — minimal POST helper on node:https.
 *
 * Exists only because the shared get() cannot POST (see header). Returns the
 * same { ok, status, data } contract get() returns so callers look identical.
 * Never throws: a DNS failure, a timeout and a 500 all come back as ok:false.
 */
function postJson(url, bodyObj, { timeout = 25000 } = {}) {
  return new Promise((resolve) => {
    let body;
    try {
      body = Buffer.from(JSON.stringify(bodyObj), 'utf8');
    } catch {
      return resolve({ ok: false, status: 0, error: 'bad-request-body' });
    }

    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };

    let u;
    try {
      u = new URL(url);
    } catch {
      return finish({ ok: false, status: 0, error: 'bad-url' });
    }

    const req = https.request(
      {
        method: 'POST',
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: {
          'user-agent': UA,
          'content-type': 'application/json',
          accept: 'application/json,*/*',
          'content-length': body.length,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode || 0;
          if (status < 200 || status >= 300) return finish({ ok: false, status, text });
          try {
            return finish({ ok: true, status, data: JSON.parse(text) });
          } catch {
            return finish({ ok: false, status, error: 'bad-json', text });
          }
        });
      }
    );

    /* A hung socket must not hang the whole sweep. */
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    req.on('error', (e) => finish({ ok: false, status: 0, error: String((e && e.message) || e) }));
    req.write(body);
    req.end();
  });
}

/*
 * Language hint. Torre is Latin-America-first, so a large share of postings are
 * Spanish or Portuguese (67 of 360 in the live sample carried accented text,
 * and more are unaccented Spanish). These are kept — a Spanish-language posting
 * for a remote Flutter contract is still a real lead — but tagged so the report
 * can filter or flag them.
 *
 * Returns '' for "looks like English", otherwise 'es', 'pt' or 'non-en'.
 *
 * Heuristic, deliberately conservative: a title needs either an accented
 * character or TWO distinct Romance stopwords before it is called non-English,
 * because single common words ("de", "la") do turn up inside English titles.
 */
function langHint(text) {
  const t = s(text).toLowerCase();
  if (!t) return '';

  /* Non-Latin scripts are unambiguous — no stopword logic needed. */
  if (/[Ѐ-ӿ一-鿿぀-ヿ؀-ۿऀ-ॿ]/.test(t)) return 'non-en';

  const accented = /[áéíóúñçãõâêôàüï]/.test(t);

  const esWords = ['desarrollador', 'desarrollo', 'ingeniero', 'programador', 'buscamos', 'conocimientos', 'experiencia', 'empresa', 'trabajo', 'para', 'con', 'una', 'del', 'los', 'las'];
  const ptWords = ['desenvolvedor', 'desenvolvimento', 'vaga', 'voce', 'você', 'pessoa', 'atuar', 'com', 'para', 'uma', 'dos', 'nas'];

  const hits = (words) => words.filter((w) => new RegExp(`\\b${w}\\b`, 'i').test(t)).length;
  const es = hits(esWords);
  const pt = hits(ptWords);

  if (!accented && es < 2 && pt < 2) return '';

  /* Portuguese-only giveaways outrank the shared Spanish/Portuguese words.
   * Note these are substring tests, not \b-anchored: ç/ã/õ are not \w
   * characters, so a word boundary before them does not mean what you expect. */
  if (/desenvolvedor|desenvolvimento|vaga|voc[êe]|ção|ções|õe|ã/.test(t)) return 'pt';
  if (pt > es) return 'pt';
  return 'es';
}

/*
 * Tag which half of the candidate's stack a posting actually matched.
 *
 * This is the point of the whole exercise: Spring Boot demand and Flutter
 * demand are different markets, and a posting that merely mentions "Java"
 * because it says "Java or Kotlin" is not Spring Boot demand. Tags are drawn
 * from title + tagline + Torre's own structured skill names, which are the
 * most reliable signal in the payload.
 */
function tagStack(haystack) {
  const t = s(haystack).toLowerCase();
  const tags = [];
  const add = (tag, re) => {
    if (re.test(t)) tags.push(tag);
  };

  add('java', /\bjava\b(?!script)/);
  add('spring', /\bspring\b|spring ?boot/);
  add('microservices', /microservi/); // matches microservices / microservicios / microsserviços
  add('mysql', /\bmysql\b/);
  add('docker', /\bdocker\b|kubernetes|\bk8s\b/);
  add('flutter', /\bflutter\b|flutterflow/);
  add('dart', /\bdart\b/);
  add('android', /\bandroid\b/);
  add('ndk-jni', /\bndk\b|\bjni\b/);
  add('webrtc', /webrtc/);
  add('firebase', /firebase/);
  add('react-native', /react ?native/);
  add('backend', /\bback ?end\b|\bbackend\b/);

  return [...new Set(tags)];
}

/*
 * Is this a contract/freelance engagement rather than a salaried job?
 *
 * Primary signal is Torre's own taxonomy — opportunity 'flexible-job' /
 * type 'flexible-jobs' IS Torre's freelance/gig category, confirmed live.
 * The keyword pass is a secondary net for employment-typed postings whose text
 * says contract anyway, in English, Spanish and Portuguese.
 */
function isContract(o, haystack) {
  const opportunity = s(o.opportunity).toLowerCase();
  const type = s(o.type).toLowerCase();
  if (opportunity === 'flexible-job' || type.includes('flexible')) return true;

  const period = s(o.compensation && o.compensation.data && o.compensation.data.periodicity).toLowerCase();
  if (period === 'project') return true; // paid per project = not a salary

  return /\b(freelance|freelancer|contract|contractor|contrato|contractual|autónomo|autonomo|aut[oó]noma|prestador)\b/i.test(s(haystack));
}

/*
 * Human-readable budget from Torre's compensation object. Verified shape:
 *
 *   compensation: {
 *     visible: true|false,
 *     data: {                       // null when visible is false
 *       code: 'range'|'fixed'|'to-be-agreed'|'get-quotes',
 *       currency: 'USD'|'INR'|'COP'|...|null,
 *       minAmount, maxAmount,       // maxAmount can be null; both 0 when unset
 *       minHourlyUSD, maxHourlyUSD,
 *       periodicity: 'hourly'|'monthly'|'yearly'|'project'|null,
 *       negotiable: bool
 *     }
 *   }
 *
 * 'to-be-agreed' and 'get-quotes' carry 0/0 — no number exists, so budget is ''
 * rather than a misleading "0-0". Matches how the freelancer.com adapter treats
 * a missing budget.
 *
 * UNIT-ENTRY ERRORS. Torre stores whatever the poster typed, and Indian posters
 * routinely type an annual salary in lakhs. Live examples, both real:
 *   "Senior Software Engineer - Java & React"  minAmount 12,  INR, yearly
 *   "Java Developer + App Support Engineer"    minAmount 26,  INR, yearly
 * These mean 12 LPA and 26 LPA (1.2M and 2.6M INR). Torre does not correct them
 * either — it derives minHourlyUSD 0.000065 from the 12. Rendering "12 INR/yr"
 * would put a number in the report that is wrong by five orders of magnitude,
 * so any monthly or yearly figure below PLAUSIBLE_FLOOR is treated as an entry
 * error and dropped to ''. It is not rescaled — guessing that 12 meant 1200000
 * would be inventing data. Hourly and per-project rates are exempt, because a
 * genuine hourly rate really is a small number (16-25 USD/hr is normal here).
 */

/* Below this, a monthly/yearly figure in ANY currency is a data-entry error
 * rather than a real wage. Deliberately low so that a modest but genuine
 * salary (e.g. 900 USD/mo) still comes through. */
const PLAUSIBLE_FLOOR = 100;

function budgetOf(o) {
  const comp = o && o.compensation;
  if (!comp || typeof comp !== 'object') return '';
  if (comp.visible === false) return '';

  const d = comp.data;
  if (!d || typeof d !== 'object') return '';

  const code = s(d.code).toLowerCase();
  if (code === 'to-be-agreed' || code === 'get-quotes') return '';

  const min = num(d.minAmount);
  const max = num(d.maxAmount);
  if (!min && !max) return ''; // both null or both 0 -> no real figure

  const cur = s(d.currency) || 'USD';
  const period = s(d.periodicity).toLowerCase();
  const suffix = { hourly: '/hr', monthly: '/mo', yearly: '/yr' }[period] || '';

  /* Drop poster unit-entry errors on salaried periods — see note above. */
  if (period === 'monthly' || period === 'yearly') {
    const top = Math.max(min || 0, max || 0);
    if (top < PLAUSIBLE_FLOOR) return '';
  }

  /* Render as "min-max CUR/unit", or a single figure when there is no range. */
  let amount;
  if (min && max && min !== max) amount = `${min}-${max}`;
  else if (min && max && min === max) amount = `${min}`;
  else amount = `${min || max}`;

  return `${amount} ${cur}${suffix}`.trim();
}

/* Where the work can be done. `locations` is an array of country strings and is
 * empty when the posting is open to anywhere; `place.anywhere` marks that case. */
function locationOf(o) {
  const locs = list(o.locations).map(s).filter(Boolean);
  if (locs.length) return locs.join(', ');
  const place = o.place && typeof o.place === 'object' ? o.place : {};
  if (place.anywhere) return 'Anywhere (remote)';
  if (o.remote) return 'Remote';
  return '';
}

/* ------------------------------------------------------------------ adapter */

module.exports = {
  name: 'torre',
  kind: 'remote', // job board with a contract minority — see header
  homepage: 'https://torre.ai',

  /*
   * opts:
   *   maxPerTerm  hard cap on postings KEPT per search term (default 100)
   *   maxPages    hard cap on requests per search term (default 30) — see below
   *   size        page size (default 20)
   *   terms       override the TERMS list
   *   includeClosed  keep status!=='open' postings (default false)
   *   delayMs     politeness pause between requests (default 250)
   *
   * WHY maxPages EXISTS, AND WHY `total` LIES
   * -----------------------------------------
   * response.total counts CLOSED postings as well as open ones, and Torre keeps
   * closed postings in the index for a long time. Measured live: the 'flutter'
   * term reports total 428, but walking the cursor to exhaustion (22 pages)
   * yields 21 open and 407 closed. So `total` is not a count of anything you
   * can apply to, and maxPerTerm — which counts records KEPT — cannot on its own
   * bound how many HTTP requests a sparse term costs. maxPages provides that
   * bound so one dead term cannot stall the sweep.
   */
  async fetch(opts = {}) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const maxPerTerm = num(o.maxPerTerm) || 100;
    const maxPages = num(o.maxPages) || 30;
    const size = num(o.size) || 20;
    const terms = list(o.terms).map(s).filter(Boolean);
    const searchTerms = terms.length ? terms : TERMS;
    const includeClosed = o.includeClosed === true;
    const delayMs = num(o.delayMs) == null ? 250 : num(o.delayMs);

    const byId = new Map(); // de-duplication across terms, keyed on Torre's id
    let termsOk = 0; // how many terms returned a usable first page

    for (const term of searchTerms) {
      let after = ''; // cursor; empty on the first page
      let pulled = 0; // records KEPT for this term
      let pages = 0; // requests spent on this term
      /* "the server answered us with valid JSON", NOT "the server had results".
       * These must stay separate: a term that legitimately matches nothing is
       * still proof the source is alive, and conflating the two would report a
       * healthy Torre as down on a quiet day. */
      let termResponded = false;

      while (pulled < maxPerTerm && pages < maxPages) {
        const url =
          `https://${HOST}${PATH}?size=${encodeURIComponent(size)}` +
          (after ? `&after=${encodeURIComponent(after)}` : '');

        /* NOTE: no &offset= here on purpose. It is accepted and ignored by the
         * server — see item 2 in the header. The cursor is the only real pager. */
        const r = await postJson(url, { 'skill/role': { text: term, experience: EXPERIENCE } });

        pages++;

        if (!r.ok || !r.data || typeof r.data !== 'object') break; // this term is done

        /* Set before the empty check — an empty page is a valid answer. */
        termResponded = true;

        const results = list(r.data.results);
        if (!results.length) break;

        for (const raw of results) {
          /* One bad posting must never cost us the batch. */
          try {
            if (!raw || typeof raw !== 'object') continue;

            const id = s(raw.id);
            if (!id) continue;
            if (byId.has(id)) continue; // already seen under another term

            if (!includeClosed && s(raw.status).toLowerCase() !== 'open') continue;

            const title = s(raw.objective);
            if (!title) continue; // a posting with no title is unusable

            const slug = s(raw.slug);
            /* Verified: /post/<id>-<slug> is 200; /post/<slug> is a 404.
             * When slug is null (it happens) the bare id form 301s to the
             * canonical URL, so it is still a working link. */
            const url_ = slug
              ? `https://torre.ai/post/${id}-${slug}`
              : `https://torre.ai/post/${id}`;

            /* organizations[] can be empty — 4 of 360 live. */
            const org = list(raw.organizations)[0];
            const company = org && typeof org === 'object' ? s(org.name) : '';

            /* skills[] elements are { name, experience, proficiency }. */
            const skills = list(raw.skills)
              .map((sk) => (typeof sk === 'string' ? sk : sk && typeof sk === 'object' ? s(sk.name) : ''))
              .filter(Boolean);

            const tagline = s(raw.tagline);

            /* There is no long description in the search payload, so the best
             * available body text is the tagline plus the structured skills. */
            const text = [tagline, skills.length ? `Skills: ${skills.join(', ')}` : '']
              .filter(Boolean)
              .join(' — ');

            const haystack = `${title} ${tagline} ${skills.join(' ')}`;

            const posted = s(raw.created).slice(0, 10); // '2026-08-04T20:47:15.000Z' -> '2026-08-04'

            /* rec() normalises and truncates the shared nine fields; lang and
             * stack are Torre-specific hints the report reads, so they are
             * added alongside rather than passed through rec(). */
            const record = rec({
              title,
              company,
              url: url_,
              text,
              skills,
              location: locationOf(raw),
              budget: budgetOf(raw),
              type: isContract(raw, haystack) ? 'contract' : 'remote',
              posted,
            });

            record.lang = langHint(`${title} ${tagline}`); // '' when it reads as English
            record.stack = tagStack(haystack); // which half of the stack matched
            record.term = term; // which query surfaced it, useful when debugging

            /* indiaOk — the other three adapters expose this, so the report can
             * filter on one field across every source. Torre has no explicit
             * country-eligibility list, so it is INFERRED from the location
             * string rather than read: 'Anywhere (remote)' and anything naming
             * India is workable; a posting pinned to a specific other country
             * is not. Inference, not ground truth — a remote posting may still
             * carry an unstated timezone or work-authorisation requirement. */
            const loc = String(record.location || '').toLowerCase();
            record.indiaOk =
              loc === '' ||
              /\b(anywhere|worldwide|global|remote)\b/.test(loc) ||
              /\bindia\b|\bIN\b/i.test(loc);
            record.indiaOkInferred = true; // distinguishes this from Arc's real flag

            byId.set(id, record);
            pulled++;
            if (pulled >= maxPerTerm) break;
          } catch {
            continue; // skip the bad posting, keep the rest
          }
        }

        /* Advance the cursor. No cursor means we have reached the end. */
        const next = r.data.pagination && s(r.data.pagination.next);
        if (!next || next === after) break;
        after = next;

        if (delayMs > 0) await sleep(delayMs);
      }

      if (termResponded) termsOk++;
      if (delayMs > 0) await sleep(delayMs);
    }

    /* Distinguish "source is down" from "source had nothing today". If not one
     * single term managed a usable response, treat the source as down. If terms
     * responded but matched nothing, that is a real empty result. */
    if (termsOk === 0) return null;
    return [...byId.values()];
  },
};
