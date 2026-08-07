/*
 * sources.js — where freelance / contract work for a given stack can actually
 * be read from, without an API key.
 *
 * Two different kinds of source, and the distinction matters when reading the
 * report:
 *
 *   kind: 'gig'    a real freelance marketplace — someone is posting a project
 *                  and wants a contractor. Freelancer.com is the only large one
 *                  with a genuinely open search API; Upwork and Toptal require
 *                  OAuth, so they are absent by design rather than by oversight.
 *
 *   kind: 'remote' a remote job board. Mostly salaried roles, but they carry a
 *                  steady minority of contract/freelance postings, and they are
 *                  open. Each posting is tagged with its contract type where the
 *                  source provides one, so the report can separate them.
 *
 * Every adapter returns the same normalised record:
 *   { title, company, url, text, skills[], location, budget, type, posted }
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function get(url, { json = true, timeout = 25000 } = {}) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeout);
  try {
    const r = await fetch(url, {
      headers: { 'user-agent': UA, accept: json ? 'application/json,*/*' : 'text/html,application/xml,*/*' },
      redirect: 'follow',
      signal: c.signal,
    });
    const text = await r.text();
    if (!r.ok) return { ok: false, status: r.status, text };
    if (!json) return { ok: true, status: r.status, text };
    try {
      return { ok: true, status: r.status, data: JSON.parse(text) };
    } catch {
      return { ok: false, status: r.status, error: 'bad-json', text };
    }
  } catch (e) {
    return { ok: false, status: 0, error: String(e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

const strip = (s = '') =>
  String(s)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/\s+/g, ' ')
    .trim();

/* These feeds are not schema-stable: a field that is an array of strings on one
 * page can be a bare string, null, or an object on the next. Coerce before
 * touching it — one such field killed a whole source mid-run. */
const arr = (v) => {
  if (Array.isArray(v)) return v.filter((x) => x != null).map((x) => (typeof x === 'string' ? x : x && (x.name || x.title || x.label) ? x.name || x.title || x.label : String(x)));
  if (v == null || v === '') return [];
  if (typeof v === 'string') return v.split(/[,;|]/).map((s) => s.trim()).filter(Boolean);
  if (typeof v === 'object') return Object.values(v).filter((x) => typeof x === 'string');
  return [String(v)];
};

const rec = (o) => ({
  title: strip(o.title).slice(0, 200),
  company: strip(o.company || '').slice(0, 120),
  url: o.url || '',
  text: strip(o.text || '').slice(0, 12000),
  skills: arr(o.skills).map((s) => strip(s)).filter(Boolean).slice(0, 20),
  location: strip(o.location || '').slice(0, 120),
  budget: strip(o.budget || '').slice(0, 80),
  type: o.type || '',
  posted: o.posted || '',
});

