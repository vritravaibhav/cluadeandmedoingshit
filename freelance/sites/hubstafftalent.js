/*
 * sites/hubstafftalent.js — Hubstaff Talent (https://talent.hubstaff.com)
 *
 * WHAT THIS SOURCE IS
 * -------------------
 * Hubstaff Talent is Hubstaff's free remote-work marketplace: clients post
 * projects, freelancers apply directly, no commission and no bidding credits.
 * The posting mix is genuinely split — every result carries an explicit
 * engagement label of `hourly`, `fixed_price` or `full_time`. The first two are
 * contract work, which is why this is kind: 'gig'; the `full_time` ones are
 * salaried and are tagged as such per-record so the report can drop them.
 *
 * HOW WE READ IT — AND WHY THIS IS NOT A GUESSED ENDPOINT
 * -------------------------------------------------------
 * There is no JSON API. `/search/jobs.json` answers 406 Not Acceptable and
 * `/api/jobs` answers 404 — both were tried, both were rejected, neither is used
 * here. What the site actually does is a Rails UJS remote form. Reading the
 * shipped bundle (application-25f00c01…js) shows:
 *
 *     performSearch: function(e){ $('#page').val(e||1);
 *       var n = $('#filter_search'); ... $.rails.handleRemote(n) ... }
 *
 * i.e. it serialises the form `#filter_search` (action="/search/jobs",
 * method="get", data-remote="true") and issues the request with an
 * `Accept: text/javascript` header. The server then answers with executable JS:
 *
 *     $('#results').html("<div class=\"search-result\">…");
 *     $('#heading').html("…");
 *
 * VERIFIED LIVE ON 2026-08-08: GET /search/jobs?search[keywords]=java&page=1
 * with that Accept header returns HTTP 200, content-type text/javascript, ~30 KB,
 * announcing "Displaying (1 - 15) of 72 results" and carrying 15 fully-formed
 * result blocks. So this adapter drives the site's own documented-by-its-own-JS
 * search path, with the site's own parameter names. It is not a hand-invented URL.
 *
 * ROBOTS.TXT
 * ----------
 * talent.hubstaff.com redirects to hubstafftalent.net, whose robots.txt
 * disallows only /admin, /wizards and the per-category skill sub-paths under
 * /categories. /search/jobs is
 * explicitly not restricted. The individual /jobs/<slug> pages carry rel=nofollow
 * on their links, so this adapter deliberately NEVER follows through to a job
 * detail page — everything emitted (title, url, rate, company, HQ, date,
 * description snippet, skill tags) is already present in the search response.
 * One request per keyword-page, nothing crawled behind it.
 *
 * VOLUME — a targeted search, not a firehose.
 * 15 results per page, and the sweep asks for the first two pages of each of the
 * candidate's stack terms. Expect low tens of records, heavily deduplicated
 * because "java" and "spring boot" return overlapping sets.
 *
 * WHAT THIS SOURCE CANNOT TELL US
 * -------------------------------
 * There is no eligibility field of any kind — no requiredCountries (Arc), no
 * where_can_bid (PeoplePerHour). The `HQ:` line is where the CLIENT sits, not
 * where the contractor must sit. So `indiaOk` here is INFERRED from the prose
 * and is flagged as such with `indiaOkInferred`, exactly like torre.js does.
 * Do not filter on it as if it were a fact.
 */

/* Only strip/rec are used: this adapter cannot go through the shared `get`
 * helper — see fetchRemote() below for why the Accept header has to differ. */
const { strip, rec } = require('../sources.js');

const ORIGIN = 'https://talent.hubstaff.com';
const SEARCH = `${ORIGIN}/search/jobs`;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/*
 * The one request this adapter makes.
 *
 * Kept out of the shared `get` helper because it needs the exact Accept header
 * the site's Rails UJS layer sends — with the default JSON Accept the same URL
 * answers 406/500, which is precisely the "wrong endpoint returns junk that
 * looks real" failure this sweep is supposed to avoid.
 *
 * Fails soft: returns a status object, never throws, and aborts rather than
 * hanging.
 */
