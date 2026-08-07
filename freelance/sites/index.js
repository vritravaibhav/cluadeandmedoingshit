/*
 * sites/index.js — the registry for the one-file-per-site adapters.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * sources.js used to hold every adapter inline. That file is now the *core*:
 * it owns the shared helpers (get / strip / rec) and the nine original
 * adapters. Anything new lives in its own file in this directory, and this
 * file is what glues them back together.
 *
 * Think of it as component scanning in Spring: instead of listing every bean
 * by hand, we scan the package (this directory), load whatever is there, and
 * register the ones that satisfy the contract. Dropping a new `foo.js` into
 * sites/ is enough — no edit here, no edit in sources.js.
 *
 * THE CONTRACT an adapter file must satisfy (anything else is rejected):
 *
 *   module.exports = {
 *     name:     'braintrust',            // string, non-empty, unique
 *     kind:     'gig' | 'remote',        // 'gig' = real freelance marketplace
 *     homepage: 'https://...',           // informational only
 *     async fetch(opts) { ... }          // -> array of rec({...}), or null
 *   }
 *
 * and fetch() must return:
 *   an array  -> the source answered (possibly with zero postings today)
 *   null      -> the source itself FAILED; the runner reports it as down
 *
 * FAIL-SOFT IS THE WHOLE POINT
 * ----------------------------
 * A `require` runs arbitrary code at load time. A syntax error, a bad import,
 * or a throw at module scope in ONE adapter would, in a plain
 * `require('./arc'); require('./torre');` chain, take down the entire sweep
 * before a single HTTP request was made. So every load is individually
 * wrapped: a broken adapter is logged and skipped, and the other sources still
 * run. Losing one source is a bad day; losing all of them is a broken tool.
 */

const fs = require('node:fs');
const path = require('node:path');

/* Where the adapter files live — this very directory. Using __dirname (not a
 * relative path) means it does not matter what the current working directory
 * is when the sweep is launched. */
const DIR = __dirname;

/* Files in here that are NOT adapters and must never be loaded as one. */
const SKIP = new Set(['index.js']);

/* Log with a consistent prefix so loader problems are obvious in run.log and
 * can never be mistaken for a network/fetch problem. */
function warn(msg) {
  console.error(`sites/index.js: ${msg}`);
}

/*
 * Does this look like a usable adapter?
 *
 * Deliberately checked at load time rather than at fetch time. A source with a
 * typo'd export would otherwise fail in the middle of a long sweep, after the
 * user has already waited several minutes. Better to drop it up front and say
 * so.
 */
function isValidAdapter(mod) {
  if (!mod || typeof mod !== 'object') return 'export is not an object';
  if (typeof mod.name !== 'string' || !mod.name.trim()) return 'missing a non-empty string `name`';
  if (typeof mod.fetch !== 'function') return 'missing an async `fetch()` function';
  if (mod.kind !== 'gig' && mod.kind !== 'remote') {
    return `kind must be 'gig' or 'remote', got ${JSON.stringify(mod.kind)}`;
  }
  return null; // null == no complaint == valid
}

/*
 * Read the directory listing.
 *
 * Even this is wrapped: if the directory were deleted or unreadable, we want
 * an empty registry and a warning, not a crash that stops sources.js from
 * loading its nine working adapters.
 */
function listAdapterFiles() {
  let entries;
  try {
    entries = fs.readdirSync(DIR, { withFileTypes: true });
  } catch (e) {
    warn(`cannot read the sites/ directory — ${(e && e.message) || e}`);
    return [];
  }

  return entries
    .filter((d) => d.isFile())
    .map((d) => d.name)
    .filter((n) => n.endsWith('.js'))     // README.md, .json fixtures etc. are not adapters
    .filter((n) => !SKIP.has(n))
    .filter((n) => !n.startsWith('.'))    // editor swap files, .DS_Store-alikes
    .filter((n) => !/\.test\.js$/.test(n))
    .sort();                              // stable, alphabetical registration order
}

/*
 * Load them.
 *
 * ONE SUBTLETY WORTH KNOWING ABOUT (circular requires)
 * ----------------------------------------------------
 * Each adapter does `require('../sources.js')` to get the shared helpers, and
 * sources.js requires this file. That is a cycle. Node handles cycles by
 * handing back whatever the in-progress module has exported *so far*, so the
 * cycle is only safe because sources.js is careful about ORDER: it defines the
 * helpers and attaches them to module.exports BEFORE it requires this file.
 * By the time an adapter asks for `get`/`strip`/`rec`, they are already there.
 *
 * The one arrangement that cannot work is entering the program *through* an
 * adapter file (`node sites/arc.js`): arc.js would still be mid-load when this
 * loader reaches it, so its exports would still be empty. We detect exactly
 * that case below and say so plainly, rather than reporting a confusing
 * "missing fetch()".
 */
function loadAdapters() {
  const adapters = [];
  const seen = new Map(); // name -> file, to catch two files claiming one name

  for (const file of listAdapterFiles()) {
    const full = path.join(DIR, file);
    let mod;

    try {
      /* Is this module already on the stack, half-loaded? Only possible when a
       * site file was the program's entry point. require() would return a
       * still-empty exports object and we would blame the adapter for it. */
      const resolved = require.resolve(full);
      const cached = require.cache[resolved];
      if (cached && cached.loaded === false) {
        warn(
          `${file} is still loading (circular entry — did you run node on the ` +
            `adapter directly?); skipping it in the registry`
        );
        continue;
      }

      mod = require(full);
    } catch (e) {
      /* Syntax error, bad require, throw at module scope — all land here. Log
       * the file so it is obvious which one to fix, and carry on. */
      warn(`failed to load ${file} — ${(e && e.message) || e}`);
      continue;
    }

    const complaint = isValidAdapter(mod);
    if (complaint) {
      warn(`ignoring ${file} — ${complaint}`);
      continue;
    }

    /* Duplicate names would silently collide in the report (and in `--only`
     * filtering), so refuse the second one instead of shadowing. */
    const key = mod.name.trim().toLowerCase();
    if (seen.has(key)) {
      warn(`ignoring ${file} — name '${mod.name}' already registered by ${seen.get(key)}`);
      continue;
    }
    seen.set(key, file);

    adapters.push(mod);
  }

  return adapters;
}

/*
 * Exported as an ARRAY, the same shape sources.js already uses, so the runner
 * can concatenate the two without special-casing anything.
 *
 * Loaded once at require time and cached by Node, exactly like sources.js.
 */
module.exports = loadAdapters();
