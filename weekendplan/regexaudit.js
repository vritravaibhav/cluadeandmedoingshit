/*
 * regexaudit.js — find the `/\ba|b|c\b/` bug shape across the project.
 *
 * Last cycle a pattern written /\bmap|gps|location|track\b/ turned out to parse
 * as (\bmap)|(gps)|(location)|(track\b), so three of its four alternatives
 * matched anywhere inside a word. It reported "allocation" as maps/GPS,
 * "restaurant" as REST APIs and — worst — "javascript" as Java/Spring.
 *
 * That was found by accident, reading one output file. This looks for the same
 * shape everywhere, so the rest are found on purpose.
 *
 * The check: inside a regex literal, an alternation (`|`) at the TOP level
 * (not inside parentheses or a character class) combined with a `\b` anywhere
 * means at least one alternative is unanchored. Reported, not auto-fixed —
 * some are deliberate (`/\bai\b|\bml\b/` anchors each side individually).
 *
 *   node weekendplan/regexaudit.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = require('../engine/paths').ROOT;
const FILES = [
  'engine/test.js',
  'weekendplan/build.js',
  'weekendplan/render-scan.js',
  'weekendplan/verify-domains.js',
  'weekendplan_freelance/build.js',
  'weekendplan_freelance/proposals.js',
  'freelance/sources.js',
];

/* Pull regex literals out of source. Deliberately conservative: skip anything
 * that looks like a division or a comment, and require a plausible flag tail. */
function regexLiterals(src) {
  const out = [];
  const re = /\/((?:[^/\\\n[]|\\.|\[(?:[^\]\\]|\\.)*\])+)\/([gimsuy]*)/g;
  let m;
  while ((m = re.exec(src))) {
    const before = src.slice(Math.max(0, m.index - 40), m.index);
    // crude but effective: a regex literal here always follows one of these
    if (!/[=(,:[!&|?{;]\s*$|\breturn\s*$/.test(before)) continue;
    const line = src.slice(0, m.index).split('\n').length;
    out.push({ body: m[1], flags: m[2], line });
  }
  return out;
}

/** Is there a `|` at nesting depth 0, outside a character class? */
function topLevelAlternation(body) {
  let depth = 0;
  let inClass = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\') { i++; continue; }
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; continue; }
    if (c === '(') { depth++; continue; }
    if (c === ')') { depth--; continue; }
    if (c === '|' && depth === 0) return true;
  }
  return false;
}

/*
 * Every top-level alternative should carry its own boundary. If some do and
 * some do not, the author almost certainly meant the boundary to apply to all.
 */
function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let inClass = false;
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\') { cur += c + (body[i + 1] || ''); i++; continue; }
    if (inClass) { cur += c; if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; cur += c; continue; }
    if (c === '(') { depth++; cur += c; continue; }
    if (c === ')') { depth--; cur += c; continue; }
    if (c === '|' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

let flagged = 0;
for (const rel of FILES) {
  const f = path.join(ROOT, rel);
  if (!fs.existsSync(f)) continue;
  const src = fs.readFileSync(f, 'utf8');
  for (const { body, flags, line } of regexLiterals(src)) {
    if (!body.includes('\\b')) continue;
    if (!topLevelAlternation(body)) continue;
    const parts = splitTopLevel(body);
    const bounded = parts.map((p) => p.startsWith('\\b') || p.startsWith('^'));
    // All bounded, or none: consistent, so presumably intended.
    if (bounded.every(Boolean) || bounded.every((x) => !x)) continue;
    flagged++;
    console.log(`  ${rel}:${line}`);
    console.log(`      /${body.slice(0, 96)}${body.length > 96 ? '…' : ''}/${flags}`);
    console.log(`      ${parts.length} top-level alternatives, ${bounded.filter(Boolean).length} start with \\b — the rest are UNANCHORED`);
  }
}
console.log(flagged ? `\n${flagged} pattern(s) to review` : '\nNo mixed-anchoring alternations found.');