async function fetchRemote(url, term) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 25000);
  try {
    const r = await fetch(url, {
      headers: {
        'user-agent': UA,
        accept: 'text/javascript, application/javascript, application/ecmascript, */*; q=0.01',
        'x-requested-with': 'XMLHttpRequest',
        referer: `${SEARCH}?search%5Bkeywords%5D=${encodeURIComponent(term)}`,
      },
      redirect: 'follow',
      signal: c.signal,
    });
    const text = await r.text();
    return { ok: r.ok, status: r.status, text };
  } catch (e) {
    return { ok: false, status: 0, error: String((e && e.message) || e) };
  } finally {
    clearTimeout(t);
  }
}

/*
 * The stack terms to search. Each becomes `search[keywords]=<term>`, the site's
 * own parameter. Kept short deliberately: each term costs PAGES requests, and
 * the result sets overlap heavily, so a longer list buys duplicates rather than
 * coverage.
 */
const TERMS = [
  'java',
  'spring boot',
  'flutter',
  'dart',
  'android',
  'kotlin',
  'backend developer',
  'microservices',
];

/* Two pages per term = up to 30 results per term before de-duplication. */
const PAGES = [1, 2];

/* The server's page size. A page that comes back short is the last page, so
 * asking for the next one is a guaranteed-empty request — and requests are the
 * scarce resource here (see PACE_MS). */
const PAGE_SIZE = 15;

/*
 * PACING — this is not optional politeness, it is what makes the source work.
 *
 * MEASURED 2026-08-08: firing the 16 term-pages back to back got the first 10
 * through and then HTTP 429 for every remaining one, losing 'kotlin',
 * 'backend developer' and 'microservices' entirely. Hubstaff Talent is a free
 * service with a real rate limiter, so the adapter spaces its requests out and
 * backs off once when told to. A sweep that finishes two seconds sooner but
 * silently drops a third of its queries is worse than useless — it looks like
 * "no Kotlin work today".
 */
const PACE_MS = 1500;   // gap between consecutive requests
const RETRY_MS = 8000;  // one-off cool-down after a 429

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ helpers */

function s(v) {
  if (v == null) return '';
  return String(v).trim();
}

/*
 * Read a JavaScript double-quoted string literal starting at `open` (which must
 * be the opening quote) and return { value, end }.
 *
 * Why not JSON.parse the whole thing? Because Rails' escape_javascript emits
 * `\'` for apostrophes, which is a legal JS escape and an ILLEGAL JSON escape.
 * JSON.parse would throw on any posting containing an apostrophe — and it would
 * throw on the whole batch, not one record. So the literal is scanned by hand.
 * (JSON.parse is still tried first below, because when it works it is exact.)
 */
function readJsString(src, open) {
  let outChars = '';
  for (let i = open + 1; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      const n = src[i + 1];
      i++;
      switch (n) {
        case 'n': outChars += '\n'; break;
        case 'r': outChars += '\r'; break;
        case 't': outChars += '\t'; break;
        case 'b': outChars += '\b'; break;
        case 'f': outChars += '\f'; break;
        case 'v': outChars += '\v'; break;
        case '0': outChars += '\0'; break;
        case 'u': {
          const hex = src.slice(i + 1, i + 5);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            outChars += String.fromCharCode(parseInt(hex, 16));
            i += 4;
          } else {
            outChars += 'u';
          }
          break;
        }
        // '\/', '\"', '\'' and '\\' all fall through to "the next char, literal"
        default: outChars += n == null ? '' : n;
      }
      continue;
    }
    if (c === '"') return { value: outChars, end: i };
    outChars += c;
  }
  return null; // unterminated — truncated response
}

/*
 * Pull the HTML fragment out of `$('#results').html("…");`.
 *
 * The response also contains a `$('#heading').html(…)` statement, so the anchor
 * is the #results selector specifically. Grabbing "the first .html(" would work
 * today and break the day the server reorders its statements.
 */