module.exports = [
  /* ------------------------------------------------------------ gig markets */
  {
    name: 'freelancer.com',
    kind: 'gig',
    perQuery: true, // the API searches, so ask it once per stack term
    async fetch(q) {
      // active projects only; job_details gives the skill tags, which are a far
      // better stack signal than keyword-matching the description
      const u =
        'https://www.freelancer.com/api/projects/0.1/projects/active/' +
        `?query=${encodeURIComponent(q)}&limit=100&job_details=true&full_description=true`;
      const r = await get(u);
      const ps = r.ok && r.data && r.data.result && r.data.result.projects;
      if (!Array.isArray(ps)) return null;
      return ps.map((p) =>
        rec({
          title: p.title,
          company: '',
          url: p.seo_url ? `https://www.freelancer.com/projects/${p.seo_url}` : '',
          text: p.description || p.preview_description,
          skills: arr(p.jobs),
          budget:
            p.budget && (p.budget.minimum || p.budget.maximum)
              ? `${p.budget.minimum || '?'}-${p.budget.maximum || '?'} ${(p.currency && p.currency.code) || ''}`.trim()
              : '',
          type: p.type === 'hourly' ? 'freelance-hourly' : 'freelance-fixed',
          posted: p.time_submitted ? new Date(p.time_submitted * 1000).toISOString().slice(0, 10) : '',
        })
      );
    },
  },

  /* --------------------------------------------------------- remote boards */
  {
    name: 'remoteok',
    kind: 'remote',
    async fetch() {
      const r = await get('https://remoteok.com/api');
      if (!r.ok || !Array.isArray(r.data)) return null;
      // element 0 is a legal notice, not a job
      return r.data
        .filter((j) => j && j.position)
        .map((j) =>
          rec({
            title: j.position,
            company: j.company,
            url: j.url || (j.slug ? `https://remoteok.com/remote-jobs/${j.slug}` : ''),
            text: j.description,
            skills: j.tags,
            location: j.location,
            budget: j.salary_min ? `${j.salary_min}-${j.salary_max || '?'} USD/yr` : '',
            type: arr(j.tags).some((t) => /contract|freelance/i.test(t)) ? 'contract' : 'remote',
            posted: (j.date || '').slice(0, 10),
          })
        );
    },
  },
  {
    name: 'remotive',
    kind: 'remote',
    perQuery: true,
    async fetch(q) {
      const r = await get(`https://remotive.com/api/remote-jobs?search=${encodeURIComponent(q)}&limit=100`);
      const jobs = r.ok && r.data && r.data.jobs;
      if (!Array.isArray(jobs)) return null;
      return jobs.map((j) =>
        rec({
          title: j.title,
          company: j.company_name,
          url: j.url,
          text: j.description,
          skills: j.tags,
          location: j.candidate_required_location,
          budget: j.salary,
          type: /contract|freelance/i.test(j.job_type || '') ? 'contract' : 'remote',
          posted: (j.publication_date || '').slice(0, 10),
        })
      );
    },
  },
  {
    name: 'arbeitnow',
    kind: 'remote',
    async fetch() {
      const out = [];
      for (let page = 1; page <= 3; page++) {
        const r = await get(`https://www.arbeitnow.com/api/job-board-api?page=${page}`);
        const d = r.ok && r.data && r.data.data;
        if (!Array.isArray(d) || !d.length) break;
        out.push(
          ...d.map((j) =>
            rec({
              title: j.title,
              company: j.company_name,
              url: j.url,
              text: j.description,
              skills: j.tags,
              location: j.location,
              type: arr(j.job_types).some((t) => /contract|freelance/i.test(t)) ? 'contract' : j.remote ? 'remote' : '',
              posted: j.created_at ? new Date(j.created_at * 1000).toISOString().slice(0, 10) : '',
            })
          )
        );
      }
      return out.length ? out : null;
    },
  },
  {
    name: 'jobicy',
    kind: 'remote',
    perQuery: true,
    async fetch(q) {
      const r = await get(`https://jobicy.com/api/v2/remote-jobs?count=50&tag=${encodeURIComponent(q)}`);
      const jobs = r.ok && r.data && r.data.jobs;
      if (!Array.isArray(jobs)) return null;
      return jobs.map((j) =>
        rec({
          title: j.jobTitle,
          company: j.companyName,
          url: j.url,
          text: j.jobDescription || j.jobExcerpt,
          skills: [...arr(j.jobIndustry), ...arr(j.jobType)],
          location: j.jobGeo,
          budget: j.annualSalaryMin ? `${j.annualSalaryMin}-${j.annualSalaryMax || '?'} ${j.salaryCurrency || ''}` : '',
          type: arr(j.jobType).some((t) => /contract|freelance/i.test(t)) ? 'contract' : 'remote',
          posted: (j.pubDate || '').slice(0, 10),
        })
      );
    },
  },
  {
    name: 'himalayas',
    kind: 'remote',
    async fetch() {
      const out = [];
      for (let offset = 0; offset < 300; offset += 100) {
        const r = await get(`https://himalayas.app/jobs/api?limit=100&offset=${offset}`);
        const jobs = r.ok && r.data && r.data.jobs;
        if (!Array.isArray(jobs) || !jobs.length) break;
        out.push(
          ...jobs.map((j) =>
            rec({
              title: j.title,
              company: j.companyName,
              url: j.applicationLink || j.guid,
              text: j.description || j.excerpt,
              skills: [...arr(j.categories), ...arr(j.seniority)],
              location: arr(j.locationRestrictions).join(', '),
              budget: j.minSalary ? `${j.minSalary}-${j.maxSalary || '?'} ${j.salaryCurrency || ''}` : '',
              type: /contract|freelance/i.test(String(j.employmentType || '')) ? 'contract' : 'remote',
              posted: j.pubDate ? new Date(j.pubDate * 1000).toISOString().slice(0, 10) : '',
            })
          )
        );
      }
      return out.length ? out : null;
    },
  },
  {
    name: 'workingnomads',
    kind: 'remote',
    async fetch() {
      const r = await get('https://www.workingnomads.com/api/exposed_jobs/');
      if (!r.ok || !Array.isArray(r.data)) return null;
      return r.data.map((j) =>
        rec({
          title: j.title,
          company: j.company_name,
          url: j.url,
          text: j.description,
          skills: arr(j.tags),
          location: j.location,
          type: 'remote',
          posted: (j.pub_date || '').slice(0, 10),
        })
      );
    },
  },
  {
    name: 'weworkremotely',
    kind: 'remote',
    async fetch() {
      // the contract feed is the interesting one here, but programming carries
      // the volume — read both and let the scorer sort it out
      const feeds = [
        'https://weworkremotely.com/categories/remote-contract-programming-jobs.rss',
        'https://weworkremotely.com/categories/remote-programming-jobs.rss',
        'https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss',
      ];
      const out = [];
      const seen = new Set();
      for (const f of feeds) {
        const r = await get(f, { json: false });
        if (!r.ok || !/<item/i.test(r.text)) continue;
        for (const m of r.text.matchAll(/<item[\s>]([\s\S]*?)<\/item>/gi)) {
          const g = (t) =>
            (m[1].match(new RegExp(`<${t}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${t}>`, 'i')) || [, ''])[1];
          const url = strip(g('link'));
          if (!url || seen.has(url)) continue;
          seen.add(url);
          const raw = strip(g('title')); // "Company: Role"
          const i = raw.indexOf(':');
          out.push(
            rec({
              title: i > 0 ? raw.slice(i + 1) : raw,
              company: i > 0 ? raw.slice(0, i) : '',
              url,
              text: g('description'),
              location: strip(g('region')),
              type: /contract/i.test(f) ? 'contract' : 'remote',
              posted: (strip(g('pubDate')) || '').slice(0, 16),
            })
          );
        }
      }
      return out.length ? out : null;
    },
  },
  {
    name: 'jobspresso',
    kind: 'remote',
    perQuery: true,
    async fetch(q) {
      const r = await get(`https://jobspresso.co/?feed=job_feed&search_keywords=${encodeURIComponent(q)}`, { json: false });
      if (!r.ok || !/<item/i.test(r.text)) return null;
      const out = [];
      for (const m of r.text.matchAll(/<item[\s>]([\s\S]*?)<\/item>/gi)) {
        const g = (t) =>
          (m[1].match(new RegExp(`<${t}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${t}>`, 'i')) || [, ''])[1];
        out.push(
          rec({
            title: strip(g('title')),
            company: strip(g('job_listing:company')),
            url: strip(g('link')),
            text: g('description') || g('content:encoded'),
            location: strip(g('job_listing:location')),
            type: strip(g('job_listing:job_type')) || 'remote',
            posted: (strip(g('pubDate')) || '').slice(0, 16),
          })
        );
      }
      return out.length ? out : null;
    },
  },
];

