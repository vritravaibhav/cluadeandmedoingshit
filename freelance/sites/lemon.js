/*
 * sites/lemon.js — Lemon.io (https://lemon.io/for-developers/<role>-jobs/)
 *
 * WHAT THIS SOURCE IS
 * -------------------
 * Lemon.io is a vetted freelance marketplace: you pass their vetting once, then
 * they match you to client projects. Unlike Gun.io / Toptal / Contra — whose
 * opportunity lists all sit behind a login — Lemon.io publishes its currently
 * open engagements on public, server-rendered SEO landing pages, one page per
 * role/skill, and marks each one up as a schema.org JobPosting.
 *
 * That marks-up is the whole reason this adapter exists. Every gig ships as:
 *
 *     <script type="application/ld+json">
 *       {"@context":"https://schema.org","@type":"JobPosting", ... }
 *     </script>
 *
 * VERIFIED LIVE ON 2026-08-08 across all seven pages below: 63 JobPosting
 * records, 61 of them distinct. Field coverage was total, not partial:
 *     employmentType            CONTRACTOR   63/63
 *     jobLocationType           TELECOMMUTE  63/63
 *     applicantLocationRequirements "Worldwide" 63/63
 *     baseSalary (USD, unitText HOUR)        63/63
 *     datePosted / validThrough              63/63
 *     datePosted range 2026-07-02 .. 2026-08-02  (i.e. genuinely current)
 *
 * For a Java/Spring dev: JSON-LD is a contract the site publishes *for machines*
 * (Google Jobs consumes it). That makes it far more stable than CSS selectors —
 * Lemon.io can restyle the page freely without breaking us, because breaking the
 * JSON-LD would drop them out of Google's job results. We therefore treat the
 * JSON-LD as the source of truth and the surrounding HTML card as *optional*
 * enrichment that is allowed to fail silently.
 *
 * WHY THIS SOURCE IS WORTH HAVING
 * -------------------------------
 * 1. It is real contract work. Every record is employmentType CONTRACTOR with an
 *    hourly rate and a stated duration ("3-4 months", "1 month"). This is not a
 *    salaried remote-job board dressed up as gig work.
 * 2. It is geographically open. applicantLocationRequirements is "Worldwide" on
 *    every record, so an India-based candidate is eligible — Lemon.io's own copy
 *    cites rate observations "across 71+ countries". Contrast Arc, where a third
 *    of the good Java roles turn out to be NA/LATAM-only.
 * 3. Its role pages cover BOTH halves of this candidate's stack. The Java and
 *    Spring pages carry Spring Boot / microservices / Kafka backend work; the
 *    Flutter, Android and Mobile pages carry Dart/Flutter and Kotlin work. Those
 *    two demand pools rarely coexist on one platform.
 *
 * THE ONE TRAP IN THIS SOURCE — READ BEFORE EDITING
 * -------------------------------------------------
 * The JSON-LD `url` field is the *landing page*, not a per-gig permalink. All 9
 * gigs on the Java page carry url="https://lemon.io/for-developers/java-developer-jobs/".
 * Measured: 63 records -> 7 distinct urls. There are no per-gig pages and no
 * per-card anchors to deep-link to; the apply button is a single shared
 * "get matched" funnel.
 *
 * So DE-DUPLICATION MUST NOT KEY ON URL. Doing so would collapse 63 gigs into 7
 * and silently discard 90% of this source. We key on title + description instead
 * (see dedupeKey below). This is the single most likely way for a future edit to
 * quietly break this adapter, which is why it is called out this loudly.
 */

const { get, strip, rec } = require('../sources.js');

const BASE = 'https://lemon.io/for-developers';

