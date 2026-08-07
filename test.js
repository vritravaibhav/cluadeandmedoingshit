#!/usr/bin/env node
/**
 * test.js — Z-company career-page scanner
 *
 * Pass 1 (--discover): probe every company against every known ATS provider API
 *                      using candidate slugs. Persist hits to ats-map.json.
 * Pass 2 (default):    fetch all live postings from the discovered boards,
 *                      classify them, and write careers.txt.
 *
 * Target profile: Software Engineer, ~2 years experience.
 * Priority stacks: Java, Dart/Flutter.
 *
 * Usage:
 *   node test.js --discover      # find each company's job board
 *   node test.js                 # fetch + classify + write careers.txt
 *   node test.js --verify        # self-check: prove the fetch really worked
 */

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const COMPANIES = JSON.parse(fs.readFileSync(path.join(DIR, 'companies.json'), 'utf8'));
const MAP_FILE = path.join(DIR, 'ats-map.json');
const OUT_FILE = path.join(DIR, 'careers.txt');
const RAW_FILE = path.join(DIR, 'raw-jobs.json');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/* ------------------------------------------------------------------ *
 * HTTP helpers
 * ------------------------------------------------------------------ */

async function req(url, opts = {}) {
  const { timeout = 25000, retries = 2, method = 'GET', body, headers = {} } = opts;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    try {
      const res = await fetch(url, {
        method,
        body,
        signal: ac.signal,
        redirect: 'follow',
        headers: { 'User-Agent': UA, Accept: '*/*', ...headers },
      });
      clearTimeout(timer);
      const text = await res.text();
      return { ok: res.ok, status: res.status, text, url: res.url };
    } catch (e) {
      clearTimeout(timer);
      if (attempt === retries) return { ok: false, status: 0, text: '', error: String(e.message || e) };
      await sleep(600 * (attempt + 1));
    }
  }
}

async function getJson(url, opts) {
  const r = await req(url, opts);
  if (!r.ok) return null;
  try { return JSON.parse(r.text); } catch { return null; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run tasks with bounded concurrency. */
async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let idx = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try { out[i] = await worker(items[i], i); }
      catch (e) { out[i] = { error: String(e.message || e) }; }
    }
  });
  await Promise.all(runners);
  return out;
}

/* ------------------------------------------------------------------ *
 * Text helpers
 * ------------------------------------------------------------------ */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'",
  '#8217': '’', '#8211': '-', '#8212': '-', '#160': ' ', rsquo: '’',
  ldquo: '"', rdquo: '"', mdash: '-', ndash: '-', bull: '*', hellip: '...',
};

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&([a-z]+|#\d+);/gi, (m, k) => (ENTITIES[k] !== undefined ? ENTITIES[k] : m));
}

function safeChar(code) {
  try { return String.fromCodePoint(code); } catch { return ''; }
}

function stripHtml(html) {
  if (!html) return '';
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<\/(p|div|li|br|h[1-6]|tr)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/[ \t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/* ------------------------------------------------------------------ *
 * Providers — each returns a normalized job array, or null if no board.
 * A provider "hits" only when it returns a non-empty, well-formed list.
 * ------------------------------------------------------------------ */

// Coerce defensively: ATS payloads are inconsistently typed (Keka returns jobType
// as a number, some boards return null locations), and a throw here silently
// zeroes out an entire board.
const s = (v) => (v == null ? '' : String(v)).trim();

// Titles/locations lifted from JSON-LD and XML still carry raw entities
// ("Brand Strategist &amp; Copywriter"), so decode on the way in.
const norm = (o) => ({
  title: decodeEntities(s(o.title)),
  location: decodeEntities(s(o.location)),
  url: s(o.url),
  department: decodeEntities(s(o.department)),
  employmentType: decodeEntities(s(o.employmentType)),
  description: s(o.description),
  updated: s(o.updated),
  // Some ATSs (Keka, Sense) expose a structured experience range. When present it
  // is authoritative and beats regex-scraping the description.
  expMin: o.expMin === undefined ? null : o.expMin,
  expMax: o.expMax === undefined ? null : o.expMax,
});

/** Pull JobPosting data out of embedded JSON-LD — works on most ATS detail pages. */
function jsonLd(html) {
  if (!html) return null;
  for (const m of html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )) {
    let data; try { data = JSON.parse(m[1].trim()); } catch { continue; }
    for (const node of Array.isArray(data) ? data : [data, ...(data['@graph'] || [])]) {
      if (node && node['@type'] === 'JobPosting') return node;
    }
  }
  return null;
}

/** "4-7 years" / "2+ years" / "0-2 yrs" -> {min,max} */
function parseExpString(s) {
  if (!s) return {};
  const r = String(s).match(/(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})/);
  if (r) return { expMin: +r[1], expMax: +r[2] };
  const p = String(s).match(/(\d{1,2})\s*\+/);
  if (p) return { expMin: +p[1], expMax: null };
  const n = String(s).match(/(\d{1,2})/);
  return n ? { expMin: +n[1], expMax: +n[1] + 2 } : {};
}