/* The shared helpers, published on the exported array so the per-site adapters
 * in sites/ can pull them in with `require('../sources.js')`.
 *
 * ORDER BELOW IS LOAD-BEARING — DO NOT MOVE THESE THREE LINES DOWN.
 * See the sites/ block that follows for why. */
module.exports.get = get;
module.exports.strip = strip;
module.exports.rec = rec;

/* ---------------------------------------------------------------- sites/ ---
 *
 * The nine adapters above are the originals and live inline. Everything added
 * since lives in its own file under sites/, one file per site, and is appended
 * to this same array here. Consumers (test.js, apply.js) see one flat list and
 * do not need to know or care which half an adapter came from.
 *
 * WHY THIS REQUIRE IS THE LAST THING IN THE FILE
 * ----------------------------------------------
 * There is a require cycle here:
 *
 *     sources.js  ->  sites/index.js  ->  sites/braintrust.js  ->  sources.js
 *
 * Node resolves cycles by handing the second requirer whatever the first
 * module has exported *at that instant* — it does not wait, and it does not
 * error. So when braintrust.js runs its
 *
 *     const { get, strip, rec } = require('../sources.js');
 *
 * it gets a snapshot of THIS file's module.exports as of right now. If that
 * require sat at the top of the file, the snapshot would be an empty object
 * and every adapter would destructure `get`/`strip`/`rec` as undefined — then
 * blow up with "get is not a function" at fetch time, far from the cause.
 *
 * Putting it here, below the array literal and below the three helper
 * assignments, means the snapshot is already complete: the array exists and
 * carries the helpers. Nothing in sites/ needs the *contents* of the array at
 * load time, only the helpers, so the cycle is safe in this direction.
 *
 * (In Spring terms: the helpers are eagerly initialised singletons, and the
 * site adapters are beans that depend on them — so the helpers must be
 * constructed first.)
 *
 * The require is itself wrapped: if sites/ is missing or unreadable, the nine
 * adapters above must still work. A partial sweep beats no sweep. */
try {
  const siteAdapters = require('./sites');
  if (Array.isArray(siteAdapters)) {
    // push onto the SAME array object, so the get/strip/rec properties already
    // attached to it survive — reassigning module.exports here would drop them.
    for (const a of siteAdapters) module.exports.push(a);
  } else {
    console.error('sources.js: sites/index.js did not export an array; skipping it');
  }
} catch (e) {
  console.error(`sources.js: could not load sites/ — ${(e && e.message) || e}`);
}