/*
 * The role pages to sweep, chosen for this candidate's stack (Java/Spring Boot
 * backend + Flutter/Dart & Android mobile) rather than scraped wholesale.
 *
 * Lemon.io's dev-job sitemap (https://lemon.io/dev-job-sitemap.xml) lists 52 of
 * these pages. We deliberately take 7. The other 45 are Rust/Solidity/Shopify/
 * UI-UX and similar — fetching them would quadruple the request count and the
 * runtime to add postings the scorer would only throw away. If the candidate's
 * stack changes, widen this list; the sitemap is the menu.
 *
 * All seven verified HTTP 200 with exactly 9 JobPosting records each, and the
 * sets are genuinely role-specific rather than one shared "featured" block:
 * measured pairwise overlap between pages was 0 or 1.
 */
const SLUGS = [
  'java-developer-jobs',
  'spring-developer-jobs',
  'back-end-engineer-jobs',
  'full-stack-developer-jobs',
  'flutter-developer-jobs',
  'android-developer-jobs',
  'mobile-developer-jobs',
];

/* ------------------------------------------------------------------ helpers */

/* Coerce anything to a trimmed string. JSON-LD in the wild is not schema-stable:
 * a field that is a string on one page arrives as null or as a { name } wrapper
 * on the next, and calling .trim() on null is what kills a source mid-run. */
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

/* Coerce anything to an array of strings — real array, single string, delimited
 * string, array of objects, or null. Never assume an array is an array. */
function toList(v) {
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v.map(s).filter(Boolean);
  if (typeof v === 'string') return v.split(/[,;|]/).map((x) => x.trim()).filter(Boolean);
  if (typeof v === 'object') return Object.values(v).map(s).filter(Boolean);
  return [s(v)].filter(Boolean);
}

/*
 * Pull every <script type="application/ld+json"> payload out of the page.
 *
 * A page carries ~11 of these; only some are JobPostings (the others are
 * Organization, FAQPage, BreadcrumbList). We parse them all and filter by
 * @type afterwards.
 *
 * Each block is returned WITH the character offset it was found at, because the
 * card enrichment step needs to know which slice of HTML surrounds it.
 *
 * A single malformed block must not cost us the other ten, so each JSON.parse is
 * individually guarded.
 */
function extractLdJson(html) {
  const out = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let parsed;
    try {
      parsed = JSON.parse(m[1].trim());
    } catch (e) {
      continue; // truncated or malformed block — skip it, keep the rest
    }
    // A block may hold one object or an array of them; @graph is also legal.
    const items = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed && parsed['@graph'])
        ? parsed['@graph']
        : [parsed];
    for (const item of items) {
      if (item && typeof item === 'object') out.push({ item, index: m.index });
    }
  }
  return out;
}

function isJobPosting(o) {
  const t = o && o['@type'];
  if (typeof t === 'string') return t === 'JobPosting';
  if (Array.isArray(t)) return t.some((x) => x === 'JobPosting');
  return false;
}

/*
 * Split the page into its visual job cards.
 *
 * Markup shape (verified): each gig is one
 *     <div class="card"> <script ld+json/> ...card-part blocks... </div>
 * The inner blocks are class="card-part" / "card-title" / "card-tags", so
 * splitting on the EXACT string `<div class="card">` — closing quote included —
 * cannot accidentally match a nested element. Measured on the Java page: 12
 * segments, 9 of which contain a JobPosting. The 3 extras are non-job cards.
 *
 * Returns [{ start, end }] character ranges so a JobPosting found at offset N
 * can be matched to the card that encloses it.
 */
function cardRanges(html) {
  const marker = '<div class="card">';
  const ranges = [];
  let i = html.indexOf(marker);
  while (i !== -1) {
    const next = html.indexOf(marker, i + marker.length);
    ranges.push({ start: i, end: next === -1 ? html.length : next });
    i = next;
  }
  return ranges;
}

function cardHtmlFor(html, ranges, index) {
  for (const r of ranges) {
    if (index >= r.start && index < r.end) return html.slice(r.start, r.end);
  }
  return '';
}

