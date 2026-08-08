#!/usr/bin/env node
/*
 * verify-domains.js — check that every company's domain still belongs to it.
 *
 * 25 of the 26 letter lists were authored from model knowledge and never
 * verified. When letter i finally was verified, the researcher found real rot:
 * Infogain now redirects to tenarai.com (relaunched under a new name),
 * Infrasoft -> kiya.ai, InfoStretch -> Apexon, Innoplexus -> partex.ai, several
 * domains lapsed and now serve unrelated sites, and several are parking pages.
 *
 * A wrong domain is not a harmless miss. The scanner tries 12 careers-URL
 * patterns against it and reads the homepage for career links, so a domain that
 * now belongs to someone else can feed another company's jobs into the report
 * under the wrong name — the same silent-poisoning failure as a guessed ATS
 * token, arrived at from the other direction.
 *
 * This fetches each domain, follows redirects, and classifies it:
 *   ok         final host matches the domain we hold (www/scheme differences ignored)
 *   redirect   resolves but lands on a DIFFERENT host — rebrand, acquisition, or rot
 *   parked     a domain-sale/parking page
 *   dead       DNS failure, connection refused, or a 4xx/5xx on the bare domain
 *   mismatch   resolves fine, but the page title shares nothing with the company name
 *
 * Only `dead` and `parked` are safe to act on mechanically. `redirect` needs a
 * human or an agent to judge (a redirect to a parent brand is fine; a redirect
 * to an unrelated company is not), so they are reported, never auto-changed.
 *
 *   node weekendplan/verify-domains.js                 # all letters
 *   node weekendplan/verify-domains.js --letters=a,b   # some
 *   node weekendplan/verify-domains.js --apply         # drop dead+parked
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.dirname(__dirname);
const ARGS = process.argv.slice(2);
const argVal = (k, d) => {
  const a = ARGS.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const LETTERS = (argVal('letters', 'abcdefghijklmnopqrstuvwxyz') || '').split(/[,]?/).filter((c) => /[a-z]/.test(c));
const APPLY = ARGS.includes('--apply');
const CONCURRENCY = parseInt(argVal('concurrency', '14'), 10);
const TIMEOUT = parseInt(argVal('timeout', '15000'), 10);
const OUT = path.join(__dirname, 'domain-report.txt');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const PARKED = /(hugedomains|domain (is )?for sale|buy this domain|godaddy\.com\/domainsearch|sedoparking|parkingcrew|afternic|dan\.com|namecheap.*parking|this domain (may be|is) for sale)/i;

const host = (u) => {
  try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
};
const bare = (s) => String(s || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').toLowerCase();

/* Tokens from the company name worth matching against a page title. Drop the
 * corporate-suffix noise that appears in every company on earth. */
const STOP = new Set([
  'technologies', 'technology', 'solutions', 'systems', 'software', 'labs', 'group', 'inc', 'ltd',
  'limited', 'private', 'pvt', 'corp', 'corporation', 'company', 'international', 'india', 'global',
  'services', 'consulting', 'digital', 'the', 'and', 'llp', 'co', 'plc', 'holdings', 'ventures',
]);
const tokens = (name) =>
  String(name || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOP.has(t));

/*
 * Only three signals actually prove a domain no longer belongs to the company.
 * A first version also flagged "fetch failed" as dead and "page title does not
 * contain the company name" as a mismatch. Calibrating against letter i — which
 * had just been verified by hand — showed both were wrong:
 *   - IBM, Illumina and Innominds all "failed to fetch". They are bot walls and
 *     TLS quirks, not dead domains. Deleting on that signal would have removed
 *     real companies.
 *   - ICICI Lombard ("General Insurance: Buy Health, Car, Bike…"), InMobi and
 *     IndiGo were all "mismatches" purely because their titles are marketing
 *     copy. Plenty of real sites never put their own name in <title>.
 * So: DNS is the authority on dead, a parking page is self-evident, and a
 * redirect only matters when the destination shares nothing with the company.
 */
const dns = require('dns').promises;

/*
 * Plenty of large companies publish NO A record at the apex — only on www.
 * fujitsu.com, dream11.com, denso.com and schaeffler.com all fail an apex
 * lookup while www.<domain> answers fine. A first pass called all 27 of them
 * "dead" for exactly this reason. Always try the www form before condemning
 * a domain.
 */
async function resolves(h) {
  const bare_ = h.replace(/^www\./, '');
  for (const cand of [bare_, `www.${bare_}`]) {
    try { await dns.lookup(cand); return true; } catch { /* try next */ }
    try { await dns.resolve(cand, 'A'); return true; } catch { /* try next */ }
    try { await dns.resolve(cand, 'CNAME'); return true; } catch { /* try next */ }
  }
  return false;
}