function extractResultsHtml(js) {
  const src = String(js || '');
  const anchor = src.indexOf("$('#results').html(");
  if (anchor < 0) return null;
  const open = src.indexOf('"', anchor);
  if (open < 0) return null;

  const read = readJsString(src, open);
  if (!read) return null;

  // Prefer JSON.parse when the literal happens to be JSON-legal: exact semantics.
  try {
    const strict = JSON.parse(src.slice(open, read.end + 1));
    if (typeof strict === 'string') return strict;
  } catch (e) {
    /* Expected on any payload containing \' — fall through to the hand-scanned
     * value, which is what this function exists for. */
  }
  return read.value;
}

/* One capture from a regex, stripped of tags/entities, or '' — never throws. */
function pick(html, re) {
  try {
    const m = String(html).match(re);
    return m ? strip(m[1]) : '';
  } catch (e) {
    return '';
  }
}

/*
 * Engagement label. The markup is
 *     <span class="label label-hourly …">hourly</span>
 * and the class suffix is the machine-readable half of the pair, so that is what
 * is read rather than the display text.
 */
function engagementOf(block) {
  const m = String(block).match(/class="label label-([a-z_]+)/i);
  return m ? m[1].toLowerCase() : '';
}

/*
 * "Created" date. The markup gives an abbreviated month and day with NO YEAR:
 *     <i class="hi hi-calendar…" title="Created"></i> Aug  4</span>
 * A naive Date() would therefore stamp every posting with the current year, so a
 * job created last December would be dated in the future. Fix: build it in the
 * current year, and if that lands more than a day ahead of now, roll back a year.
 */
const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function createdOf(block, now) {
  const m = String(block).match(/title="Created"[^>]*><\/i>\s*([A-Za-z]{3})\s+(\d{1,2})/);
  if (!m) return '';
  const mon = MONTHS[m[1].toLowerCase()];
  const day = Number(m[2]);
  if (mon == null || !Number.isFinite(day)) return '';

  const ref = now instanceof Date ? now : new Date();
  let d = new Date(Date.UTC(ref.getUTCFullYear(), mon, day));
  if (d.getTime() - ref.getTime() > 36 * 3600 * 1000) {
    d = new Date(Date.UTC(ref.getUTCFullYear() - 1, mon, day));
  }
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

/*
 * Money. Two mutually exclusive containers:
 *     <div class="pay-rate">$50/hr</div>      (hourly)
 *     <div class="fixed-price">$6,000</div>   (fixed price)
 * Both are frequently EMPTY (`<div class="pay-rate"></div>`) — undisclosed rate
 * is normal here, not a parse failure.
 */
function budgetOf(block, engagement) {
  const rate = pick(block, /<div class="pay-rate">([\s\S]*?)<\/div>/i);
  if (rate) return rate;
  const fixed = pick(block, /<div class="fixed-price">([\s\S]*?)<\/div>/i);
  if (fixed) return engagement === 'fixed_price' ? `${fixed} fixed` : fixed;
  return '';
}

/* Skill tags: <a class="tag tag-sm" href="…">Java</a> — Hubstaff's own
 * controlled vocabulary, far better signal than keyword-matching the snippet. */
function skillsOf(block) {
  const out = [];
  const re = /<a class="tag tag-sm"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(block)) !== null) {
    const v = strip(m[1]);
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= 20) break;
  }
  return out;
}

/*
 * India eligibility — INFERRED, see the header. Hubstaff Talent has no
 * eligibility field, so this reads the prose:
 *   - an explicit India / worldwide / global mention  -> true
 *   - an explicit "<somewhere else> only" restriction -> false
 *   - anything else                                   -> true (remote by default)
 * The live payload contains real examples of the middle case, e.g. "Philippines
 * VA's only", which is exactly the sort of posting an application would be
 * wasted on.
 */