/* Grab the inner text of the first element matching a class, as plain text.
 * Returns '' when absent — every caller treats that as "not provided". */
function pick(cardHtml, className, tag) {
  const t = tag || 'div';
  const re = new RegExp(`<${t}[^>]*class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)</${t}>`, 'i');
  const m = cardHtml.match(re);
  return m ? strip(m[1]) : '';
}

/*
 * The card's "Tech stack" chip list — the cleanest skills signal on the page,
 * e.g. ["React","Java","Spring Boot","PostgreSQL","AWS","Kubernetes"].
 *
 * Scoped to the window AFTER the literal "Tech stack" heading so we cannot pick
 * up some other chip list elsewhere in the card. Enrichment only: if Lemon.io
 * restyles and this stops matching, skills fall back to regex tagging of the
 * description and the record is still perfectly usable.
 */
function techStack(cardHtml) {
  const at = cardHtml.indexOf('Tech stack');
  if (at === -1) return [];
  const window = cardHtml.slice(at, at + 3000);
  const block = window.match(/<div[^>]*class=["'][^"']*\bcard-tags\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
  if (!block) return [];
  const tags = [];
  const re = /<span[^>]*class=["'][^"']*\btag\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi;
  let m;
  while ((m = re.exec(block[1])) !== null) {
    const v = strip(m[1]);
    if (v) tags.push(v);
  }
  return tags;
}

/*
 * Stack tagging — kept identical in spirit to sites/arc.js so the report can
 * compare like with like, and so backend Java work stays separable from mobile
 * Flutter work instead of collapsing into one relevance score.
 */
const STACK = [
  ['java', /\bjava\b(?!script)/i],
  ['spring-boot', /spring[\s-]?boot|\bspring\b/i],
  ['microservices', /micro[\s-]?services?/i],
  // MySQL specifically is the candidate's depth; bare SQL/Postgres is a weaker,
  // separate signal, so tagging that as 'mysql' would be a false positive.
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

/*
 * baseSalary -> a short human string.
 * Measured: 63/63 records are { currency: USD, value: { minValue, maxValue,
 * unitText: 'HOUR' } }. unitText is still honoured rather than hardcoded to /hr,
 * because a future MONTH/YEAR record must not be mislabelled as hourly — that
 * would misrepresent a $6000/month gig as $6000/hour in the report.
 */
const UNIT_LABEL = { HOUR: '/hr', DAY: '/day', WEEK: '/wk', MONTH: '/mo', YEAR: '/yr' };

function budgetOf(baseSalary) {
  const bs = baseSalary && typeof baseSalary === 'object' ? baseSalary : null;
  if (!bs) return '';
  const val = bs.value && typeof bs.value === 'object' ? bs.value : {};
  const cur = s(bs.currency) || 'USD';
  const unit = UNIT_LABEL[String(s(val.unitText)).toUpperCase()] || '';

  const min = Number(val.minValue);
  const max = Number(val.maxValue);
  const flat = Number(val.value);

  if (Number.isFinite(min) && min > 0 && Number.isFinite(max) && max > 0) {
    return `${min}-${max} ${cur}${unit}`;
  }
  if (Number.isFinite(min) && min > 0) return `${min}+ ${cur}${unit}`;
  if (Number.isFinite(max) && max > 0) return `up to ${max} ${cur}${unit}`;
  if (Number.isFinite(flat) && flat > 0) return `${flat} ${cur}${unit}`;
  return '';
}

/* ISO date -> YYYY-MM-DD. Tolerates epoch seconds/ms in case the markup changes. */
function dateOf(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number' && Number.isFinite(v)) {
    const d = new Date(v > 1e11 ? v : v * 1000);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  }
  const str = s(v);
  if (!str) return '';
  if (/^\d+$/.test(str)) return dateOf(Number(str));
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

/*
 * India eligibility, same top-level `indiaOk` contract sites/arc.js established.
 *
 * applicantLocationRequirements is "Worldwide" on all 63 live records, so this
 * is effectively always true today. It is still computed rather than hardcoded:
 * the day Lemon.io starts publishing region-locked gigs, a hardcoded `true`
 * would send the candidate at roles they cannot take, and we would not notice.
 */
function isIndiaOk(alr) {
  const names = toList(alr && typeof alr === 'object' && !Array.isArray(alr) ? [alr] : alr)
    .concat(
      Array.isArray(alr)
        ? alr.map((x) => s(x))
        : [s(alr)]
    )
    .filter(Boolean);

  if (!names.length) return true; // nothing stated => no restriction recorded
  return names.some((n) => /worldwide|anywhere|global|remote|\bindia\b|^IN$/i.test(String(n).trim()));
}

function locationOf(alr) {
  const names = Array.isArray(alr) ? alr.map(s).filter(Boolean) : [s(alr)].filter(Boolean);
  if (!names.length) return 'Worldwide';
  if (names.length <= 6) return names.join(', ');
  return `${names.length} countries`;
}

/*
 * De-dup key. See "THE ONE TRAP" at the top of this file: url is NOT unique
 * here (7 urls for 63 gigs), so it must never be used as the key. Title alone is
 * also not enough — a single page legitimately carries three different gigs all
 * titled "Senior Backend Developer". Title + the head of the description is what
 * actually separates them, and it correctly found 61 distinct gigs in 63 records
 * (the 2 collisions being one genuine cross-listing on the Java/Spring pages).
 */
function dedupeKey(title, description) {
  return `${title}||${String(description || '').slice(0, 120)}`
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/* ------------------------------------------------------------ record mapping */

function mapJob(job, cardHtml, pageUrl) {
  if (!job || typeof job !== 'object') return null;

  const title = s(job.title);
  if (!title) return null; // a posting with no title is unusable

  const description = s(job.description);

  // Card enrichment — every one of these is allowed to come back ''.
  const industry = pick(cardHtml, 'card-top-line-left');
  const stage = pick(cardHtml, 'card-top-line-right');
  const duration = pick(cardHtml, 'card-month', 'span');
  const rateText = pick(cardHtml, 'card-rate', 'span');
  const stack = techStack(cardHtml);

  // "why devs choose this" is Lemon.io's own pitch for the engagement; it often
  // names the team size, the autonomy level and the codebase quality, which is
  // real signal when deciding whether to spend an application on it.
  const whyMatch = cardHtml.match(
    /why devs choose this<\/div>\s*<div[^>]*class=["'][^"']*\bcard-part-text\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
  );
  const why = whyMatch ? strip(whyMatch[1]) : '';

  // Skills: prefer the explicit chip list, fall back to tagging the prose.
  const skills = stack.length ? stack : tagStack(`${title} ${description}`);

  const text = [
    title,
    industry ? `Sector: ${industry}` : '',
    stage ? `Company stage: ${stage}` : '',
    duration ? `Duration: ${duration}` : '',
    rateText ? `Rate: ${rateText}` : '',
    stack.length ? `Tech stack: ${stack.join(', ')}` : '',
    description,
    why ? `Why devs choose this: ${why}` : '',
  ].filter(Boolean).join('. ');

  const out = rec({
    title,
    // The end client is never named — Lemon.io intermediates every engagement
    // and only describes the client by sector/stage. Emitting '' would render a
    // blank cell that reads like a scrape failure, so label the absence.
    company: industry ? `Lemon.io client — ${industry}` : 'Lemon.io client (undisclosed)',
    // Landing page, not a permalink. There is no per-gig page to link to; see
    // the header note. The gig IS on this page, so the link is honest.
    url: s(job.url) || pageUrl,
    text,
    skills,
    location: locationOf(job.applicantLocationRequirements),
    budget: budgetOf(job.baseSalary),
    // employmentType is CONTRACTOR on 63/63. Still derived, not assumed.
    type: /contract|freelance|temporary/i.test(s(job.employmentType)) ? 'contract' : 'remote',
    posted: dateOf(job.datePosted),
  });

  // ---- extras attached AFTER rec(), which returns a fixed shape and drops
  // ---- any unknown keys passed into it.
  out.indiaOk = isIndiaOk(job.applicantLocationRequirements);
  out.stack = tagStack(`${title} ${description} ${stack.join(' ')}`);
  out.duration = duration;
  out.validThrough = dateOf(job.validThrough);
  out.sourcePage = pageUrl;

  return out;
}

/* ------------------------------------------------------------------ adapter */

module.exports = {
  name: 'lemon.io',
  // 'gig': every record is employmentType CONTRACTOR with an hourly rate and a
  // fixed duration. This is project work, not a salaried board.
  kind: 'gig',
  homepage: 'https://lemon.io/for-developers/',

  async fetch(opts = {}) {
    const log = typeof opts.log === 'function' ? opts.log : () => {};

    const out = [];
    const seen = new Set();
    let pagesOk = 0;
    let expired = 0;

    // Today, as YYYY-MM-DD, for the validThrough check below.
    const today = new Date().toISOString().slice(0, 10);

    for (const slug of SLUGS) {
      const pageUrl = `${BASE}/${slug}/`;

      // json:false -> the shared helper returns raw HTML on r.text, sets a
      // realistic desktop User-Agent, and aborts at 25s rather than hanging.
      let r;
      try {
        r = await get(pageUrl, { json: false });
      } catch (e) {
        log(`lemon.io: ${slug} fetch threw: ${e && e.message}`);
        continue;
      }
      if (!r || !r.ok || !r.text) {
        log(`lemon.io: ${slug} HTTP ${(r && r.status) || 0} — skipped`);
        continue;
      }

      const html = r.text;

      let blocks;
      try {
        blocks = extractLdJson(html);
      } catch (e) {
        log(`lemon.io: ${slug} — ld+json extraction failed: ${e && e.message}`);
        continue;
      }

      const jobs = blocks.filter((b) => isJobPosting(b.item));
      if (!jobs.length) {
        // If this fires for EVERY slug, Lemon.io has dropped its JobPosting
        // markup and this adapter needs revisiting. One slug alone is not alarming.
        log(`lemon.io: ${slug} — page fetched but no JobPosting ld+json found`);
        continue;
      }

      pagesOk++;

      let ranges;
      try {
        ranges = cardRanges(html);
      } catch (e) {
        ranges = []; // enrichment is optional; JSON-LD alone is enough
      }

      let added = 0;
      for (const { item, index } of jobs) {
        // Per-record guard: one malformed posting must never take out the batch.
        try {
          let cardHtml = '';
          try {
            cardHtml = cardHtmlFor(html, ranges, index);
          } catch (e) {
            cardHtml = '';
          }

          const mapped = mapJob(item, cardHtml, pageUrl);
          if (!mapped) continue;

          // Drop gigs whose window has closed. Counted and logged: if this ever
          // starts swallowing whole pages, the log line is the tell that
          // Lemon.io has gone stale rather than that the parser has broken.
          if (mapped.validThrough && mapped.validThrough < today) {
            expired++;
            continue;
          }

          const key = dedupeKey(mapped.title, item.description);
          if (seen.has(key)) continue;
          seen.add(key);

          out.push(mapped);
          added++;
        } catch (e) {
          log(`lemon.io: skipped a bad record on ${slug} — ${e && e.message}`);
        }
      }

      log(`lemon.io: ${slug} -> ${jobs.length} postings, ${added} new`);
    }

    if (expired) log(`lemon.io: dropped ${expired} posting(s) past validThrough`);

    // Every page failed => the SOURCE is down. Return null so the runner can
    // distinguish that from "Lemon.io had nothing today" (an empty array).
    if (!pagesOk) return null;
    return out;
  },
};
