/*
 * sites/peopleperhour.js — PeoplePerHour (https://www.peopleperhour.com)
 *
 * WHAT THIS SOURCE IS
 * -------------------
 * PeoplePerHour is a real bidding marketplace: a buyer posts a project with a
 * budget, freelancers send proposals. It is NOT a salaried job board, so this
 * is kind: 'gig' — the same category as freelancer.com, and the point of the
 * whole exercise.
 *
 * HOW WE READ IT — AND WHY THIS IS NOT A GUESS
 * --------------------------------------------
 * PPH has no public REST API and no RSS feed. What it does have is a
 * server-rendered Redux store dumped inline into every category page:
 *
 *     <script>
 *       window.PPHReact = {};
 *       window.PPHReact.initialState = { ... };
 *     </script>
 *
 * VERIFIED LIVE ON 2026-08-08 across 13 category/subcategory/page URLs: all
 * returned HTTP 200 with a parseable blob and exactly 20 projects each, 210
 * unique after de-duplication. The projects live at:
 *
 *     initialState.entities.projects   -> { "<proj_id>": { id, type, attributes } }
 *
 * and `attributes` is the *complete* posting: title, url, proj_desc, budget,
 * currency, category, sub_category, posted_dt, project_type, where_can_bid,
 * item_state and the client's country. Nothing has to be scraped out of the
 * rendered HTML and nothing has to be fetched per-posting.
 *
 * For a Java/Spring dev: this is the same trick as Arc's __NEXT_DATA__ — read
 * the model the server handed the view instead of re-deriving it from the view.
 *
 * ROBOTS.TXT — WHY THE URL LIST LOOKS THE WAY IT DOES
 * ---------------------------------------------------
 * https://www.peopleperhour.com/robots.txt says, in this order:
 *
 *     User-agent: *
 *     Disallow: /*?
 *     Allow: /*?page=
 *
 * So: clean paths are fine, ANY query string is off-limits, EXCEPT `?page=`,
 * which is carved back out explicitly (the longer, more specific rule wins).
 * That is exactly why this adapter paginates with `?page=N` and gets its
 * breadth from clean `/freelance-jobs/<category>/<subcategory>` paths rather
 * than from a keyword query like `?q=java`. A `?q=` search would be a robots
 * violation, so the stack filtering happens on our side, after the fetch.
 * `/job/new*` and `/job/bidders*` are also disallowed and are never touched.
 *
 * ITEM STATE — THE TRAP
 * ---------------------
 * The blob does NOT contain only live work. Measured over the same 13 URLs:
 *     open 160, in_progress 43, expired 53, completed 2
 * The expired/completed ones come from the "recently completed" showcase rail
 * that PPH renders beside the listing. Emitting them would fill the apply queue
 * with projects that can no longer be bid on, and they look completely normal
 * otherwise. Hence the hard `open` filter below — it is load-bearing, not
 * defensive tidying.
 *
 * WHERE_CAN_BID — A REAL ELIGIBILITY FIELD
 * ----------------------------------------
 * `where_can_bid` is PPH's machine-readable answer to "may this freelancer even
 * submit a proposal". Measured domain on the live payload:
 *     ALL 242, GB 10, US 3, IN 2, CA 1, KE 1, RO 1
 * 'ALL' means unrestricted; anything else is an ISO alpha-2 allow-list of one.
 * So `indiaOk` here is a fact, not an inference from prose — same quality of
 * signal as Arc's requiredCountries, and it is set on every record.
 */

const { get, strip, rec } = require('../sources.js');

const BASE = 'https://www.peopleperhour.com/freelance-jobs';

/*
 * The clean category paths to sweep. All verified HTTP 200 with 20 projects.
 *
 * `technology-programming` is the parent; the subcategories are NOT a subset of
 * what the parent page shows — the parent is ordered by recency across the whole
 * category, so it truncates at 20 and the niche subcategories never surface
 * there. Sweeping both is what took the unique count from 20 to 210.
 *
 * `artificial-intelligence` is a separate top-level category on PPH, not a child
 * of technology-programming, which is why it is listed without a prefix.
 */
const PATHS = [
  'technology-programming',
  'technology-programming/mobile-app-development',
  'technology-programming/programming-coding',
  'technology-programming/website-development',
  'technology-programming/databases',
  'technology-programming/software-testing',
  'technology-programming/erp-crm-development',
  'technology-programming/game-development',
  'technology-programming/data-science-analysis',
  'technology-programming/cms-development',
  'technology-programming/e-commerce-cms-development',
  'artificial-intelligence',
];

/* Extra pages taken on the broad parent category only. The subcategories rarely
 * have a second page worth of live work, and every extra URL is another request
 * against a site that is being polite enough to leave the blob in the HTML. */
const DEEP_PATH = 'technology-programming';
const DEEP_PAGES = [2, 3];

/* ------------------------------------------------------------------ helpers */