const PROVIDERS = {
  /* ---------------- Greenhouse ---------------- */
  greenhouse: {
    async fetch(slug) {
      const j = await getJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
      if (!j || !Array.isArray(j.jobs)) return null;
      return j.jobs.map((x) => norm({
        title: x.title,
        location: x.location && x.location.name,
        url: x.absolute_url,
        department: (x.departments || []).map((d) => d.name).join(', '),
        description: stripHtml(decodeEntities(x.content || '')),
        updated: x.updated_at,
      }));
    },
  },

  /* ---------------- Lever ---------------- */
  lever: {
    async fetch(slug) {
      const j = await getJson(`https://api.lever.co/v0/postings/${slug}?mode=json`);
      if (!Array.isArray(j)) return null;
      return j.map((x) => norm({
        title: x.text,
        location: (x.categories && x.categories.location) || '',
        url: x.hostedUrl,
        department: (x.categories && (x.categories.team || x.categories.department)) || '',
        employmentType: (x.categories && x.categories.commitment) || '',
        description: [
          x.descriptionPlain || stripHtml(x.description),
          ...(x.lists || []).map((l) => `${l.text}\n${stripHtml(l.content)}`),
          x.additionalPlain || '',
        ].join('\n'),
        updated: x.createdAt ? new Date(x.createdAt).toISOString() : '',
      }));
    },
  },

  /* ---------------- Ashby ---------------- */
  ashby: {
    async fetch(slug) {
      const j = await getJson(
        `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`
      );
      if (!j || !Array.isArray(j.jobs)) return null;
      return j.jobs.map((x) => norm({
        title: x.title,
        location: x.location || (x.address && x.address.postalAddress &&
          [x.address.postalAddress.addressLocality, x.address.postalAddress.addressRegion]
            .filter(Boolean).join(', ')) || '',
        url: x.jobUrl || x.applyUrl,
        department: x.department || x.team || '',
        employmentType: x.employmentType || '',
        description: x.descriptionPlain || stripHtml(x.descriptionHtml || ''),
        updated: x.publishedAt || '',
      }));
    },
  },

  /* ---------------- SmartRecruiters (list + detail hydrate) ---------------- */
  smartrecruiters: {
    async fetch(slug) {
      const all = [];
      for (let offset = 0; offset < 600; offset += 100) {
        const j = await getJson(
          `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100&offset=${offset}`
        );
        if (!j || !Array.isArray(j.content)) return all.length ? all : null;
        all.push(...j.content);
        if (j.content.length < 100) break;
      }
      if (!all.length) return null;
      const hydrated = await pool(all, 8, async (x) => {
        const d = await getJson(`https://api.smartrecruiters.com/v1/companies/${slug}/postings/${x.id}`);
        const sec = (d && d.jobAd && d.jobAd.sections) || {};
        const desc = ['jobDescription', 'qualifications', 'additionalInformation', 'companyDescription']
          .map((k) => sec[k] && sec[k].text).filter(Boolean).map(stripHtml).join('\n');
        return norm({
          title: x.name,
          location: [x.location && x.location.city, x.location && x.location.country]
            .filter(Boolean).join(', '),
          url: `https://jobs.smartrecruiters.com/${slug}/${x.id}`,
          department: (x.department && x.department.label) || '',
          employmentType: (x.typeOfEmployment && x.typeOfEmployment.label) || '',
          description: desc,
          updated: x.releasedDate || '',
        });
      });
      return hydrated;
    },
  },

  /* ---------------- Workable ----------------
   * The v1 widget returns full descriptions inline (one request, no detail hop).
   * The v3 POST endpoint lists jobs but its per-job detail route 404s, so v3 is
   * only a fallback for boards the widget does not serve. */
  workable: {
    async fetch(slug) {
      const j = await getJson(`https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`);
      if (j && Array.isArray(j.jobs) && j.jobs.length) {
        return j.jobs.map((x) => norm({
          title: x.title,
          location: [x.city, x.country].filter(Boolean).join(', '),
          url: x.url || x.shortlink || x.application_url,
          department: x.department || '',
          employmentType: x.employment_type || '',
          description: stripHtml(`${x.description || ''}\n${x.requirements || ''}\n${x.benefits || ''}`) +
            (x.experience ? `\nExperience level: ${x.experience}` : ''),
          updated: x.published_on || x.created_at || '',
        }));
      }
      const r = await req(`https://apply.workable.com/api/v3/accounts/${slug}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '', location: [], department: [], worktype: [] }),
      });
      if (!r.ok) return null;
      let list = null;
      try { list = (JSON.parse(r.text) || {}).results; } catch { return null; }
      if (!Array.isArray(list) || !list.length) return null;
      return list.map((x) => norm({
        title: x.title,
        location: (x.locations || []).map((l) => [l.city, l.country].filter(Boolean).join(', ')).join(' | ')
          || (x.location && x.location.city) || '',
        url: `https://apply.workable.com/j/${x.shortcode}`,
        department: Array.isArray(x.department) ? x.department.join(', ') : (x.department || ''),
        employmentType: x.workplace || '',
        description: stripHtml(x.description || ''),
        updated: x.published || '',
      }));
    },
  },

  /* ---------------- Recruitee ---------------- */
  recruitee: {
    async fetch(slug) {
      const j = await getJson(`https://${slug}.recruitee.com/api/offers/`);
      if (!j || !Array.isArray(j.offers)) return null;
      return j.offers.map((x) => norm({
        title: x.title,
        location: [x.city, x.country].filter(Boolean).join(', '),
        url: x.careers_url || x.careers_apply_url,
        department: x.department || '',
        employmentType: x.employment_type_code || '',
        description: stripHtml((x.description || '') + '\n' + (x.requirements || '')),
        updated: x.published_at || '',
      }));
    },
  },

  /* ---------------- Personio (XML feed) ---------------- */
  personio: {
    async fetch(slug) {
      for (const host of [`${slug}.jobs.personio.de`, `${slug}.jobs.personio.com`]) {
        const r = await req(`https://${host}/xml`);
        if (!r.ok || !/<position>/i.test(r.text)) continue;
        const out = [];
        for (const m of r.text.matchAll(/<position>([\s\S]*?)<\/position>/gi)) {
          const g = (t) => {
            const mm = m[1].match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`, 'i'));
            return mm ? decodeEntities(mm[1].replace(/<!\[CDATA\[|\]\]>/g, '')).trim() : '';
          };
          const jd = [...m[1].matchAll(/<value><!\[CDATA\[([\s\S]*?)\]\]><\/value>/gi)]
            .map((x) => stripHtml(x[1])).join('\n');
          out.push(norm({
            title: g('name'), location: g('office'), department: g('department'),
            employmentType: g('employmentType'),
            url: `https://${host}/job/${g('id')}`,
            description: jd || stripHtml(g('jobDescriptions')),
            updated: g('createdAt'),
          }));
        }
        if (out.length) return out;
      }
      return null;
    },
  },

  /* ---------------- Teamtailor (public JSON-LD board) ---------------- */
  teamtailor: {
    async fetch(slug) {
      const r = await req(`https://career.${slug}.com/jobs.json`);
      if (!r.ok) return null;
      let j = null; try { j = JSON.parse(r.text); } catch { return null; }
      const list = Array.isArray(j) ? j : j.jobs;
      if (!Array.isArray(list) || !list.length) return null;
      return list.map((x) => norm({
        title: x.title, location: x.location, url: x.url || x.careersite_job_url,
        department: x.department, description: stripHtml(x.body || ''),
      }));
    },
  },

  /* ---------------- Zoho Recruit ---------------- */
  zohorecruit: {
    async fetch(slug) {
      const j = await getJson(
        `https://recruit.zoho.com/recruit/ats/GetJobOpenings?portalId=${slug}` +
        `&sortBy=Created_Time&sortOrder=desc&from=0&limit=200`
      );
      const list = j && (j.data || j.response);
      if (!Array.isArray(list) || !list.length) return null;
      return list.map((x) => norm({
        title: x.Posting_Title || x.jobTitle,
        location: [x.City, x.Country].filter(Boolean).join(', '),
        url: x.url || '',
        description: stripHtml(x.Job_Description || ''),
      }));
    },
  },

  /* ---------------- Workday (cxs API) — cfg: {host, tenant, site} ---------------- */
  workday: {
    async fetch(cfg) {
      if (!cfg || !cfg.host || !cfg.tenant || !cfg.site) return null;
      const base = `https://${cfg.host}/wday/cxs/${cfg.tenant}/${cfg.site}`;
      const all = [];
      const CAP = cfg.cap || 600;   // parent boards run to thousands; keep it bounded
      let total = 0;
      for (let offset = 0; offset < CAP; offset += 20) {
        let posts = null;
        // Workday throttles under load; a single failed page must not silently
        // truncate the board, so retry the page before giving up on it.
        for (let attempt = 0; attempt < 3 && !posts; attempt++) {
          if (attempt) await sleep(1200 * attempt);
          const r = await req(`${base}/jobs`, {
            method: 'POST', timeout: 35000, retries: 1,
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText: '' }),
          });
          if (!r.ok) continue;
          try {
            const j = JSON.parse(r.text);
            total = j.total || total;
            if (Array.isArray(j.jobPostings)) posts = j.jobPostings;
          } catch { /* retry */ }
        }
        if (!posts || !posts.length) break;
        all.push(...posts);
        if (all.length >= total) break;
      }
      if (total > all.length) {
        console.log(`      note: ${cfg.tenant}/${cfg.site} has ${total} postings, read ${all.length} (cap ${CAP})`);
      }
      if (!all.length) return null;
      // Some companies here resolve to a huge parent board (Salesforce, HPE, Palo Alto).
      // Hydrating thousands of descriptions costs hours for jobs we will never rank, so
      // only pull full text for plausibly-engineering titles, plus a sample of the rest
      // so every board still has evidence it was really read.
      const relevant = (t) => /\b(engineer|developer|software|sde|swe|programmer|architect|data|platform|mobile|android|backend|frontend|full.?stack)\b/i.test(t || '');
      const pick = new Set();
      all.forEach((x, i) => { if (relevant(x.title)) pick.add(i); });
      for (let i = 0; i < all.length && pick.size < 400; i++) pick.add(i);

      return await pool(all, 6, async (x, i) => {
        const info = pick.has(i)
          ? await getJson(`${base}${x.externalPath}`).then((d) => d && d.jobPostingInfo)
          : null;
        return norm({
          title: x.title,
          location: x.locationsText || (info && info.location) || '',
          url: (info && info.externalUrl) || `https://${cfg.host}/${cfg.site}${x.externalPath}`,
          employmentType: (info && info.timeType) || '',
          description: info ? stripHtml(info.jobDescription || '') : '',
          updated: x.postedOn || (info && info.startDate) || '',
        });
      });
    },
  },

  /* ---------------- Keka (India-heavy; has a structured experience field) ----------------
   * cfg: {tenant, board?}  ->  /embedjobs/default/active/{board}  or  /jobs/default/active */
  keka: {
    async fetch(cfg) {
      const tenant = typeof cfg === 'string' ? cfg : cfg.tenant;
      const board = typeof cfg === 'object' ? cfg.board : null;
      const urls = board
        ? [`https://${tenant}.keka.com/careers/api/embedjobs/default/active/${board}`]
        : [`https://${tenant}.keka.com/careers/api/jobs/default/active`];
      for (const u of urls) {
        const j = await getJson(u);
        if (!Array.isArray(j) || !j.length) continue;
        return j.map((x) => norm({
          title: x.title,
          location: (x.jobLocations || []).map((l) => [l.city, l.countryName].filter(Boolean).join(', ')).join(' | '),
          url: `https://${tenant}.keka.com/careers/jobdetails/${x.id}`,
          department: x.departmentName || '',
          employmentType: x.jobType || '',
          description: stripHtml(x.description || '') + '\n' + (x.skillNames || []).join(', '),
          updated: x.publishedOn || '',
          ...parseExpString(x.experience),
        }));
      }
      return null;
    },
  },

  /* ---------------- Sense (sensehq) — structured experience_start/end ---------------- */
  sensehq: {
    async fetch(slug) {
      const j = await getJson(`https://${slug}.sensehq.com/careers/api/jobs`);
      const rows = j && j.data && j.data.rows;
      if (!Array.isArray(rows) || !rows.length) return null;
      return rows.map((x) => norm({
        title: x.title,
        location: x.location || (x.office && x.office.name) || '',
        url: `https://${slug}.sensehq.com/careers/job/${x.id}`,
        department: x.department || '',
        employmentType: x.job_type || '',
        description: stripHtml(x.description_external || ''),
        updated: x.created_on || '',
        expMin: x.experience_start ?? null,
        expMax: x.experience_end ?? null,
      }));
    },
  },

  /* ---------------- BambooHR (list + detail hydrate) ---------------- */
  bamboohr: {
    async fetch(slug) {
      const j = await getJson(`https://${slug}.bamboohr.com/careers/list`);
      const list = j && j.result;
      if (!Array.isArray(list) || !list.length) return null;
      return await pool(list, 6, async (x) => {
        const d = await getJson(`https://${slug}.bamboohr.com/careers/${x.id}/detail`);
        const o = d && d.result && d.result.jobOpening;
        return norm({
          title: x.jobOpeningName,
          location: [x.location && x.location.city, x.location && x.location.state,
                     x.location && x.location.country].filter(Boolean).join(', '),
          url: `https://${slug}.bamboohr.com/careers/${x.id}`,
          department: x.departmentLabel || '',
          employmentType: x.employmentStatusLabel || '',
          description: stripHtml((o && (o.description || o.jobOpeningDescription)) || ''),
        });
      });
    },
  },

  /* ---------------- Breezy HR (list JSON, description from JSON-LD on detail page) ------- */
  breezy: {
    async fetch(slug) {
      const j = await getJson(`https://${slug}.breezy.hr/json`);
      if (!Array.isArray(j) || !j.length) return null;
      return await pool(j, 6, async (x) => {
        const page = await req(`https://${slug}.breezy.hr/p/${x.friendly_id || x.id}`);
        const ld = page.ok ? jsonLd(page.text) : null;
        return norm({
          title: x.name,
          location: (x.location && (x.location.name ||
            [x.location.city, x.location.country && x.location.country.name].filter(Boolean).join(', '))) || '',
          url: x.url || `https://${slug}.breezy.hr/p/${x.friendly_id}`,
          department: (x.department && x.department.name) || x.department || '',
          employmentType: (x.type && x.type.name) || '',
          description: ld ? stripHtml(ld.description || '') : '',
          updated: x.published_date || '',
        });
      });
    },
  },

  /* ---------------- Rippling ATS ---------------- */
  rippling: {
    async fetch(slug) {
      const j = await getJson(`https://api.rippling.com/platform/api/ats/v1/board/${slug}/jobs`);
      if (!Array.isArray(j) || !j.length) return null;
      return await pool(j, 6, async (x) => {
        const d = await getJson(
          `https://api.rippling.com/platform/api/ats/v1/board/${slug}/jobs/${x.uuid}`);
        // Rippling returns `description` as an object of named HTML sections
        // (company / role / requirements), not a string.
        const raw = d && (d.descriptionHtml || d.description);
        const text = raw && typeof raw === 'object'
          ? Object.values(raw).filter((v) => typeof v === 'string').join('\n')
          : (raw || '');
        return norm({
          title: x.name,
          location: (x.workLocation && x.workLocation.label) || '',
          url: x.url || '',
          department: (x.department && x.department.label) || '',
          description: stripHtml(text),
        });
      });
    },
  },

  /* ---------------- Comeet — cfg: {uid, token} ---------------- */
  comeet: {
    async fetch(cfg) {
      if (!cfg || !cfg.uid || !cfg.token) return null;
      const j = await getJson(
        `https://www.comeet.co/careers-api/2.0/company/${cfg.uid}/positions?token=${cfg.token}&details=true`);
      if (!Array.isArray(j) || !j.length) return null;
      return j.map((x) => norm({
        title: x.name,
        location: (x.location && (x.location.name ||
          [x.location.city, x.location.country].filter(Boolean).join(', '))) || '',
        url: x.url_comeet_hosted_page || x.url_active_page || x.position_url || '',
        department: x.department || '',
        employmentType: x.employment_type || '',
        description: stripHtml([x.details && x.details.map
          ? x.details.map((d) => `${d.name}\n${d.value}`).join('\n') : '', x.description || ''].join('\n')),
        updated: x.time_updated || '',
      }));
    },
  },

  /* ---------------- Jobvite XML feed ---------------- */
  jobvite: {
    async fetch(company) {
      const r = await req(`https://hire.jobvite.com/CompanyJobs/Xml.aspx?c=${company}`, { timeout: 60000 });
      if (!r.ok || !/<job>/i.test(r.text)) return null;
      const out = [];
      for (const m of r.text.matchAll(/<job>([\s\S]*?)<\/job>/gi)) {
        const g = (t) => {
          const mm = m[1].match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`, 'i'));
          return mm ? decodeEntities(mm[1].replace(/<!\[CDATA\[|\]\]>/g, '')).trim() : '';
        };
        // Jobvite feeds vary in tag spelling between accounts.
        const id = g('id') || g('externalJobPostingId') || g('requisitionid');
        out.push(norm({
          title: g('title'),
          location: [g('city'), g('state'), g('country')].filter(Boolean).join(', ') || g('location'),
          url: g('applyUrl') || g('apply-url') || g('detailUrl') || g('detail-url') || g('link') ||
               (id ? `https://jobs.jobvite.com/${company}/job/${id}` : ''),
          department: g('category') || g('department'),
          employmentType: g('jobtype') || g('job-type'),
          description: stripHtml(`${g('description')}\n${g('qualifications')}`),
          updated: g('date') || g('postedDate'),
        }));
      }
      return out.length ? out : null;
    },
  },

  /* ---------------- Teamtailor JSON feed — cfg: full host ---------------- */
  teamtailorJson: {
    async fetch(host) {
      const j = await getJson(`https://${host}/jobs.json`);
      const list = Array.isArray(j) ? j : (j && (j.items || j.jobs));
      if (!Array.isArray(list) || !list.length) return null;
      return list.map((x) => norm({
        title: x.title,
        location: x.location || '',
        url: x.url || x.id || '',
        description: stripHtml(x.content_html || x.body || x.summary || ''),
        updated: x.date_published || '',
      }));
    },
  },

  /* ---------------- Generic JSON board ----------------
   * For the long tail of custom/niche ATSs. Config describes where the data lives:
   *   { url, headers?, listPath?, fields:{title,location,url,description,...},
   *     urlPrefix?, detail?:{url, listPath?, field} }
   * `listPath` and every field name may be a dot-path ("data.rows", "location.city"). */
  jsonapi: {
    async fetch(cfg) {
      if (!cfg || !cfg.url) return null;
      const dig = (o, p) => (!p ? o : p.split('.').reduce((a, k) => (a == null ? a : a[k]), o));
      const j = await getJson(cfg.url, { headers: cfg.headers || {} });
      if (!j) return null;
      const list = dig(j, cfg.listPath);
      if (!Array.isArray(list) || !list.length) return null;
      const f = cfg.fields || {};
      const val = (x, key) => {
        const v = dig(x, key);
        if (v == null) return '';
        if (Array.isArray(v)) {
          return v.map((e) => (typeof e === 'object' && e ? (e.name || e.city || e.label || '') : e))
                  .filter(Boolean).join(', ');
        }
        if (typeof v === 'object') return v.name || v.city || v.label || v.title || '';
        return String(v);
      };
      return await pool(list, 6, async (x) => {
        let description = f.description ? stripHtml(val(x, f.description)) : '';
        const link = (cfg.urlPrefix || '') + (f.url ? val(x, f.url) : '');
        if (!description && cfg.detail) {
          const durl = cfg.detail.url.replace(/\{(\w[\w.]*)\}/g, (_, k) => val(x, k));
          const d = await getJson(durl, { headers: cfg.headers || {} });
          description = d ? stripHtml(String(dig(dig(d, cfg.detail.listPath), cfg.detail.field) || '')) : '';
        }
        if (!description && cfg.detailFromPage && link) {
          const page = await req(link);
          const ld = page.ok ? jsonLd(page.text) : null;
          if (ld) description = stripHtml(ld.description || '');
        }
        return norm({
          title: val(x, f.title), location: val(x, f.location), url: link,
          department: f.department ? val(x, f.department) : '',
          employmentType: f.employmentType ? val(x, f.employmentType) : '',
          description, updated: f.updated ? val(x, f.updated) : '',
          ...parseExpString(f.experience ? val(x, f.experience) : ''),
        });
      });
    },
  },

  /* ---------------- HTML board -> follow job links -> JSON-LD ----------------
   * Covers ATSs with no public API (JazzHR, Freshteam, hand-rolled career pages).
   * cfg: { url, linkPattern, base?, cap? } */
  htmlBoard: {
    async fetch(cfg) {
      if (!cfg || !cfg.url || !cfg.linkPattern) return null;
      const r = await req(cfg.url, { timeout: 40000 });
      if (!r.ok) return null;
      const re = new RegExp(cfg.linkPattern, 'gi');
      const links = [...new Set([...r.text.matchAll(re)].map((m) => {
        const href = m[1] || m[0];
        return href.startsWith('http') ? href : (cfg.base || '') + href;
      }))].slice(0, cfg.cap || 120);
      if (!links.length) return null;
      const out = await pool(links, 6, async (u) => {
        const p = await req(u, { timeout: 25000, retries: 1 });
        if (!p.ok) return null;
        const ld = jsonLd(p.text);
        if (!ld || !ld.title) return null;
        const loc = Array.isArray(ld.jobLocation) ? ld.jobLocation[0] : ld.jobLocation;
        const a = (loc && loc.address) || {};
        return norm({
          title: ld.title, url: u,
          location: [a.addressLocality, a.addressRegion,
            a.addressCountry && (a.addressCountry.name || a.addressCountry)].filter(Boolean).join(', ')
            || (ld.jobLocationType === 'TELECOMMUTE' ? 'Remote' : ''),
          employmentType: Array.isArray(ld.employmentType) ? ld.employmentType.join(', ') : (ld.employmentType || ''),
          description: stripHtml(ld.description || ''),
          updated: ld.datePosted || '',
        });
      });
      const clean = out.filter((x) => x && x.title);
      return clean.length ? clean : null;
    },
  },

  /* ---------------- Next.js _next/data board (buildId rotates per deploy) ------- */
  nextdata: {
    async fetch(cfg) {
      if (!cfg || !cfg.page) return null;
      // The buildId changes on every deploy, so resolve it fresh instead of pinning.
      const page = await req(cfg.page, { timeout: 30000 });
      if (!page.ok) return null;
      const id = (page.text.match(/"buildId"\s*:\s*"([^"]+)"/) || [])[1];
      if (!id) return null;
      const j = await getJson(`${cfg.origin}/_next/data/${id}/${cfg.path}`);
      const dig = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
      const list = j && dig(j, cfg.listPath);
      if (!Array.isArray(list) || !list.length) return null;
      const f = cfg.fields || {};
      return list.map((x) => norm({
        title: x[f.title], location: x[f.location],
        url: (cfg.urlPrefix || '') + (x[f.url] || ''),
        department: x[f.department] || '',
        employmentType: x[f.employmentType] || '',
        description: stripHtml(x[f.description] || ''),
      }));
    },
  },

  /* ---------------- Sitemap of job pages -> JSON-LD JobPosting ---------------- */
  sitemap: {
    async fetch(cfg) {
      if (!cfg || !cfg.url) return null;
      const r = await req(cfg.url, { timeout: 45000 });
      if (!r.ok) return null;
      let urls = [...r.text.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)].map((m) => m[1].trim());
      if (cfg.match) urls = urls.filter((u) => new RegExp(cfg.match, 'i').test(u));
      // Nested sitemap index: follow one level down.
      if (!urls.length || /sitemap/i.test(urls[0] || '')) {
        const sub = urls.filter((u) => /\.xml/i.test(u)).slice(0, 5);
        const more = [];
        for (const s of sub) {
          const rr = await req(s, { timeout: 45000 });
          if (rr.ok) more.push(...[...rr.text.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)].map((m) => m[1].trim()));
        }
        urls = cfg.match ? more.filter((u) => new RegExp(cfg.match, 'i').test(u)) : more;
      }
      urls = [...new Set(urls)].slice(0, cfg.cap || 250);
      if (!urls.length) return null;
      const out = await pool(urls, 8, async (u) => {
        const p = await req(u, { timeout: 25000, retries: 1 });
        if (!p.ok) return null;
        const ld = jsonLd(p.text);
        if (!ld || !ld.title) {
          // No JSON-LD (e.g. Zurich): fall back to the server-rendered HTML.
          // Strip the boilerplate suffix career sites append to <title>.
          const raw = (p.text.match(/<title>([^<]*)<\/title>/i) || [])[1];
          if (!raw) return null;
          const title = decodeEntities(raw)
            .replace(/\s*\|.*$/, '').replace(/\s*(job details|job|careers?)\s*$/i, '').trim();
          if (!title) return null;
          const body = stripHtml(p.text);
          const meta = (p.text.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i) || [])[1] || '';
          return norm({
            title, url: u,
            location: (body.match(/\b(?:Location|Office)\s*:?\s*([A-Za-z .,'-]{3,60})/) || [])[1] || '',
            description: `${decodeEntities(meta)}\n${body}`.slice(0, 20000),
          });
        }
        const loc = ld.jobLocation;
        const addr = (Array.isArray(loc) ? loc[0] : loc) || {};
        const a = addr.address || {};
        return norm({
          title: ld.title, url: u,
          location: [a.addressLocality, a.addressRegion, a.addressCountry &&
            (a.addressCountry.name || a.addressCountry)].filter(Boolean).join(', '),
          employmentType: Array.isArray(ld.employmentType) ? ld.employmentType.join(', ') : (ld.employmentType || ''),
          description: stripHtml(ld.description || ''),
          updated: ld.datePosted || '',
        });
      });
      const clean = out.filter((x) => x && x.title);
      return clean.length ? clean : null;
    },
  },

  /* ---------------- SuccessFactors / generic RSS fallback ---------------- */
  rss: {
    async fetch(cfg) {
      const url = typeof cfg === 'string' ? cfg : cfg && cfg.url;
      if (!url) return null;
      const r = await req(url);
      if (!r.ok) return null;
      const items = [...r.text.matchAll(/<(?:item|entry)>([\s\S]*?)<\/(?:item|entry)>/gi)];
      if (!items.length) return null;
      return items.map((m) => {
        const g = (t) => {
          const mm = m[1].match(new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`, 'i'));
          return mm ? decodeEntities(mm[1].replace(/<!\[CDATA\[|\]\]>/g, '')).trim() : '';
        };
        // content:encoded carries the full post body on WordPress-style feeds;
        // <description> is often only a truncated excerpt.
        const body = g('content:encoded') || g('content') || g('description') || g('summary');
        return norm({
          title: g('title'),
          url: g('link') || (m[1].match(/<link[^>]*href=["']([^"']+)/i) || [])[1] || '',
          location: g('location') || g('job:location'),
          department: g('category') || g('department'),
          description: stripHtml(body),
          updated: g('pubDate') || g('published') || g('updated'),
        });
      });
    },
  },
};

/* ------------------------------------------------------------------ *
 * DISCOVERY — probe providers x slugs, keep the first real board
 * ------------------------------------------------------------------ */

const PROBE_ORDER = ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable', 'recruitee', 'personio'];

async function discoverCompany(c) {
  for (const slug of c.slugs) {
    for (const p of PROBE_ORDER) {
      // Cheap probes first: skip the expensive hydrating providers on a miss.
      let jobs = null;
      try { jobs = await PROVIDERS[p].fetch(slug); } catch { jobs = null; }
      if (Array.isArray(jobs) && jobs.length > 0) {
        return { company: c.name, provider: p, token: slug, count: jobs.length };
      }
    }
  }
  return { company: c.name, provider: null, token: null, count: 0 };
}

async function runDiscovery() {
  console.log(`Probing ${COMPANIES.length} companies across ${PROBE_ORDER.length} ATS providers...\n`);
  const results = await pool(COMPANIES, 6, async (c) => {
    const r = await discoverCompany(c);
    console.log(
      r.provider
        ? `  HIT  ${c.name.padEnd(24)} ${r.provider}/${r.token}  (${r.count} jobs)`
        : `  ---  ${c.name.padEnd(24)} no board found`
    );
    return r;
  });

  const existing = fs.existsSync(MAP_FILE) ? JSON.parse(fs.readFileSync(MAP_FILE, 'utf8')) : {};
  for (const r of results) {
    if (r.provider) existing[r.company] = { provider: r.provider, token: r.token, count: r.count };
    else if (!existing[r.company]) existing[r.company] = { provider: null, token: null, count: 0 };
  }
  fs.writeFileSync(MAP_FILE, JSON.stringify(existing, null, 2));

  const hits = results.filter((r) => r.provider).length;
  console.log(`\nDiscovered ${hits}/${COMPANIES.length}. Map written to ats-map.json`);
  const misses = results.filter((r) => !r.provider).map((r) => r.company);
  if (misses.length) console.log(`\nUnresolved (need manual endpoint):\n  ${misses.join('\n  ')}`);
}

/* ------------------------------------------------------------------ *
 * CLASSIFICATION
 * ------------------------------------------------------------------ */

const SWE_TITLE = /\b(software|backend|back[- ]end|frontend|front[- ]end|full[- ]?stack|mobile|android|ios|platform|application|systems?|web|api|cloud|data|devops|sre|site reliability|embedded|firmware|qa|test|automation|machine learning|ml|ai)\b[\w /&+-]*\b(engineer|developer|programmer|sde|swe|architect)\b|\b(engineer|developer)\b.*\b(software|backend|frontend|full[- ]?stack|mobile|android|ios|java|python|flutter|dart)\b|\bsde\s*-?\s*(i{1,3}|[123])\b|\bswe\b|\bmts\b|member of technical staff/i;

const NON_ENG = /\b(sales|account executive|recruit|talent|marketing|customer success|support specialist|hr\b|people ops|finance|accountant|legal|counsel|office manager|executive assistant|content writer|copywriter|designer|ux researcher|product manager|program manager|project manager|business analyst|solutions? (consultant|architect|engineer)|sales engineer|pre[- ]?sales|presales|systems engineer|application engineer|field engineer|implementation|technical writer|scrum master|intern(ship)?|community|partnerships?|procurement|payroll|facilities|security guard|nurse|veterinar|clinical|warehouse|driver|technician\b)/i;

/** Titles that are unambiguously software, even when a hardware word appears
 *  ("Software Engineer - Hardware Test" writes test software; keep it). */
const EXPLICIT_SW = /\b(software|backend|back[- ]end|frontend|front[- ]end|full[- ]?stack|web|mobile|android|ios|data|devops|sre|site reliability|platform|cloud|api|ml|machine learning|ai|simulation)\s+(engineer|developer)\b|\bsoftware (development )?engineer\b|\bsde\b|\bswe\b/i;

/** Engineering disciplines that are not software engineering. */
const HARDWARE = /\b(mechanical|mechatronic|electrical|electronic|hardware|structural|civil|chemical|process|manufacturing|industrial|packaging|rf|antenna|pcb|thermal|optical|propulsion|avionics|materials|battery|cell|crash|equipment design|design engineer|field service|facilities|network engineer|validation)\b/i;

const SENIOR = /\b(senior|sr\.?|staff|principal|lead\b|manager|director|head of|vp\b|vice president|architect|distinguished|fellow|expert|chief)\b/i;
const JUNIOR = /\b(junior|jr\.?|associate|entry[- ]level|graduate|new grad|campus|trainee|apprentice|early career|i{1,2}\b|[12]\b)\b/i;

const PRIORITY_STACK = {
  java:    /\bjava\b(?!script)/i,
  dart:    /\bdart\b/i,
  flutter: /\bflutter\b/i,
};
const SECONDARY_STACK = /\b(spring boot|spring framework|kotlin|android|j2ee|jvm|hibernate|microservices)\b/i;

const NUMWORD = { zero:0, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10 };

/**
 * Phrases that contain "N years" but are NOT a candidate experience requirement.
 * Without this filter, boilerplate like "sabbatical for employees with 5+ years of
 * service" and "we're 15 years old" get parsed as job requirements.
 */
/* Only genuinely non-requirement contexts belong here. Do NOT add domain words
 * like "sales" — that silently discards real requirements ("5+ years of
 * experience in technical pre-sales"), leaving the role looking open-level and
 * letting senior reqs match. Unwanted job families are excluded by title
 * (see NON_ENG) instead. */
const YEAR_NOISE = /\b(of service|sabbatical|tenure|anniversar|years old|founded|been around|our history|warranty|visa|lease|guarantee|vesting|vested|over the (?:past|last)|in the (?:past|last)|age of|per year|a year|\/year|each year|every year|last year|this year|next year|paid leave|pto|holiday)\b/i;

/** Extract stated experience requirements as {min,max} year ranges, with noise filtered. */
function extractExperience(text) {
  if (!text) return [];
  const t = text.toLowerCase().replace(/[‐-―−]/g, '-');
  const ranges = [];
  const num = (s) => (NUMWORD[s] !== undefined ? NUMWORD[s] : parseFloat(s));
  const N = '(\\d{1,2}(?:\\.\\d)?|zero|one|two|three|four|five|six|seven|eight|nine|ten)';

  const push = (m, min, max) => {
    // Reject the match if its surrounding sentence is boilerplate, not a requirement.
    const ctx = t.slice(Math.max(0, m.index - 75), m.index + m[0].length + 75);
    if (YEAR_NOISE.test(ctx)) return;
    if (!isFinite(min) || min > 30) return;
    // Track which line the requirement sits on. Requirements on DIFFERENT lines are
    // conjunctive ("3+ yrs overall" AND "2+ yrs on platform X"); alternatives within
    // one line are disjunctive ("3+ yrs with a Master's OR 5+ yrs").
    const line = (t.slice(0, m.index).match(/\n/g) || []).length;
    ranges.push({ min, max, raw: m[0].trim(), at: m.index, line, ctx: ctx.trim() });
  };

  // "2-4 years", "2 to 4 years", "between 2 and 4 years"
  for (const m of t.matchAll(new RegExp(`${N}\\s*(?:-|to|and)\\s*${N}\\+?\\s*(?:years?|yrs?)`, 'g'))) {
    const a = num(m[1]), b = num(m[2]);
    if (isFinite(b) && b >= a && b <= 30) push(m, a, b);
  }
  // "2+ years", "minimum 2 years", "3+ years of software engineering experience".
  // The gap before the anchor word must be GENERAL — job ads put arbitrary
  // qualifiers there ("of professional software engineering experience"), and a
  // fixed adjective list silently drops most real requirements.
  const GAP = "(?:[A-Za-z+#/&.'’-]+\\s+){0,6}?";
  const ANCHOR = '(?:experience|expertise|exp\\b|background|developing|building|working|programming|coding|writing|designing)';
  for (const m of t.matchAll(
    new RegExp(
      `(?:(?:minimum|min\\.?|at least|over|more than|atleast|least)\\s+(?:of\\s+)?)?` +
      `${N}\\s*(\\+|plus)?\\s*(?:years?|yrs?)['’]?s?\\s*(?:\\+|plus)?\\s*(?:of\\s+|in\\s+|with\\s+)?` +
      `${GAP}${ANCHOR}`, 'g')
  )) {
    const a = num(m[1]);
    // Skip if the range pass already captured this same phrase.
    if (ranges.some((r) => Math.abs(r.at - m.index) < 30)) continue;
    push(m, a, m[2] ? null : a + 2);
  }
  // Bare "5+ years" with no anchor word nearby — still a requirement in bullet lists.
  for (const m of t.matchAll(new RegExp(`${N}\\s*(\\+|plus)\\s*(?:years?|yrs?)\\b`, 'g'))) {
    if (ranges.some((r) => Math.abs(r.at - m.index) < 40)) continue;
    push(m, num(m[1]), null);
  }
  return ranges;
}

/** Numeric level suffix in a title: "Engineer II" -> 2, "SDE-1" -> 1, "Engineer III" -> 3. */
const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5 };
function titleLevel(title) {
  const m = title.match(/\b(?:engineer|developer|sde|swe|programmer)\s*[-–, ]?\s*(iv|iii|ii|i|v|[1-5])\b/i);
  if (!m) return null;
  const k = m[1].toLowerCase();
  return ROMAN[k] !== undefined ? ROMAN[k] : parseInt(k, 10);
}

/**
 * Does this posting accept a ~2-year engineer?
 * Stated years always win over title level (a "Software Engineer III" whose ad says
 * "Masters + 2 years" genuinely is reachable at 2 years).
 */
function fitsTwoYears(ranges, title) {
  if (ranges.length) {
    // Within a line: the lowest figure wins (they are alternative routes in).
    // Across lines: the HIGHEST of those wins, since each bullet is a separate
    // requirement the candidate must independently satisfy. Taking the global
    // minimum instead lets a low technology-specific bullet mask a high overall bar.
    const byLine = new Map();
    for (const r of ranges) {
      const cur = byLine.get(r.line);
      if (!cur || r.min < cur.min) byLine.set(r.line, r);
    }
    const perLine = [...byLine.values()];
    const floor = perLine.reduce((a, b) => (b.min > a.min ? b : a));
    const maxOk = floor.max === null || floor.max >= 2;
    return { fit: floor.min <= 2.5 && maxOk, min: floor.min, stated: true, evidence: floor.raw };
  }
  // No years stated anywhere. Fall back to title signals.
  const lvl = titleLevel(title);
  if (SENIOR.test(title)) return { fit: false, min: null, stated: false, evidence: 'no years stated; senior-track title' };
  if (lvl !== null && lvl >= 3) return { fit: false, min: null, stated: false, evidence: `no years stated; level ${lvl} title` };
  if (JUNIOR.test(title) || (lvl !== null && lvl <= 2)) {
    return { fit: true, min: null, stated: false, evidence: `no years stated; junior/level-${lvl ?? '?'} title` };
  }
  // An unqualified "Software Engineer" with no seniority marker and no stated years is
  // an open-level req — genuinely reachable at ~2 years. This is the common case for
  // European and startup boards, and dropping it loses real matches.
  return { fit: true, min: null, stated: false, evidence: 'no years stated; unqualified (open-level) title' };
}

function classify(job) {
  const title = job.title || '';
  const blob = `${title}\n${job.department}\n${job.description}`;
  // Software engineering only: drop sales/support engineers, and drop other
  // engineering disciplines unless the title explicitly says software.
  const isEng = SWE_TITLE.test(title) && !NON_ENG.test(title) &&
    (EXPLICIT_SW.test(title) || !HARDWARE.test(title));

  // Detect priority stacks, and grade how central each one is to the role.
  // "Java/Kotlin Software Engineer" is a very different signal from
  // "proficiency in Python, Go, or Java" — the report should say which.
  const stacks = [];
  let strength = null;
  for (const [k, re] of Object.entries(PRIORITY_STACK)) {
    if (!re.test(blob)) continue;
    stacks.push(k);
    const inTitle = re.test(title);
    const hits = (job.description.match(new RegExp(re.source, 'gi')) || []).length;
    const emphatic = new RegExp(
      `(strong|expert|deep|solid|advanced|proficien\\w*|extensive|hands-on)[^.\\n]{0,40}${re.source}` +
      `|${re.source}[^.\\n]{0,25}(developer|engineer|expertise|proficiency)`, 'i').test(blob);
    const grade = inTitle ? 'title' : (hits >= 2 || emphatic) ? 'primary' : 'listed';
    const rank = { title: 3, primary: 2, listed: 1 };
    if (!strength || rank[grade] > rank[strength]) strength = grade;
  }
  const hasSecondary = SECONDARY_STACK.test(blob);

  // A structured experience field from the ATS beats anything scraped from prose.
  let ranges, exp;
  if (job.expMin !== null && job.expMin !== undefined) {
    ranges = [{ min: job.expMin, max: job.expMax ?? null, raw: `ATS field: ${job.expMin}-${job.expMax ?? '+'} yrs`, at: 0 }];
    exp = fitsTwoYears(ranges, title);
  } else {
    ranges = extractExperience(job.description);
    exp = fitsTwoYears(ranges, title);
  }
  const senior = SENIOR.test(title);
  const lvl = titleLevel(title);

  // Priority: Java / Dart / Flutter explicitly named.
  const priority = stacks.length > 0;

  let tier;
  if (isEng && exp.fit && !senior && priority) tier = 'A';        // exact target
  else if (isEng && exp.fit && !senior) tier = 'B';               // SWE ~2yrs, other stack
  else tier = 'C';                                               // closest-match pool

  /* ---- Priority score: what the user actually cares about, in order ----
   * 1. Java / Dart / Flutter, and how central it is to the role
   * 2. How close the stated experience is to 2 years (exact beats "not stated")
   * 3. Genuinely a software engineering role
   * 4. Junior-ish level                                                     */
  let score = 0;
  if (isEng) score += 40;
  if (priority) score += { title: 34, primary: 26, listed: 15 }[strength] || 15;
  else if (hasSecondary) score += 8;

  if (exp.stated) {
    // Reward proximity to 2 years; punish a floor above 2 hard, since a 5+ yr
    // req is useless to this candidate no matter how good the stack match is.
    score += exp.min <= 2.5 ? 25 - Math.abs(exp.min - 2) * 4 : Math.max(-30, -8 * (exp.min - 2));
  } else {
    score += 6; // open-level req: plausible, but unconfirmed
  }
  if (!senior) score += 10; else score -= 15;
  if (JUNIOR.test(title)) score += 8;
  if (lvl !== null && lvl <= 2) score += 5;

  return { isEng, stacks, strength, hasSecondary, ranges, exp, senior, lvl, tier, score, priority };
}

/* ------------------------------------------------------------------ *
 * FETCH ALL
 * ------------------------------------------------------------------ */

async function fetchAll() {
  if (!fs.existsSync(MAP_FILE)) {
    console.error('No ats-map.json — run: node test.js --discover');
    process.exit(1);
  }
  const map = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'));
  const targets = COMPANIES.filter((c) => map[c.name] && map[c.name].provider);
  console.log(`Fetching postings from ${targets.length} boards...\n`);

  const results = await pool(targets, 5, async (c) => {
    const { provider, token, config, parent } = map[c.name];
    let jobs = null, error = null;
    try { jobs = await PROVIDERS[provider].fetch(config || token); }
    catch (e) { error = String((e && e.stack) || e).split('\n').slice(0, 2).join(' | '); }
    jobs = (Array.isArray(jobs) ? jobs : []).filter((j) => j && j.title);
    const withDesc = jobs.filter((j) => j.description && j.description.length > 120).length;
    // Never let a provider crash look like an empty board — that hides real breakage.
    console.log(
      `  ${c.name.padEnd(24)} ${String(jobs.length).padStart(4)} jobs  ` +
      `(${withDesc} with full description)  [${provider}]` +
      (error ? `\n      !! ERROR: ${error}` : '')
    );
    return { company: c.name, provider, token, parent, jobs, error };
  });

  fs.writeFileSync(RAW_FILE, JSON.stringify(results, null, 2));
  const total = results.reduce((n, r) => n + r.jobs.length, 0);
  console.log(`\nTotal postings fetched: ${total}`);
  return results;
}

/* ------------------------------------------------------------------ *
 * REPORT
 * ------------------------------------------------------------------ */

function fmt(company, job, cls, n, alsoIn, parent) {
  const GRADE = {
    title: 'named in job title',
    primary: 'core requirement',
    listed: 'listed among accepted languages',
  };
  const stack = cls.stacks.length
    ? `${cls.stacks.map((s) => s.toUpperCase()).join('+')}  (${GRADE[cls.strength] || '?'})`
    : cls.hasSecondary ? 'JVM-adjacent (Kotlin/Spring/Android)' : '-';
  const yrs = cls.exp.min !== null
    ? `${cls.exp.min}${cls.ranges.some((r) => r.max === null) ? '+' : ''} yrs`
    : 'not stated';
  const lines = [
    `${n}. [priority ${String(Math.round(cls.score)).padStart(3)}]  ${job.title}`,
    `   Company    : ${company}${parent ? `   [board belongs to ${parent}]` : ''}`,
    `   Location   : ${job.location || 'n/a'}`,
    `   Experience : ${yrs}   [evidence: "${(cls.exp.evidence || '').slice(0, 90)}"]`,
    `   Stack match: ${stack}`,
    `   Apply      : ${job.url}`,
  ];
  if (alsoIn && alsoIn.length) lines.splice(3, 0, `   Also in    : ${alsoIn.join(' | ')}`);
  return lines.join('\n');
}

function writeReport(results) {
  const rows = [];
  for (const r of results) {
    for (const job of r.jobs) rows.push({ company: r.company, parent: r.parent, job, cls: classify(job) });
  }

  // Boards commonly list the same req once per location. Collapse them, keeping the
  // best-classified copy and folding the extra locations into one line.
  const dedupe = (list) => {
    const seen = new Map();
    for (const x of list) {
      const key = `${x.company}::${x.job.title.toLowerCase().replace(/\s+/g, ' ').trim()}`;
      const prev = seen.get(key);
      if (!prev) { seen.set(key, x); continue; }
      if (x.cls.score > prev.cls.score) { x.alsoIn = prev.alsoIn || []; seen.set(key, x); }
      else prev.alsoIn = prev.alsoIn || [];
      const keep = seen.get(key);
      const loc = x.job.location;
      if (loc && loc !== keep.job.location && !keep.alsoIn.includes(loc)) keep.alsoIn.push(loc);
    }
    return [...seen.values()];
  };

  const A = dedupe(rows.filter((x) => x.cls.tier === 'A')).sort((a, b) => b.cls.score - a.cls.score);
  const B = dedupe(rows.filter((x) => x.cls.tier === 'B')).sort((a, b) => b.cls.score - a.cls.score);

  // Fallback proof-of-fetch: best available posting from EVERY company with a board.
  const closest = [];
  for (const r of results) {
    if (!r.jobs.length) continue;
    const mine = rows.filter((x) => x.company === r.company);
    if (mine.some((x) => x.cls.tier === 'A' || x.cls.tier === 'B')) continue;
    const best = mine.sort((a, b) => b.cls.score - a.cls.score)[0];
    if (best) closest.push(best);
  }

  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const totalJobs = rows.length;
  const boards = results.filter((r) => r.jobs.length).length;

  const out = [];
  out.push('='.repeat(78));
  out.push('CAREERS REPORT — Software Engineer (~2 years experience)');
  out.push('Priority stacks: Java, Dart/Flutter');
  out.push(`Generated: ${stamp}`);
  out.push(`Scanned: ${results.length} boards | ${boards} returned postings | ${totalJobs} postings parsed`);
  out.push('='.repeat(78));
  out.push('');

  out.push('-'.repeat(78));
  out.push(`TIER A — MATCH: Software Engineer, ~2 yrs, JAVA or DART/FLUTTER  (${A.length})`);
  out.push('-'.repeat(78));
  out.push(A.length ? A.map((x, i) => fmt(x.company, x.job, x.cls, i + 1, x.alsoIn, x.parent)).join('\n\n')
                    : '  (none open right now)');
  out.push('');

  out.push('-'.repeat(78));
  out.push(`TIER B — MATCH: Software Engineer, ~2 yrs, other stacks  (${B.length})`);
  out.push('-'.repeat(78));
  out.push(B.length ? B.map((x, i) => fmt(x.company, x.job, x.cls, i + 1, x.alsoIn, x.parent)).join('\n\n')
                    : '  (none open right now)');
  out.push('');

  out.push('-'.repeat(78));
  out.push(`TIER C — CLOSEST POSTING PER REMAINING COMPANY (fetch proof)  (${closest.length})`);
  out.push('  No 2-yr SWE role at these companies; the nearest live posting is shown');
  out.push('  to demonstrate the scraper genuinely read each board.');
  out.push('-'.repeat(78));
  out.push(closest.length ? closest.map((x, i) => fmt(x.company, x.job, x.cls, i + 1, x.alsoIn, x.parent)).join('\n\n')
                          : '  (n/a)');
  out.push('');

  const dead = results.filter((r) => !r.jobs.length).map((r) => r.company);
  if (dead.length) {
    out.push('-'.repeat(78));
    out.push(`BOARDS THAT RETURNED ZERO POSTINGS  (${dead.length})`);
    out.push('-'.repeat(78));
    out.push(dead.map((d) => `  - ${d}`).join('\n'));
    out.push('');
  }

  fs.writeFileSync(OUT_FILE, out.join('\n'));
  console.log(`\nWrote careers.txt  —  Tier A: ${A.length} | Tier B: ${B.length} | Tier C: ${closest.length}`);
  return { A, B, closest, rows };
}

/* ------------------------------------------------------------------ *
 * VERIFY — prove the pipeline actually read the boards
 * ------------------------------------------------------------------ */

function verify() {
  const results = JSON.parse(fs.readFileSync(RAW_FILE, 'utf8'));
  const map = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'));
  let bad = 0;
  console.log('\n=== SELF-CHECK ===\n');

  const withJobs = results.filter((r) => r.jobs.length);
  console.log(`Boards returning postings : ${withJobs.length}/${results.length}`);

  const noDesc = withJobs.filter((r) => !r.jobs.some((j) => j.description.length > 200));
  console.log(`Boards with NO descriptions: ${noDesc.length}` +
    (noDesc.length ? ` -> ${noDesc.map((r) => r.company).join(', ')}` : ''));
  bad += noDesc.length;

  const noUrl = withJobs.filter((r) => r.jobs.some((j) => !/^https?:/.test(j.url)));
  console.log(`Boards with bad apply URLs : ${noUrl.length}` +
    (noUrl.length ? ` -> ${noUrl.map((r) => r.company).join(', ')}` : ''));
  bad += noUrl.length;

  const expHit = results.flatMap((r) => r.jobs).filter((j) => extractExperience(j.description).length);
  const allJobs = results.flatMap((r) => r.jobs);
  console.log(`Postings with parsed years : ${expHit.length}/${allJobs.length} ` +
    `(${((expHit.length / Math.max(1, allJobs.length)) * 100).toFixed(1)}%)`);

  const unresolved = Object.entries(map).filter(([, v]) => !v.provider).map(([k]) => k);
  console.log(`Companies with no board    : ${unresolved.length}`);
  if (unresolved.length) console.log(`  ${unresolved.join(', ')}`);

  console.log(`\n${bad === 0 ? 'PASS' : 'WARN'}: ${bad} structural issue(s)\n`);
  return bad;
}

/* ------------------------------------------------------------------ *
 * SPOTCHECK — independent ground truth: re-open the live posting page and
 * confirm the role really exists and the parsed experience is defensible.
 * This is the check that catches "the report says 2 years, the page says 8".
 * ------------------------------------------------------------------ */

async function spotcheck(n = 12) {
  const results = JSON.parse(fs.readFileSync(RAW_FILE, 'utf8'));
  const rows = [];
  for (const r of results) for (const job of r.jobs) rows.push({ company: r.company, parent: r.parent, job, cls: classify(job) });
  const seen = new Set();
  const matched = rows.filter((x) => x.cls.tier === 'A' || x.cls.tier === 'B')
    .sort((a, b) => b.cls.score - a.cls.score)
    .filter((x) => {
      const k = `${x.company}::${x.job.title.toLowerCase()}`;
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
  const sample = matched.slice(0, n);
  console.log(`\n=== SPOTCHECK: re-opening ${sample.length} live postings ===\n`);

  let ok = 0, bad = 0, unchecked = 0;
  const checked = await pool(sample, 4, async (x) => {
    const r = await req(x.job.url, { timeout: 30000, retries: 1 });
    if (!r.ok) return { x, verdict: 'UNREACHABLE', note: `HTTP ${r.status}` };
    const page = stripHtml(r.text);
    const ld = jsonLd(r.text);
    // Include the JSON-LD title/description: on Workday the visible body is
    // rendered client-side and the LD block is the only server-side evidence.
    const body = [ld && ld.title, ld && ld.description && stripHtml(ld.description),
                  (r.text.match(/<title>([^<]*)/i) || [])[1], page].filter(Boolean).join('\n');

    // Does the live page still show this role?
    const words = x.job.title.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 3);
    const titleSeen = words.length === 0 ||
      words.filter((w) => body.toLowerCase().includes(w)).length / words.length >= 0.6;

    // Does the live page contradict our experience finding?
    const live = extractExperience(body);
    const liveFloor = live.length
      ? Math.max(...[...new Map(live.map((v) => [v.line, v])).values()].map((v) => v.min)) : null;
    const contradiction = liveFloor !== null && liveFloor > 2.5 &&
      (x.cls.exp.min === null || x.cls.exp.min <= 2.5);

    // Workday / Jobvite / most modern boards render the posting client-side, so the
    // raw HTML is an empty shell. That is not evidence the role vanished — say so
    // rather than reporting a failure we cannot actually substantiate.
    if (!titleSeen && body.replace(/\s+/g, ' ').length < 2500) {
      return { x, verdict: 'UNVERIFIABLE', note: 'client-rendered page; no server HTML to check' };
    }
    if (!titleSeen) return { x, verdict: 'TITLE-GONE', note: 'title not found on live page' };
    if (contradiction) return { x, verdict: 'MISMATCH', note: `live page requires ${liveFloor}+ yrs` };
    return { x, verdict: 'OK', note: x.cls.exp.stated ? `${x.cls.exp.min} yrs confirmed` : 'no years stated on live page either' };
  });

  for (const c of checked) {
    if (!c) { unchecked++; continue; }
    if (c.verdict === 'OK') ok++;
    else if (c.verdict === 'UNREACHABLE' || c.verdict === 'UNVERIFIABLE') unchecked++;
    else bad++;
    console.log(`  ${c.verdict.padEnd(12)} ${c.x.company} | ${c.x.job.title.slice(0, 52)}`);
    console.log(`               ${c.note}`);
  }
  console.log(`\n  confirmed ${ok} | contradicted ${bad} | unreachable ${unchecked}`);
  if (bad) console.log('  -> FIX test.js: the classifier disagrees with the live page.');
  return bad;
}

/* ------------------------------------------------------------------ */

module.exports = {
  PROVIDERS, spotcheck, jsonLd, extractExperience, fitsTwoYears, classify, stripHtml, decodeEntities,
  SWE_TITLE, NON_ENG, SENIOR, JUNIOR, fetchAll, writeReport, verify, pool, req, getJson,
};

if (require.main === module) {
  (async () => {
    const arg = process.argv[2];
    if (arg === '--discover') return runDiscovery();
    if (arg === '--verify') return verify();
    if (arg === '--spotcheck') return spotcheck(Number(process.argv[3]) || 12);
    if (arg === '--report') return void writeReport(JSON.parse(fs.readFileSync(RAW_FILE, 'utf8')));
    const results = await fetchAll();
    writeReport(results);
    verify();
  })();
}
