#!/usr/bin/env node
/*
 * crawl.js — read Instahyre's ENTIRE India catalogue, a slice at a time.
 *
 * Why this exists rather than more of test.js
 * ------------------------------------------
 * test.js pulls per skill, which double-fetches (a Java+Spring role comes back
 * under both) and trips the 429 limiter fast — it reached maybe 30% of the
 * catalogue. The unfiltered feed paginates cleanly to ~13,900, so walking it
 * once end to end IS 100% coverage, and every role gets classified locally.
 *
 * It is built to be interrupted. Each invocation does a bounded number of
 * pages, writes its position to crawl-state.json, and exits. Run it again — by
 * hand, from cron, whenever — and it picks up at the exact offset it stopped
 * at. Nothing is lost to a kill, a rate-limit, or a closed laptop, and it burns
 * no model tokens at all because no model is involved.
 *
 *   node crawl.js                     # one budgeted slice (default 120 pages)
 *   node crawl.js --budget=400        # a whole pass in one go
 *   node crawl.js --push              # commit + push after the pass completes
 *   node crawl.js --status            # where am I
 *   node crawl.js --reset             # start a fresh pass
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = __dirname;
const STATE = path.join(DIR, 'crawl-state.json');
const STORE = path.join(DIR, 'store.json');
const LOG = path.join(DIR, 'crawl.log');

const ARGS = process.argv.slice(2);
const argVal = (k, d) => {
  const a = ARGS.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const BUDGET = parseInt(argVal('budget', '120'), 10); // pages per invocation
const PACE = parseInt(argVal('pace', '1300'), 10); // ms between requests
const PUSH = ARGS.includes('--push');

const PAGE = 35; // the API's real page size, whatever `limit` says
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const log = (m) => {
  const line = `${now().slice(0, 19)}  ${m}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch {}
};

const readJson = (f, d) => {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; }
};
const writeJson = (f, o) => {
  // write via a temp file: a kill mid-write must not corrupt the checkpoint
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(o));
  fs.renameSync(tmp, f);
};

async function getPage(offset) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 25000);
    try {
      const r = await fetch(
        `https://www.instahyre.com/api/v1/job_search?limit=100&offset=${offset}`,
        { headers: { 'user-agent': UA, accept: 'application/json' }, signal: c.signal }
      );
      if (r.status === 429) {
        clearTimeout(t);
        const wait = 5000 * (attempt + 1);
        log(`  429 at offset ${offset} — backing off ${wait / 1000}s`);
        await sleep(wait);
        continue;
      }
      // 400 at the tail means we walked past the end of the list
      if (r.status === 400) { clearTimeout(t); return { end: true }; }
      if (!r.ok) { clearTimeout(t); return { error: r.status }; }
      return { data: await r.json() };
    } catch (e) {
      await sleep(2000);
    } finally {
      clearTimeout(t);
    }
  }
  return { throttled: true };
}

const strip = (s = '') => String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

function normalise(r) {
  return {
    id: r.id,
    title: strip(r.title),
    company: strip((r.employer && r.employer.company_name) || ''),
    location: [].concat(r.locations || []).join(', '),
    skills: [].concat(r.keywords || []).map(strip).filter(Boolean),
    url: r.public_url || '',
    source: 'instahyre',
    seenAt: now().slice(0, 10),
  };
}

function gitPush(msg) {
  const root = path.resolve(DIR, '..');
  // plain git — it uses the same credentials as the shell, so whatever works
  // interactively works here. The timeout only stops a scheduled tick hanging
  // forever if the keychain ever does put up a prompt.
  const run = (a, ms) =>
    execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: ms });

  // Commit and push are separate concerns: committing is local and always
  // works, pushing needs credentials that cron may not have. Commit first so
  // progress is never lost, then attempt the push — a failure just means the
  // commits go out on a later tick.
  let staged = '';
  try {
    run(['add', 'india'], 20000);
    staged = run(['diff', '--cached', '--name-only'], 20000).trim();
    if (!staged) { log('  git: nothing to commit'); return; }
    run(['commit', '-m', msg], 20000);
    log(`  git: committed ${staged.split('\n').length} file(s)`);
  } catch (e) {
    log(`  git: commit failed — ${firstLine(e)}`);
    return;
  }
  try {
    run(['push', 'origin', 'HEAD'], 45000);
    log('  git: pushed');
  } catch (e) {
    const n = countUnpushed(run);
    log(`  git: push failed (${firstLine(e)}) — ${n} commit(s) queued locally, will retry next tick`);
  }
}

const firstLine = (e) =>
  String((e && (e.stderr || e.message)) || '').trim().split('\n')[0].slice(0, 110) || 'timed out';

function countUnpushed(run) {
  try { return run(['rev-list', '--count', 'origin/main..HEAD'], 10000).trim(); } catch { return '?'; }
}

/* The lock lives HERE, not only in watch.sh.
 *
 * watch.sh locking was not enough: a hand-run `node crawl.js` does not go
 * through it, so a scheduled tick and a manual run overlapped, each holding a
 * stale in-memory copy of the checkpoint, and the one that finished last wrote
 * it back — the crawl visibly went backwards from offset 9345 to 8715 and ~600
 * stored roles were dropped. Any two invocations must serialise, however they
 * were started. mkdir is atomic on macOS; flock is not available. */
const LOCK = path.join(DIR, '.crawl.lock');

function acquireLock() {
  try {
    fs.mkdirSync(LOCK);
  } catch {
    // break a lock whose owner died, but only once it is clearly stale
    let age = Infinity;
    try { age = Date.now() - fs.statSync(LOCK).mtimeMs; } catch {}
    if (age > 30 * 60 * 1000) {
      log('  breaking stale lock (>30 min old)');
      try { fs.rmSync(LOCK, { recursive: true, force: true }); fs.mkdirSync(LOCK); } catch { return false; }
      return true;
    }
    return false;
  }
  return true;
}
const releaseLock = () => { try { fs.rmSync(LOCK, { recursive: true, force: true }); } catch {} };