const INDIA_RE = /\bindia\b|\bindian\b/i;
const GLOBAL_RE = /\bworldwide\b|\bglobal(ly)?\b|\banywhere\b|\bany\s+country\b|\basia[- ]friendly\b/i;
const ONLY_RE = /\b(only|residents?\s+of|must\s+(be\s+)?(located|based|reside))\b/i;

function indiaOkOf(text) {
  const hay = String(text || '');
  if (INDIA_RE.test(hay)) return true;
  if (GLOBAL_RE.test(hay)) return true;
  if (ONLY_RE.test(hay)) return false; // a stated restriction that never says India
  return true;
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

function mapBlock(block, now) {
  /* Title + link. rel="nofollow" sits between the class and the href in the live
   * markup, hence the tolerant `[^>]*` rather than an exact attribute order. */
  const link = String(block).match(/<a class="name[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
  if (!link) return null;

  const href = s(link[1]);
  const title = strip(link[2]);
  if (!title || !href) return null;

  const url = href.startsWith('http') ? href : ORIGIN + href;

  const engagement = engagementOf(block);          // hourly | fixed_price | full_time
  const company = pick(block, /<a class="is-inline-block job-agency[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
  const hq = pick(block, /<strong>HQ:<\/strong>([\s\S]*?)<\/span>/i);
  const snippet = pick(block, /<div class="profil-bio[^"]*">([\s\S]*?)<\/div>/i);
  const remote = /title="Remote job"/i.test(block);
  const skills = skillsOf(block);
  const budget = budgetOf(block, engagement);
  const posted = createdOf(block, now);

  const text = [
    title,
    snippet,
    skills.length ? `Skills: ${skills.join(', ')}` : '',
    engagement ? `Engagement: ${engagement.replace(/_/g, ' ')}` : '',
    company ? `Client: ${company}` : '',
    hq ? `Client HQ: ${hq}` : '',
    remote ? 'Remote job' : '',
  ].filter(Boolean).join('. ');

  const out = rec({
    title,
    company: company || 'Undisclosed client (Hubstaff Talent)',
    url,
    text,
    skills,
    /* The HQ line is the CLIENT's address, not a requirement on the contractor —
     * labelled so nobody downstream reads it as an eligibility constraint. */
    location: remote ? (hq ? `Remote (client HQ: ${hq})` : 'Remote') : (hq || ''),
    budget,
    /* hourly + fixed_price are contract engagements; full_time is a salaried
     * role that happens to be listed on the same marketplace. */
    type: engagement === 'full_time' ? 'remote' : 'contract',
    posted,
  });

  // ---- Hubstaff-specific extras, attached after rec() ----

  out.indiaOk = indiaOkOf(`${title} ${snippet} ${hq}`);
  out.indiaOkInferred = true; // NOT an authoritative field — see the header
  out.stack = tagStack(`${title} ${snippet} ${skills.join(' ')}`);
  out.engagement = engagement;
  out.id = url.replace(/^.*\/jobs\//, '');
  /* Which of our search terms this posting answered. Filled in by fetch() —
   * see the note on `matchedTerms` there; it is the only reliable evidence of
   * what is in the full description. */
  out.matchedTerms = [];

  return out;
}

/*
 * Fold the search terms a posting matched into its stack tags.
 *
 * WHY THIS IS NEEDED — MEASURED, NOT SPECULATIVE
 * ----------------------------------------------
 * Hubstaff searches the FULL job description server-side, but the search-results
 * markup only carries a ~120-character truncated snippet. So a posting returned
 * by `search[keywords]=flutter` very often contains the word "Flutter" nowhere
 * in anything this adapter can see: on 2026-08-08 the flutter query returned 3
 * results and the string "Flutter" appeared zero times in the entire response
 * body. Tagging purely off the visible text therefore reported 0 Flutter gigs
 * from a query that by construction returned only Flutter gigs.
 *
 * The term itself is the evidence: the server has already confirmed the word
 * occurs in the posting. So the matched term is run through the same STACK
 * vocabulary and unioned with whatever the visible text yielded.
 */
function foldMatchedTerms(record) {
  const fromTerms = tagStack(record.matchedTerms.join(' '));
  for (const tag of fromTerms) {
    if (!record.stack.includes(tag)) record.stack.push(tag);
  }
  return record;
}

/* ------------------------------------------------------------------ adapter */

module.exports = {
  name: 'hubstaff-talent',
  kind: 'gig', // hourly/fixed-price client projects you apply to directly
  homepage: 'https://talent.hubstaff.com/search/jobs',

  async fetch(opts = {}) {
    const log = typeof opts.log === 'function' ? opts.log : () => {};
    const now = new Date();

    const out = [];
    const seen = new Map(); // url -> record, so repeat hits can merge their term
    let queriesOk = 0;
    let first = true;

    outer:
    for (const term of TERMS) {
      for (const page of PAGES) {
        /* The site's own parameter names, taken from its form markup. */
        const url =
          `${SEARCH}?search%5Bkeywords%5D=${encodeURIComponent(term)}&page=${page}`;

        // Space the requests out — see PACE_MS. No delay before the first one.
        if (!first) await sleep(PACE_MS);
        first = false;

        let r;
        try {
          r = await fetchRemote(url, term);

          /* 429 = we are going too fast. Cool off and give this one query a
           * second chance; if it is still refused, the limiter has us for the
           * rest of the window, so stop asking rather than burning the remaining
           * terms against a wall. Whatever has already been collected is kept
           * and returned — a partial answer, not a failure. */
          if (r && r.status === 429) {
            log(`hubstaff-talent: rate-limited on "${term}" p${page} — waiting ${RETRY_MS}ms`);
            await sleep(RETRY_MS);
            r = await fetchRemote(url, term);
            if (r && r.status === 429) {
              log('hubstaff-talent: still rate-limited — stopping early with what we have');
              break outer;
            }
          }
        } catch (e) {
          log(`hubstaff-talent: "${term}" p${page} fetch threw: ${e && e.message}`);
          continue;
        }
        if (!r || !r.ok || !r.text) {
          log(`hubstaff-talent: "${term}" p${page} HTTP ${(r && r.status) || 0} — skipped`);
          continue;
        }

        const html = extractResultsHtml(r.text);
        if (html == null) {
          /* If this fires for every query, Hubstaff has stopped answering the
           * remote form with a $('#results').html(...) statement and this
           * adapter needs revisiting. */
          log(`hubstaff-talent: "${term}" p${page} — no $('#results').html(...) in the response`);
          continue;
        }

        queriesOk++;

        const blocks = html.split('<div class="search-result">').slice(1);
        let added = 0;
        for (const block of blocks) {
          try {
            const mapped = mapBlock(block, now);
            if (!mapped) continue;
            const key = mapped.url;
            if (!key) continue;

            /* A posting that comes back under several terms is one record with
             * several pieces of evidence, not a duplicate to throw away. The
             * overlap is large and deliberate ('java' and 'spring boot' return
             * the same postings), so the extra terms are merged onto the record
             * we already have. */
            const prior = seen.get(key);
            if (prior) {
              if (!prior.matchedTerms.includes(term)) prior.matchedTerms.push(term);
              continue;
            }

            mapped.matchedTerms.push(term);
            seen.set(key, mapped);
            out.push(mapped);
            added++;
          } catch (e) {
            log(`hubstaff-talent: skipped a bad record — ${e && e.message}`);
          }
        }

        log(`hubstaff-talent: "${term}" p${page} -> ${blocks.length} results, ${added} new`);

        /* A short page is the last page. Asking for the next one would spend a
         * request we cannot afford (see PACE_MS) on a guaranteed-empty answer. */
        if (blocks.length < PAGE_SIZE) break;
      }
    }

    /* Every query failed => the SOURCE is down, which is different from
     * "Hubstaff had no Java work today". */
    if (!queriesOk) return null;

    /* Done last, once every term has had a chance to attach itself, so a record
     * first seen under 'java' still picks up 'flutter' if that query hit it too. */
    return out.map(foldMatchedTerms);
  },
};