/** Does the redirect destination plausibly belong to the same company? */
function relatedHost(finalHost, site, name) {
  const a = bare(site).split('.')[0];
  const b = finalHost.split('.')[0];
  if (!a || !b) return true;
  // Shared root label: icicibank.com -> icici.bank.in, itron.com -> na.itron.com
  if (a.includes(b) || b.includes(a)) return true;
  // Destination carries a distinctive token of the company name.
  return tokens(name).some((t) => finalHost.includes(t));
}

async function probe(c) {
  const h = bare(c.site);
  const url = `https://${h}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: ac.signal });
    clearTimeout(timer);
    const finalHost = host(res.url);
    const body = res.ok ? (await res.text()).slice(0, 20000) : '';
    const title = (body.match(/<title[^>]*>([\s\S]{0,220}?)<\/title>/i) || [, ''])[1]
      .replace(/\s+/g, ' ')
      .trim();

    if (PARKED.test(title) || PARKED.test(body.slice(0, 4000))) {
      return { state: 'parked', finalHost, title, status: res.status };
    }
    // 404/410 on the bare domain is only meaningful if DNS also disowns it;
    // plenty of live sites 404 their apex and serve everything from a path.
    if ((res.status === 404 || res.status === 410) && !(await resolves(h))) {
      return { state: 'dead', finalHost, title, status: res.status };
    }
    if (finalHost && finalHost !== h && !relatedHost(finalHost, c.site, c.name)) {
      return { state: 'redirect', finalHost, title, status: res.status };
    }
    return { state: 'ok', finalHost, title, status: res.status };
  } catch (e) {
    clearTimeout(timer);
    // A transport failure is NOT evidence of rot — bot walls, TLS and rate
    // limits all land here. Ask DNS, which is the only authority on existence.
    if (await resolves(h)) {
      return { state: 'ok', finalHost: '', title: '', status: 0, note: 'unreachable but DNS resolves' };
    }
    return { state: 'dead', finalHost: '', title: '', status: 0, note: 'no DNS: ' + String(e.message || e).slice(0, 40) };
  }
}

async function main() {
  const items = [];
  for (const L of LETTERS) {
    const f = path.join(ROOT, L, 'companies.js');
    if (!fs.existsSync(f)) continue;
    require(f).forEach((c, i) => items.push({ L, i, c }));
  }
  console.log(`Verifying ${items.length} domains across ${LETTERS.length} letter(s), concurrency ${CONCURRENCY}\n`);

  const results = new Array(items.length);
  let idx = 0;
  let done = 0;
  const worker = async () => {
    while (idx < items.length) {
      const k = idx++;
      results[k] = await probe(items[k].c);
      done++;
      if (done % 250 === 0) console.log(`  ${done}/${items.length}`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const tally = {};
  const lines = [];
  results.forEach((r, k) => {
    tally[r.state] = (tally[r.state] || 0) + 1;
    if (r.state !== 'ok') {
      const it = items[k];
      lines.push(
        `${r.state.padEnd(9)} ${it.L}  ${it.c.name.slice(0, 34).padEnd(35)} ${bare(it.c.site).padEnd(30)}` +
          `${r.finalHost && r.finalHost !== bare(it.c.site) ? '-> ' + r.finalHost + '  ' : ''}` +
          `${r.title ? '"' + r.title.slice(0, 46) + '"' : r.note || ''}`,
      );
    }
  });

  console.log('\n' + Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${String(v).padStart(5)}  ${k}`).join('\n'));
  fs.writeFileSync(OUT, lines.sort().join('\n') + '\n');
  console.log(`\nWrote ${path.relative(ROOT, OUT)} (${lines.length} rows needing attention)`);

  if (!APPLY) {
    console.log('\nRe-run with --apply to drop the dead and parked entries.');
    return;
  }

  // Only the unambiguous ones. Redirects and mismatches need judgement.
  const drop = new Set();
  results.forEach((r, k) => {
    if (r.state === 'dead' || r.state === 'parked') drop.add(`${items[k].L}:${items[k].i}`);
  });
  let removed = 0;
  for (const L of LETTERS) {
    const f = path.join(ROOT, L, 'companies.js');
    if (!fs.existsSync(f)) continue;
    const arr = require(f);
    const kept = arr.filter((_, i) => !drop.has(`${L}:${i}`));
    if (kept.length !== arr.length) {
      removed += arr.length - kept.length;
      fs.writeFileSync(f, 'module.exports=' + JSON.stringify(kept, null, 1) + ';\n');
    }
  }
  console.log(`\nRemoved ${removed} dead/parked entries.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
