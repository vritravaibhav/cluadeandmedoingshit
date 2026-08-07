#!/usr/bin/env node
/*
 * apply-fixes.js — patch companies.js from a verified fix list.
 *
 *   node apply-fixes.js fixes.json [--dry]
 *
 * fixes.json is an array of:
 *   { company, careersUrl?, atsType?, atsToken?, atsExtra?, verified }
 *
 * Only entries with verified === true are applied — the whole point of the
 * hunt/verify split is that an unverified board is exactly the failure mode
 * that once reported a US company's 16 jobs under an Indian firm.
 *
 * Rewrites each company's line in place so the file keeps its hand-aligned
 * formatting and its comments.
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'companies.js');
const DRY = process.argv.includes('--dry');
const src = process.argv[2];
if (!src) {
  console.error('usage: node apply-fixes.js <fixes.json> [--dry]');
  process.exit(1);
}

const fixes = JSON.parse(fs.readFileSync(src, 'utf8'));
let text = fs.readFileSync(FILE, 'utf8');
const before = text;

const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

function atsLiteral(f) {
  if (!f.atsType || !f.atsToken) return null;
  const extra = {};
  if (f.atsExtra) {
    try {
      Object.assign(extra, typeof f.atsExtra === 'string' ? JSON.parse(f.atsExtra) : f.atsExtra);
    } catch {
      /* a malformed extra should not lose the token */
    }
  }
  const parts = [`type: '${esc(f.atsType)}'`, `token: '${esc(f.atsToken)}'`];
  for (const [k, v] of Object.entries(extra)) {
    if (v == null || v === '' || k === 'type' || k === 'token') continue;
    parts.push(`${k}: '${esc(v)}'`);
  }
  return `ats: { ${parts.join(', ')} }`;
}

const applied = [];
const skipped = [];

for (const f of fixes) {
  if (f.verified !== true) {
    skipped.push(`${f.company} — not verified (${f.verifyReason || f.outcome || 'no verdict'})`);
    continue;
  }
  // find the object line for this company
  const needle = `name: '${esc(f.company)}',`;
  const i = text.indexOf(needle);
  if (i === -1) {
    skipped.push(`${f.company} — no line found in companies.js`);
    continue;
  }
  const start = text.lastIndexOf('\n', i) + 1;
  const end = text.indexOf('\n', i);
  let line = text.slice(start, end);
  const original = line;

  if (f.careersUrl) {
    if (/careers: '[^']*'/.test(line)) line = line.replace(/careers: '[^']*'/, `careers: '${esc(f.careersUrl)}'`);
    else line = line.replace(/(\s*)\},\s*$/, `, careers: '${esc(f.careersUrl)}' },`);
  }

  const ats = atsLiteral(f);
  if (ats) {
    if (/ats: \{[^}]*\}/.test(line)) line = line.replace(/ats: \{[^}]*\}/, ats);
    else line = line.replace(/\s*\},\s*$/, `, ${ats} },`);
  }

  if (line === original) {
    skipped.push(`${f.company} — nothing to change`);
    continue;
  }
  text = text.slice(0, start) + line + text.slice(end);
  applied.push(`${f.company}  ->  ${f.atsType || 'url only'}${f.atsToken ? ':' + f.atsToken : ''}${f.jobCountSeen != null ? `  (${f.jobCountSeen} jobs seen)` : ''}`);
}

console.log(`APPLIED (${applied.length}):`);
applied.forEach((a) => console.log('  ' + a));
console.log(`\nSKIPPED (${skipped.length}):`);
skipped.forEach((s) => console.log('  ' + s));

if (DRY) {
  console.log('\n--dry: companies.js not written');
} else if (text !== before) {
  fs.writeFileSync(FILE, text);
  // fail loudly rather than leave a file that will not load
  try {
    delete require.cache[require.resolve(FILE)];
    const list = require(FILE);
    console.log(`\nWrote companies.js — still parses, ${list.length} companies`);
  } catch (e) {
    fs.writeFileSync(FILE, before);
    console.error(`\nREVERTED: patched file did not parse — ${e.message}`);
    process.exit(1);
  }
} else {
  console.log('\nNo changes.');
}
