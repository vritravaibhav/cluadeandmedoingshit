/*
 * sources.js — India salaried roles, without the alphabet.
 *
 * The letter folders (w/, x/, y/) sweep a hand-written list of companies whose
 * name starts with one letter. That is why a role like Oxane Partners' Senior
 * Software Engineer never appeared: the company starts with O. Across all 125
 * "W" companies only 8 India roles were Java/Flutter at the ~2-year mark.
 *
 * This inverts it: search by STACK across every Indian employer at once.
 *
 *   instahyre  — 13,951 live India tech roles, open JSON API, filterable by
 *                skill (Java 3,517 · Spring Boot 1,464 · Flutter 145 ·
 *                Firebase 123). This is the volume.
 *   remote     — the boards already proven in ../freelance/sources.js, kept for
 *                India-workable remote roles that Instahyre does not carry.
 *
 * Instahyre's API gives title, company, location and skill tags but NO
 * description and NO experience field (job pages are 403 to non-browsers), so
 * seniority is judged from the title and the stack from the tags. That is a
 * real limit of the source, not an oversight — the report says so.
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Instahyre throttles hard: a burst of requests starts returning 429 with an
 * empty body. Returning null for that is dangerous — the caller cannot tell
 * "this skill has no jobs" from "I was throttled", and an earlier run silently
 * recorded 0 for seven skills that actually have thousands. So report the
 * status, and back off rather than hammering. */
async function getJson(url, timeout = 25000) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeout);
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: c.signal });
      if (r.status === 429) {
        clearTimeout(t);
        await sleep(4000 * (attempt + 1)); // 4s, 8s, 12s
        continue;
      }
      if (!r.ok) return { status: r.status, data: null };
      return { status: 200, data: await r.json() };
    } catch (e) {
      await sleep(1500);
    } finally {
      clearTimeout(t);
    }
  }
  return { status: 429, data: null, throttled: true };
}

const strip = (s = '') =>
  String(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();

/* The skills Instahyre actually indexes, ordered by relevance to the brief.
 * `weight` feeds scoring: 1 = the brief's priority stack. */
const SKILLS = [
  { q: 'Java', weight: 1 },
  { q: 'Spring Boot', weight: 1 },
  { q: 'Flutter', weight: 1 },
  { q: 'Firebase', weight: 1 },
  { q: 'Dart', weight: 1 },
  { q: 'Hibernate', weight: 1 },
  { q: 'Microservices', weight: 2 },
  { q: 'Spring', weight: 1 },
  { q: 'Android', weight: 2 },
  { q: 'Kotlin', weight: 2 },
  { q: 'React Native', weight: 2 },
  { q: 'Node.js', weight: 3 },
  { q: 'REST API', weight: 2 },
  { q: 'MySQL', weight: 3 },
];

const instahyre = {
  name: 'instahyre',
  kind: 'india-fulltime',
  /* Paginates 35 at a time regardless of the limit you ask for. `maxPages`
   * bounds the pull per skill — the whole Java set is 100+ requests. */
  async fetch({ maxPages = 8, onProgress, paceMs = 1200 } = {}) {
    const out = [];
    const seen = new Set();
    const throttled = [];
    for (const s of SKILLS) {
      let got = 0;
      let hitLimit = false;
      let reported = null;
      for (let page = 0; page < maxPages; page++) {
        const url =
          'https://www.instahyre.com/api/v1/job_search?limit=100&offset=' +
          page * 35 +
          '&skills=' +
          encodeURIComponent(s.q);
        const res = await getJson(url);
        await sleep(paceMs); // stay under the throttle rather than trip it
        if (res.throttled) { hitLimit = true; break; }
        const j = res.data;
        if (j && j.meta && reported === null) reported = j.meta.total_count;
        const rows = (j && j.objects) || [];
        if (!rows.length) break;
        for (const r of rows) {
          if (!r.id || seen.has(r.id)) continue;
          seen.add(r.id);
          out.push({
            id: r.id,
            title: strip(r.title),
            company: strip((r.employer && r.employer.company_name) || ''),
            location: [].concat(r.locations || []).join(', '),
            skills: [].concat(r.keywords || []).map(strip).filter(Boolean),
            url: r.public_url || '',
            source: 'instahyre',
            viaSkill: s.q,
            skillWeight: s.weight,
            text: '', // API carries no description
          });
          got++;
        }
        if (rows.length < 35) break;
      }
      if (hitLimit) throttled.push(s.q);
      if (onProgress) onProgress(s.q, got, out.length, { available: reported, throttled: hitLimit });
    }
    out.throttled = throttled; // so the report can admit what it could not read
    return out;
  },
};

/* Remote boards, reused wholesale from the freelance sweep. Those adapters are
 * already normalised and defensive about unstable field types. */
const remote = {
  name: 'remote-boards',
  kind: 'remote',
  async fetch() {
    let SRC;
    try {
      SRC = require('../freelance/sources.js');
    } catch {
      return [];
    }
    const out = [];
    for (const s of SRC) {
      if (s.kind !== 'remote') continue;
      try {
        const rows = s.perQuery
          ? (await Promise.all(['java', 'flutter', 'spring boot', 'firebase'].map((q) => s.fetch(q)))).flat()
          : await s.fetch();
        for (const r of rows || []) {
          if (!r || !r.title) continue;
          out.push({
            id: r.url || `${r.title}|${r.company}`,
            title: r.title,
            company: r.company,
            location: r.location,
            skills: r.skills || [],
            url: r.url,
            source: s.name,
            viaSkill: '',
            skillWeight: 3,
            text: r.text || '',
          });
        }
      } catch {
        /* one bad board must not sink the run */
      }
    }
    return out;
  },
};

module.exports = { instahyre, remote, SKILLS, strip };