(async () => {
  // --status is read-only, so it must not block on (or steal) the lock
  const readOnly = ARGS.includes('--status');
  if (!readOnly) {
    if (!acquireLock()) {
      log('another crawl is running — exiting so the checkpoint is not clobbered');
      return;
    }
    for (const sig of ['exit', 'SIGINT', 'SIGTERM']) process.on(sig, releaseLock);
  }

  let state = readJson(STATE, { offset: 0, pass: 1, total: null, startedAt: now(), pagesDone: 0 });
  const store = readJson(STORE, {});

  /* Per-request backoff is not enough on its own. When the source puts us in a
   * long block, a scheduler firing every 15 minutes spends ~75s of retries per
   * tick achieving nothing, and steady traffic against a blocked endpoint is
   * exactly what lengthens the block. So remember the block across runs and sit
   * out until it plausibly expires, doubling the wait each time we find it is
   * still there (capped at an hour). */
  if (!readOnly && state.cooldownUntil && Date.now() < Date.parse(state.cooldownUntil)) {
    const mins = Math.ceil((Date.parse(state.cooldownUntil) - Date.now()) / 60000);
    log(`source is rate-limiting; cooling down for another ~${mins} min (offset ${state.offset})`);
    releaseLock();
    return;
  }

  if (ARGS.includes('--reset')) {
    state = { offset: 0, pass: (state.pass || 0) + 1, total: null, startedAt: now(), pagesDone: 0 };
    writeJson(STATE, state);
    log(`reset — starting pass ${state.pass}`);
  }

  if (ARGS.includes('--status')) {
    const pct = state.total ? ((state.offset / state.total) * 100).toFixed(1) : '?';
    console.log(`pass ${state.pass} | offset ${state.offset}/${state.total ?? '?'} (${pct}%) | stored ${Object.keys(store).length} roles`);
    console.log(`last update ${state.updatedAt || state.startedAt}`);
    return;
  }

  log(`pass ${state.pass}: resuming at offset ${state.offset} (${Object.keys(store).length} roles stored)`);

  let added = 0;
  let pages = 0;
  let stopped = '';

  while (pages < BUDGET) {
    const res = await getPage(state.offset);

    if (res.end) { stopped = 'reached end of catalogue'; break; }
    if (res.throttled) { stopped = 'rate-limited — will resume next run'; break; }
    if (res.error) { stopped = `http ${res.error} — will resume next run`; break; }

    const j = res.data;
    if (j && j.meta && j.meta.total_count) state.total = j.meta.total_count;
    const rows = (j && j.objects) || [];
    if (!rows.length) { stopped = 'empty page — end of list'; break; }

    for (const r of rows) {
      if (!r || !r.id) continue;
      if (!store[r.id]) added++;
      store[r.id] = normalise(r); // refresh: listings change
    }

    state.offset += PAGE;
    state.pagesDone = (state.pagesDone || 0) + 1;
    state.updatedAt = now();
    pages++;

    if (pages % 20 === 0) {
      writeJson(STORE, store);
      writeJson(STATE, state);
      const pct = state.total ? ((state.offset / state.total) * 100).toFixed(1) : '?';
      log(`  ${state.offset}/${state.total ?? '?'} (${pct}%) — ${Object.keys(store).length} stored, +${added} new`);
    }
    await sleep(PACE);
  }

  writeJson(STORE, store);

  const complete = /end of catalogue|end of list/.test(stopped);
  if (complete) {
    log(`pass ${state.pass} COMPLETE — ${Object.keys(store).length} roles, +${added} new this run`);
    state = { offset: 0, pass: state.pass + 1, total: state.total, startedAt: now(), pagesDone: 0, lastCompletedAt: now() };
  } else {
    const pct = state.total ? ((state.offset / state.total) * 100).toFixed(1) : '?';
    log(`paused at ${state.offset}/${state.total ?? '?'} (${pct}%) — ${stopped || 'page budget spent'}; +${added} new`);

    if (/rate-limited/.test(stopped)) {
      // double the wait each consecutive block, 10 min → 1 h; any successful
      // page clears it, so a one-off 429 does not impose a long silence
      const prev = state.cooldownMin || 0;
      const next = Math.min(60, prev ? prev * 2 : 10);
      state.cooldownMin = next;
      state.cooldownUntil = new Date(Date.now() + next * 60000).toISOString();
      log(`  backing off for ${next} min before the next attempt`);
    }
  }
  if (added > 0) { delete state.cooldownMin; delete state.cooldownUntil; }
  writeJson(STATE, state);

  // rebuild the human-readable report from the accumulated store
  try {
    require('./report.js').build();
    log(`  report rebuilt from ${Object.keys(store).length} roles`);
  } catch (e) {
    log(`  report skipped: ${String(e.message).slice(0, 90)}`);
  }

  // Only commit when the run actually changed something — a cron every few
  // minutes would otherwise fill the history with empty "no new roles" commits.
  if (PUSH && (added > 0 || complete)) {
    const pct = state.total ? ((state.offset / state.total) * 100).toFixed(0) : '?';
    gitPush(
      complete
        ? `india: pass ${state.pass - 1} complete — ${Object.keys(store).length} roles`
        : `india: +${added} roles (${Object.keys(store).length} total, ${pct}% of pass ${state.pass})`
    );
  } else if (PUSH) {
    log('  git: no new roles this run — not committing');
  }
})();
