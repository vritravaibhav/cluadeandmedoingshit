/*
 * paths.js — the one place that knows where things live.
 *
 * The layout used to be 26 single-letter folders and a dozen loose scripts at
 * the repo root, with every script hard-coding path.join(ROOT, letter, ...).
 * Moving anything meant editing six files and finding out what broke by
 * running it. Everything resolves through here now, so the next reshuffle is
 * one edit.
 *
 *   repo/
 *     engine/                 the scanner + application-pack generator
 *     data/<letter>/          companies.js and results.json, one dir per letter
 *     weekendplan/            job folders, packs, build + QA scripts
 *     weekendplan_freelance/  bid list and proposals
 *     freelance/              the freelance sweep and its site adapters
 *     autofill/               browser extension + bridge
 */

const path = require('path');

const ROOT = path.dirname(__dirname);

module.exports = {
  ROOT,
  ENGINE: __dirname,
  DATA: path.join(ROOT, 'data'),
  PLAN: path.join(ROOT, 'weekendplan'),
  FREELANCE_PLAN: path.join(ROOT, 'weekendplan_freelance'),
  FREELANCE: path.join(ROOT, 'freelance'),

  LETTERS: 'abcdefghijklmnopqrstuvwxyz'.split(''),

  /** data/<letter> — where a letter's companies.js and results.json live. */
  letterDir: (L) => path.join(ROOT, 'data', L),
  /** The scanner, which run-letters.sh copies into each letter dir. */
  scanner: () => path.join(__dirname, 'test.js'),
};
