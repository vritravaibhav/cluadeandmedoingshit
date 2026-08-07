#!/usr/bin/env node
/*
 * probe.js — helper used while building companies.js.
 *
 * Guessing an ATS token is cheap; guessing WRONG is expensive, because test.js
 * then silently falls back to scraping headings and reports 4 junk "jobs" for a
 * company that actually has 127 open roles. So: for each candidate token, ask
 * the board who it belongs to and how many jobs it has, and print the answer.
 *
 *   node probe.js gh wiz wizinc wizio        # greenhouse tokens
 *   node probe.js lever wattpad
 *   node probe.js ashby wallarm
 *   node probe.js page https://x.com/careers # what ATS does this page embed?
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function j(url) {
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json,*/*' }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) return { status: r.status };
    return { status: r.status, data: await r.json() };
  } catch (e) {
    return { err: e.message };
  }
}

const KIND = {
  async gh(t) {
    const meta = await j(`https://boards-api.greenhouse.io/v1/boards/${t}`);
    if (!meta.data) return `x  (${meta.status || meta.err})`;
    const jobs = await j(`https://boards-api.greenhouse.io/v1/boards/${t}/jobs`);
    return `OK  "${meta.data.name}"  ${jobs.data ? jobs.data.jobs.length : '?'} jobs`;
  },
  async lever(t) {
    const r = await j(`https://api.lever.co/v0/postings/${t}?mode=json`);
    if (!Array.isArray(r.data)) return `x  (${r.status || r.err})`;
    return `OK  ${r.data.length} jobs   e.g. ${(r.data[0] || {}).text || '-'}`;
  },
  async ashby(t) {
    const r = await j(`https://api.ashbyhq.com/posting-api/job-board/${t}?includeCompensation=true`);
    if (!r.data || !r.data.jobs) return `x  (${r.status || r.err})`;
    return `OK  ${r.data.jobs.length} jobs   e.g. ${(r.data.jobs[0] || {}).title || '-'}`;
  },
  async sr(t) {
    const r = await j(`https://api.smartrecruiters.com/v1/companies/${t}/postings?limit=100`);
    if (!r.data || !r.data.content) return `x  (${r.status || r.err})`;
    return `OK  ${r.data.totalFound} jobs   e.g. ${(r.data.content[0] || {}).name || '-'}`;
  },
  async workable(t) {
    const r = await j(`https://apply.workable.com/api/v1/widget/accounts/${t}?details=true`);
    if (!r.data || !r.data.jobs) return `x  (${r.status || r.err})`;
    return `OK  "${r.data.name || ''}"  ${r.data.jobs.length} jobs`;
  },
  async page(url) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(25000) });
      const h = await r.text();
      const hits = new Set();
      for (const re of [
        /(?:boards|job-boards)\.greenhouse\.io\/(?:embed\/job_(?:board|app)(?:\/js)?\?for=)?([a-zA-Z0-9_-]+)/g,
        /boards-api\.greenhouse\.io\/v1\/boards\/([a-zA-Z0-9_-]+)/g,
        /jobs\.(?:eu\.)?lever\.co\/([a-zA-Z0-9_-]+)/g,
        /jobs\.ashbyhq\.com\/([a-zA-Z0-9_.-]+)/g,
        /careers\.smartrecruiters\.com\/([a-zA-Z0-9_-]+)/g,
        /apply\.workable\.com\/([a-zA-Z0-9_-]+)/g,
        /([a-zA-Z0-9_-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-zA-Z-]{2,5}\/)?([a-zA-Z0-9_-]+)/g,
        /([a-zA-Z0-9_-]+)\.darwinbox\.(?:in|com)/g,
        /([a-zA-Z0-9_-]+)\.zohorecruit\.(?:com|in)/g,
        /([a-zA-Z0-9_-]+)\.keka\.com/g,
        /([a-zA-Z0-9_-]+)\.freshteam\.com/g,
        /([a-zA-Z0-9_-]+)\.icims\.com/g,
        /jobs\.jobvite\.com\/([a-zA-Z0-9_-]+)/g,
        /([a-zA-Z0-9_-]+)\.recruitee\.com/g,
        /phenompeople|ph-cdn\.com/g,
      ]) {
        let m;
        while ((m = re.exec(h))) hits.add(m[0]);
      }
      return `${r.status} ${r.url}\n      ${[...hits].slice(0, 12).join('\n      ') || '(no ATS fingerprint found)'}`;
    } catch (e) {
      return `ERR ${e.message}`;
    }
  },
};

(async () => {
  const [kind, ...toks] = process.argv.slice(2);
  const fn = KIND[kind];
  if (!fn) {
    console.error('usage: node probe.js <gh|lever|ashby|sr|workable|page> <token...>');
    process.exit(1);
  }
  for (const t of toks) console.log(`  ${kind.padEnd(9)} ${t.padEnd(34)} ${await fn(t)}`);
})();