/* Coerce anything to a trimmed string. These payloads are not schema-stable and
 * calling .trim() on a null is how a source dies mid-run. */
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
 * Pull `window.PPHReact.initialState = {...}` out of the HTML.
 *
 * A regex cannot do this safely: the blob is ~300 KB of JSON containing braces,
 * semicolons and `</script>`-looking text inside string values, so any
 * non-greedy match truncates in the wrong place and JSON.parse fails on a
 * payload that was actually fine. So: find the assignment, then walk the
 * characters counting brace depth while respecting string literals and escapes.
 * That is O(n) and cannot be fooled by content.
 */
function extractInitialState(html) {
  const KEY = 'window.PPHReact.initialState=';
  const src = String(html || '');

  // Tolerate whitespace around the '=' without a regex over the whole document.
  let start = src.indexOf(KEY);
  if (start < 0) {
    const m = src.match(/window\.PPHReact\.initialState\s*=\s*\{/);
    if (!m) return null;
    start = m.index + m[0].length - 1; // position of the '{'
  } else {
    start = start + KEY.length;
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
  if (end < 0) return null; // truncated response — treat as "could not parse"

  try {
    return JSON.parse(src.slice(brace, end + 1));
  } catch (e) {
    return null;
  }
}

/*
 * Is this posting still biddable?
 *
 * Both flags are checked rather than either one: `open` is the boolean PPH's own
 * UI uses, `item_state` is the string, and they are redundant today. If a future
 * deploy drops one of them, requiring both means we go quiet rather than
 * silently start emitting dead projects.
 */
function isOpen(a) {
  return a.open === true && s(a.item_state).toLowerCase() === 'open';
}

/*
 * India eligibility — a fact, not a guess. See the header note on where_can_bid.
 * Unknown/missing is treated as open, because the only observed non-'ALL' values
 * are explicit country codes; an absent field means PPH recorded no restriction.
 */
function isIndiaOk(whereCanBid) {
  const v = s(whereCanBid).toUpperCase();
  if (!v) return true;
  if (v === 'ALL') return true;
  return /(^|[^A-Z])(IN|IND)([^A-Z]|$)/.test(v);
}

function describeBid(whereCanBid) {
  const v = s(whereCanBid).toUpperCase();
  if (!v || v === 'ALL') return 'Worldwide';
  return `${v} only`;
}

/*
 * Money.
 *
 * `budget` is in the buyer's own `currency` (GBP dominates — PPH is UK-based),
 * and `budget_converted` is the same number in the viewer's currency. We emit
 * the ORIGINAL, because that is the number the freelancer will actually bid
 * against on the site; the converted figure drifts with the FX rate and would
 * make two runs disagree about the same project.
 *
 * `project_type` is 'fixed_price' or 'hourly' (verified: 204/56 on the live
 * sample) and changes what the number means, so it is spelled out.
 */
function budgetOf(a) {
  const amount = Number(a.budget);
  if (!Number.isFinite(amount) || amount <= 0) return '';
  const cur = s(a.currency).toUpperCase() || '';
  const per = s(a.project_type) === 'hourly' ? '/hr' : ' fixed';
  return `${amount} ${cur}${per}`.trim();
}

/* posted_dt arrives as 'YYYY-MM-DD HH:MM:SS' (server local, no zone marker).
 * Only the date is kept — the sweep compares days, and inventing a timezone we
 * were not given would be worse than dropping the clock time. */
function postedOf(v) {
  const str = s(v);
  if (!str) return '';
  const m = str.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

/*
 * Stack tagging — kept deliberately identical in spirit to arc.js so the report
 * can compare sources on the same vocabulary. Spring Boot demand and Flutter
 * demand do not live on the same platforms, and the report splits on this.
 */
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

function mapProject(node) {
  if (!node || typeof node !== 'object') return null;
  const a = node.attributes;
  if (!a || typeof a !== 'object') return null;

  if (!isOpen(a)) return null; // see ITEM STATE in the header — not optional

  const title = s(a.title);
  if (!title) return null;

  /* PPH hands us an absolute canonical URL. Falling back to a hand-built one
   * from the id would produce a link shape we have not verified, so a posting
   * without a url is dropped instead. */
  const url = s(a.url);
  if (!url) return null;

  const cat = a.category && typeof a.category === 'object' ? s(a.category.cate_name) : '';
  const sub = a.sub_category && typeof a.sub_category === 'object' ? s(a.sub_category.subcate_name) : '';

  /* PPH has no skill-tag array on a project — only the category pair. Those are
   * clean controlled vocabulary, so they go in `skills`, and the keyword signal
   * for the stack comes from the description instead. Do not "fix" this by
   * looking for a tags field; there isn't one. */
  const skills = [cat, sub].filter(Boolean);

  const client = a.client && typeof a.client === 'object' ? a.client : {};
  const clientCountry = s(client.country);

  const desc = s(a.proj_desc);

  const text = [
    title,
    desc,
    cat || sub ? `Category: ${[cat, sub].filter(Boolean).join(' / ')}` : '',
    `Engagement: ${s(a.project_type) === 'hourly' ? 'hourly' : 'fixed price'}`,
    clientCountry ? `Client: ${clientCountry}` : '',
    `Who can bid: ${describeBid(a.where_can_bid)}`,
    Number(a.proposalCount) > 0 ? `Proposals so far: ${Number(a.proposalCount)}` : '',
  ].filter(Boolean).join('. ');

  const out = rec({
    title,
    /* PPH projects are posted by individuals under a first name + initial
     * ("Andy J."); there is no company entity. Emitting the buyer's display
     * name is more useful than a blank cell, and it is what the site shows. */
    company: s(client.public_name) || s(client.shortName) || 'Private client (PeoplePerHour)',
    url,
    text,
    skills,
    /* PPH projects are remote by default (`location_type: 'remote'`); the
     * meaningful geography is who is allowed to bid, so that is what goes here
     * rather than the buyer's city. */
    location: describeBid(a.where_can_bid),
    budget: budgetOf(a),
    // Every record here is a bid-for-project posting. That is the whole source.
    type: 'contract',
    posted: postedOf(a.posted_dt),
  });

  // ---- PPH-specific extras, attached after rec() (rec drops unknown keys) ----

  out.indiaOk = isIndiaOk(a.where_can_bid);   // authoritative, see header
  out.stack = tagStack(`${title} ${desc} ${skills.join(' ')}`);
  out.id = String(a.proj_id || node.id || '');
  out.projectType = s(a.project_type);        // 'fixed_price' | 'hourly'
  out.currency = s(a.currency).toUpperCase();
  /* Bid count is the competition signal. A 60-proposal project is not worth a
   * connect; a 2-proposal one posted an hour ago is. */
  out.proposals = Number.isFinite(Number(a.proposalCount)) ? Number(a.proposalCount) : null;
  out.clientCountry = clientCountry;

  return out;
}

/* ------------------------------------------------------------------ adapter */

module.exports = {
  name: 'peopleperhour',
  kind: 'gig', // a genuine bid-for-project marketplace, not a job board
  homepage: 'https://www.peopleperhour.com/freelance-jobs',

  async fetch(opts = {}) {
    const log = typeof opts.log === 'function' ? opts.log : () => {};

    /* `?page=` is the ONE query parameter robots.txt allows — see the header. */
    const pages = PATHS.map((p) => ({ label: p, url: `${BASE}/${p}` })).concat(
      DEEP_PAGES.map((n) => ({ label: `${DEEP_PATH}#${n}`, url: `${BASE}/${DEEP_PATH}?page=${n}` }))
    );

    const out = [];
    const seen = new Set();
    let pagesOk = 0;
    let skippedClosed = 0;

    for (const page of pages) {
      let r;
      try {
        // json:false -> the helper hands back raw HTML on r.text
        r = await get(page.url, { json: false });
      } catch (e) {
        log(`peopleperhour: ${page.label} fetch threw: ${e && e.message}`);
        continue;
      }
      if (!r || !r.ok || !r.text) {
        log(`peopleperhour: ${page.label} HTTP ${(r && r.status) || 0} — skipped`);
        continue;
      }

      const state = extractInitialState(r.text);
      if (!state) {
        /* If this fires for every page, PPH has stopped inlining its Redux store
         * (moved to client-side hydration) and this adapter needs revisiting. */
        log(`peopleperhour: ${page.label} — no parseable PPHReact.initialState`);
        continue;
      }

      const projects =
        state.entities && state.entities.projects && typeof state.entities.projects === 'object'
          ? state.entities.projects
          : null;
      if (!projects) {
        log(`peopleperhour: ${page.label} — store parsed but entities.projects missing`);
        continue;
      }

      pagesOk++;
      const ids = Object.keys(projects);
      let added = 0;

      for (const id of ids) {
        // Per-record try/catch: one malformed posting must not lose the batch.
        try {
          const mapped = mapProject(projects[id]);
          if (!mapped) { skippedClosed++; continue; }
          const key = mapped.id || mapped.url;
          if (!key || seen.has(key)) continue;
          seen.add(key);
          out.push(mapped);
          added++;
        } catch (e) {
          log(`peopleperhour: skipped a bad record — ${e && e.message}`);
        }
      }

      log(`peopleperhour: ${page.label} -> ${ids.length} in store, ${added} new open gigs`);
    }

    if (skippedClosed) {
      log(`peopleperhour: dropped ${skippedClosed} non-open postings (expired/in-progress/completed rails)`);
    }

    /* Every page failed => the SOURCE is down. null lets the runner tell that
     * apart from "PPH had nothing new today" (an empty array). */
    if (!pagesOk) return null;
    return out;
  },
};
