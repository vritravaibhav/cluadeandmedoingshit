/*
 * chat.js — the little "teach the extension" chat box.
 *
 * WHAT THIS PAGE IS FOR
 *   You type a fact in ordinary English:
 *
 *       "my address changed to Pune"
 *       "now I have 3 years of experience"
 *       "my notice period is 60 days now"
 *       "I'm open to relocating to Dubai"
 *
 *   ...and your stored profile is updated so every future form fill uses the new
 *   fact. Nothing is written until you look at the proposed change and press
 *   Apply.
 *
 * WHERE THE WORK HAPPENS (important)
 *   This file NEVER talks to the AI bridge. It cannot: every fetch in this
 *   extension lives in background.js (the MV3 service worker), because a page
 *   inherits the host page's CSP and Greenhouse / Workday block localhost
 *   requests. So the flow is:
 *
 *       chat.js  --{ type: 'CHAT_UPDATE_PROFILE', text }-->  background.js
 *       chat.js  <--{ ok, patch, summary, error }---------  background.js
 *
 *   background.js is the only thing that knows the bridge exists.
 *
 * WHAT COMES BACK
 *   ok      Boolean  false means the bridge was unreachable or answered badly
 *   patch   Object   ONLY the parts of the profile that should change, in the
 *                    same nested shape as the profile itself, e.g.
 *                        { personal: { city: 'Pune' }, yearsOfExperience: 3 }
 *   summary String   one plain sentence: what the model thinks you said
 *   error   String   the reason, when ok is false
 *
 * STORAGE KEYS THIS FILE USES (all chrome.storage.local, so they survive a
 * browser restart AND a device restart — never sessionStorage, never an
 * in-memory cache as the source of truth):
 *
 *   'profile'         Object  the live profile. Same key options.js edits.
 *   'profileHistory'  Array   up to 10 snapshots of the profile taken JUST
 *                             BEFORE each Apply, oldest first. Undo pops the
 *                             last one. Shape of one entry:
 *                                 { at: Number, text: String, profile: Object }
 *   'chatTranscript'  Array   the visible conversation, so re-opening this page
 *                             does not look like amnesia. Shape of one entry:
 *                                 { role, text, lines, note, at }
 *
 * MENTAL MODEL FOR A SPRING DEVELOPER
 *   Think of this page as a thin controller. It POSTs a command to a service
 *   (the worker), gets a DTO back, renders it, and asks for confirmation before
 *   committing anything to the "database" (chrome.storage.local).
 */

/* The same defensive namespace line every file in this extension starts with.
 * lib/profile.js has already created AF by the time this runs; this only
 * guarantees the variable exists even if that script failed to load. */
var AF = (globalThis.AF = globalThis.AF || {});

/* A place to hang the handful of pure helper functions written here, so they can
 * be poked at from the DevTools console (AF.chat.deepMerge(...)) and, later,
 * reused or unit-tested. Everything else in this file is page wiring. */
AF.chat = AF.chat || {};


/* ========================================================================= *
 * 1. CONSTANTS
 * ========================================================================= */

/* Storage keys, written down once so a typo cannot drift between functions. */
var KEY_PROFILE    = 'profile';
var KEY_HISTORY    = 'profileHistory';
var KEY_TRANSCRIPT = 'chatTranscript';

/* How many pre-change profile snapshots to keep for Undo. The spec is 10. */
var MAX_HISTORY = 10;

/* How many chat messages to remember. Purely cosmetic — old messages scrolling
 * off does not lose any profile data. */
var MAX_TRANSCRIPT = 60;

/* Values longer than this are shortened in the diff so one enormous cover
 * letter cannot push the "->" off the screen. The FULL value is still what gets
 * applied; this only affects what is drawn. */
var VALUE_PREVIEW_CHARS = 160;

/* Object keys that must never be written by a patch. A model that hallucinated
 * "__proto__" as a profile key could otherwise corrupt every object in the page
 * (prototype pollution). Cheap to block, so block it. */
var FORBIDDEN_KEYS = ['__proto__', 'prototype', 'constructor'];


/* ========================================================================= *
 * 2. PAGE ELEMENTS  (grabbed once, up front)
 * ========================================================================= */

var elTranscript  = document.getElementById('transcript');
var elChips       = document.getElementById('chips');
var elInput       = document.getElementById('input');
var elBtnSend     = document.getElementById('btnSend');
var elBtnUndo     = document.getElementById('btnUndo');
var elStatus      = document.getElementById('status');
var elLearned     = document.getElementById('learned');
var elLearnedList = document.getElementById('learnedList');


/* ========================================================================= *
 * 3. PAGE STATE
 * -------------------------------------------------------------------------
 * NOTE: none of this is a source of truth. It is a mirror of what is already
 * in chrome.storage.local, kept only so the page does not have to re-read
 * storage on every keystroke. If this page is closed and re-opened, everything
 * below is rebuilt from storage.
 * ========================================================================= */

/* Mirror of the 'chatTranscript' array. */
var transcriptEntries = [];

/* The ONE change currently awaiting Apply / Discard, or null.
 * Shape: { bubble: Element, actions: Element, patch: Object, text: String }
 * Only one may be pending at a time — see supersedePending(). */
var pendingCard = null;

/* True while a CHAT_UPDATE_PROFILE round trip is in flight, so Send cannot be
 * pressed twice. */
var busy = false;


/* ========================================================================= *
 * 4. TINY GENERAL HELPERS
 * ========================================================================= */

/**
 * "Is this a plain object?" — i.e. something to merge INTO, as opposed to an
 * array, null, or a primitive.
 *
 * typeof null === 'object' in JavaScript (a famous wart), hence the explicit
 * null check.
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A deep copy of any pure-data value, via JSON round-tripping.
 *
 * Safe here because profiles and patches are pure data — no functions, no
 * Dates, no cycles. Used so the page can never hand out a reference to an
 * object that something else might mutate later.
 */
function deepCopy(value) {
  if (value === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    /* Cyclic or otherwise unserialisable. Nothing in this extension should ever
     * get here, but returning undefined beats throwing on a settings page. */
    return undefined;
  }
}

/**
 * Are two pure-data values the same? Used to spot "the patch sets city to Pune
 * but city is ALREADY Pune", which is worth showing as "no change".
 */
function sameValue(a, b) {
  if (a === b) {
    return true;
  }
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch (error) {
    return false;
  }
}

/** Shorten a long string for display, with a real ellipsis character. */
function truncate(text, maxChars) {
  if (typeof text !== 'string') {
    return '';
  }
  if (text.length <= maxChars) {
    return text;
  }
  return text.substring(0, maxChars) + '…';
}

/** Show the one-line status under the Undo button. kind: 'ok'|'error'|'info'. */
function showStatus(text, kind) {
  elStatus.textContent = text;
  elStatus.className = kind || 'info';
}

/** Format a timestamp for the "learned" list. Returns '' for anything odd. */
function formatWhen(millis) {
  if (typeof millis !== 'number' || !isFinite(millis) || millis <= 0) {
    return '';
  }
  try {
    return new Date(millis).toLocaleString();
  } catch (error) {
    return '';
  }
}


/* ========================================================================= *
 * 5. PATH / MERGE / DIFF  — the pure logic, exported on AF.chat
 * ========================================================================= */

/**
 * Read a value out of a nested object using dot notation.
 *
 *   getByPath(profile, 'personal.city')          -> 'Pune'
 *   getByPath(profile, 'yearsBySkill.Java')      -> 2
 *   getByPath(profile, 'experience.0.company')   -> 'Longfloat ...'
 *
 * Returns undefined when any step of the path is missing, which is exactly how
 * the diff detects "this is a NEW field".
 *
 * LIMITATION (deliberate, matching lib/match.js's own path walker): a profile
 * key that itself contains a full stop cannot be addressed. No key in
 * AF.DEFAULT_PROFILE does.
 */
function getByPath(root, path) {
  if (typeof path !== 'string' || path === '') {
    return undefined;
  }

  var parts = path.split('.');
  var current = root;

  for (var i = 0; i < parts.length; i++) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = current[parts[i]];
  }

  return current;
}

/**
 * Deep-merge a patch into a profile and return a NEW object. Neither argument
 * is modified.
 *
 * ==== THE MERGE RULES (these are the whole contract) ====================
 *
 *   1. OBJECTS MERGE RECURSIVELY.
 *        base  { personal: { city: '', state: '' } }
 *        patch { personal: { city: 'Pune' } }
 *        out   { personal: { city: 'Pune', state: '' } }
 *      So "my city is Pune" cannot wipe out your phone number.
 *
 *   2. ARRAYS REPLACE WHOLESALE — they are never concatenated.
 *        base  { preferredLocations: ['Remote', 'Pune'] }
 *        patch { preferredLocations: ['Dubai'] }
 *        out   { preferredLocations: ['Dubai'] }
 *      This is why "my skills are X and Y" does not append X and Y onto the
 *      existing 37 skills every single time you mention them. If you want to
 *      ADD to a list, say the whole list, or edit it in Settings.
 *
 *   3. null MEANS "CLEAR THIS FIELD".
 *        patch { referredBy: null }  ->  profile.referredBy === null
 *      The key is kept and set to null rather than deleted, so the change is
 *      visible in the Settings JSON editor. lib/match.js already treats null
 *      exactly like '' — "the user never filled this in" — so a cleared field
 *      is skipped during a fill instead of being answered with junk.
 *
 *   4. ANYTHING ELSE (string, number, boolean) simply overwrites.
 *
 *   5. An UNKNOWN PATH IS STILL APPLIED, but buildDiff() flags it in the UI as
 *      "new field". A hallucinated key must be visible, not silent — that is
 *      the whole reason Apply exists.
 *
 *   6. __proto__ / prototype / constructor are dropped outright. No legitimate
 *      profile key is called that, and honouring one would let a bad reply
 *      poison every object on the page.
 * ======================================================================== */
function deepMerge(base, patch) {
  /* Start from a copy of the base so the caller's object is untouched. */
  var out = isPlainObject(base) ? deepCopy(base) : {};
  if (!isPlainObject(out)) {
    out = {};
  }

  if (!isPlainObject(patch)) {
    return out;
  }

  var keys = Object.keys(patch);

  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];

    /* Rule 6 — never write a dangerous key. */
    if (FORBIDDEN_KEYS.indexOf(key) !== -1) {
      continue;
    }

    var patchValue = patch[key];

    if (isPlainObject(patchValue)) {
      /* Rule 1 — recurse. If the base had a non-object here (say a string) the
       * patch is turning it into an object, so start the recursion from {}. */
      var existing = isPlainObject(out[key]) ? out[key] : {};
      out[key] = deepMerge(existing, patchValue);

    } else if (Array.isArray(patchValue)) {
      /* Rule 2 — replace, and copy so the stored profile does not share an
       * array with the patch object still held by the page. */
      out[key] = deepCopy(patchValue);

    } else {
      /* Rules 3 and 4 — null clears, everything else overwrites. */
      out[key] = patchValue;
    }
  }

  return out;
}

/**
 * Flatten a patch into a list of leaf paths.
 *
 *   { personal: { city: 'Pune' }, yearsOfExperience: 3 }
 *      ->  [ { path: 'personal.city', value: 'Pune' },
 *            { path: 'yearsOfExperience', value: 3 } ]
 *
 * A leaf is anything that is not a non-empty plain object: strings, numbers,
 * booleans, null, arrays (rule 2 says an array is one atomic value), and the
 * odd empty {} (shown as a leaf so it is at least visible).
 *
 * @param {Object} patch   the patch to flatten
 * @param {String} prefix  internal — the dotted path built up so far
 * @param {Array}  out     internal — the accumulator
 */
function collectPatchPaths(patch, prefix, out) {
  var results = out || [];
  var base = prefix || '';

  if (!isPlainObject(patch)) {
    return results;
  }

  var keys = Object.keys(patch);

  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];

    if (FORBIDDEN_KEYS.indexOf(key) !== -1) {
      continue;   /* dropped by deepMerge too, so never show it as a change */
    }

    var value = patch[key];
    var path = (base === '') ? key : (base + '.' + key);

    if (isPlainObject(value) && Object.keys(value).length > 0) {
      collectPatchPaths(value, path, results);
    } else {
      results.push({ path: path, value: value });
    }
  }

  return results;
}

/**
 * Turn (current profile, patch) into the rows the diff renderer draws.
 *
 * One row per changed path:
 *   {
 *     path:    'yearsOfExperience',
 *     before:  2,            // undefined when the path does not exist yet
 *     after:   3,
 *     isNew:   false,        // true  -> render the amber "new field" badge
 *     changed: true          // false -> "already 3, no change"
 *   }
 */
function buildDiff(profile, patch) {
  var leaves = collectPatchPaths(patch, '', []);
  var rows = [];

  for (var i = 0; i < leaves.length; i++) {
    var leaf = leaves[i];
    var before = getByPath(profile, leaf.path);

    rows.push({
      path:    leaf.path,
      before:  before,
      after:   leaf.value,
      isNew:   (before === undefined),
      changed: !sameValue(before, leaf.value)
    });
  }

  return rows;
}

/**
 * Render one value as the short human string shown in the diff.
 *
 * The special cases matter: an empty string and a missing field look identical
 * otherwise, and telling them apart is the difference between "you never set
 * this" and "you cleared it".
 */
function formatValue(value) {
  if (value === undefined) {
    return '(not set)';
  }
  if (value === null) {
    return '(cleared)';
  }
  if (value === '') {
    return '(empty)';
  }

  if (typeof value === 'string') {
    return truncate(value, VALUE_PREVIEW_CHARS);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    var parts = [];
    for (var i = 0; i < value.length; i++) {
      var item = value[i];
      parts.push(isPlainObject(item) || Array.isArray(item)
        ? JSON.stringify(item)
        : String(item));
    }
    return truncate('[' + parts.join(', ') + ']', VALUE_PREVIEW_CHARS);
  }

  /* Plain object — only reachable for an empty {}. */
  try {
    return truncate(JSON.stringify(value), VALUE_PREVIEW_CHARS);
  } catch (error) {
    return '(unprintable value)';
  }
}

/** One diff row as a single plain-text line, e.g. "personal.city: (empty) -> Pune".
 *  Used when the message is persisted to storage, where there is no styling. */
function diffRowToText(row) {
  var line = row.path + ': ' + formatValue(row.before) + ' -> ' + formatValue(row.after);
  if (row.isNew) {
    line = line + '   [new field]';
  } else if (!row.changed) {
    line = line + '   [no change]';
  }
  return line;
}

/* Export the pure bits. */
AF.chat.getByPath         = getByPath;
AF.chat.deepMerge         = deepMerge;
AF.chat.collectPatchPaths = collectPatchPaths;
AF.chat.buildDiff         = buildDiff;
AF.chat.formatValue       = formatValue;


/* ========================================================================= *
 * 6. STORAGE
 * ========================================================================= */

/**
 * Read the live profile.
 *
 * Falls back to a COPY of the bundled AF.DEFAULT_PROFILE when storage is empty
 * (fresh install, nothing saved from the Settings page yet). A copy, so that
 * applying a patch can never mutate the bundled default in place.
 *
 * @param {Function} done  called as done(profileObject)
 */
function loadProfile(done) {
  chrome.storage.local.get([KEY_PROFILE], function (stored) {
    /* chrome.runtime.lastError MUST be read inside the callback or Chrome logs
     * an "unchecked runtime.lastError" warning. */
    if (chrome.runtime.lastError) {
      showStatus('Could not read your saved profile: ' + chrome.runtime.lastError.message, 'error');
      done(deepCopy(AF.DEFAULT_PROFILE) || {});
      return;
    }

    var saved = stored ? stored[KEY_PROFILE] : undefined;

    if (isPlainObject(saved)) {
      done(saved);
      return;
    }

    done(deepCopy(AF.DEFAULT_PROFILE) || {});
  });
}

/**
 * Apply a patch to the stored profile, keeping an undo snapshot.
 *
 * Everything is done inside ONE storage read so the snapshot is genuinely the
 * profile that was live a moment ago (and not something re-read after another
 * page changed it).
 *
 * @param {String}   userText  the sentence that produced this patch (for the log)
 * @param {Object}   patch     the patch to merge in
 * @param {Function} done      called as done(errorStringOrNull, mergedProfile)
 */
function applyPatchToProfile(userText, patch, done) {
  chrome.storage.local.get([KEY_PROFILE, KEY_HISTORY], function (stored) {
    if (chrome.runtime.lastError) {
      done('Could not read storage: ' + chrome.runtime.lastError.message, null);
      return;
    }

    var current = (stored && isPlainObject(stored[KEY_PROFILE]))
      ? stored[KEY_PROFILE]
      : (deepCopy(AF.DEFAULT_PROFILE) || {});

    var history = (stored && Array.isArray(stored[KEY_HISTORY])) ? stored[KEY_HISTORY] : [];

    /* The snapshot is the profile as it is RIGHT NOW, before the merge. */
    var snapshot = {
      at:      Date.now(),
      text:    userText,
      profile: deepCopy(current) || {}
    };

    /* Oldest first, newest last, capped at MAX_HISTORY. slice(-MAX) keeps the
     * last N entries and quietly drops anything older. */
    var newHistory = history.concat([snapshot]).slice(-MAX_HISTORY);

    var merged = deepMerge(current, patch);

    var toStore = {};
    toStore[KEY_PROFILE] = merged;
    toStore[KEY_HISTORY] = newHistory;

    chrome.storage.local.set(toStore, function () {
      if (chrome.runtime.lastError) {
        done('Could not save: ' + chrome.runtime.lastError.message, null);
        return;
      }
      done(null, merged);
    });
  });
}

/**
 * Undo: restore the most recent snapshot and drop it from the history, so
 * pressing Undo repeatedly walks backwards through the last 10 changes.
 *
 * @param {Function} done  called as done(errorStringOrNull, restoredSnapshotOrNull)
 */
function undoLastChange(done) {
  chrome.storage.local.get([KEY_HISTORY], function (stored) {
    if (chrome.runtime.lastError) {
      done('Could not read storage: ' + chrome.runtime.lastError.message, null);
      return;
    }

    var history = (stored && Array.isArray(stored[KEY_HISTORY])) ? stored[KEY_HISTORY] : [];

    if (history.length === 0) {
      done('There is nothing to undo.', null);
      return;
    }

    /* Take the newest entry off the end. */
    var newHistory = history.slice();
    var snapshot = newHistory.pop();

    if (!snapshot || !isPlainObject(snapshot.profile)) {
      /* Corrupt entry — drop it rather than restoring rubbish. */
      var cleaned = {};
      cleaned[KEY_HISTORY] = newHistory;
      chrome.storage.local.set(cleaned, function () {
        done('That undo entry was unreadable, so it was discarded.', null);
      });
      return;
    }

    var toStore = {};
    toStore[KEY_PROFILE] = snapshot.profile;
    toStore[KEY_HISTORY] = newHistory;

    chrome.storage.local.set(toStore, function () {
      if (chrome.runtime.lastError) {
        done('Could not save: ' + chrome.runtime.lastError.message, null);
        return;
      }
      done(null, snapshot);
    });
  });
}

/** Enable / disable the Undo button based on how many snapshots exist. */
function refreshUndoButton() {
  chrome.storage.local.get([KEY_HISTORY], function (stored) {
    if (chrome.runtime.lastError) {
      elBtnUndo.disabled = true;
      return;
    }
    var history = (stored && Array.isArray(stored[KEY_HISTORY])) ? stored[KEY_HISTORY] : [];
    elBtnUndo.disabled = (history.length === 0);
    elBtnUndo.title = (history.length === 0)
      ? 'Nothing to undo yet.'
      : 'Restore the profile as it was before the last applied change (' +
        history.length + ' step(s) available).';
  });
}


/* ========================================================================= *
 * 7. TRANSCRIPT PERSISTENCE
 * -------------------------------------------------------------------------
 * The conversation is stored so re-opening this page (or restarting the
 * device) still shows what you told it. Only the TEXT is stored — a pending
 * Apply/Discard card is deliberately NOT restorable, because agreeing to a
 * change you last saw three days ago is exactly the mistake the confirmation
 * step exists to prevent. Restored cards read "not applied".
 * ========================================================================= */

/** Push one entry into the mirror and persist the (trimmed) list. */
function rememberEntry(entry) {
  transcriptEntries.push(entry);
  if (transcriptEntries.length > MAX_TRANSCRIPT) {
    transcriptEntries = transcriptEntries.slice(-MAX_TRANSCRIPT);
  }

  var toStore = {};
  toStore[KEY_TRANSCRIPT] = transcriptEntries;

  chrome.storage.local.set(toStore, function () {
    if (chrome.runtime.lastError) {
      /* Not worth interrupting the user for — the profile is what matters. */
      showStatus('Note: the conversation could not be saved (' +
        chrome.runtime.lastError.message + ').', 'info');
    }
  });
}

/** Erase the stored conversation (used by the "Clear chat" affordance). */
function clearTranscript() {
  transcriptEntries = [];
  elTranscript.textContent = '';
  var toStore = {};
  toStore[KEY_TRANSCRIPT] = [];
  chrome.storage.local.set(toStore, function () { /* nothing to report */ });
}


/* ========================================================================= *
 * 8. DRAWING MESSAGES
 * -------------------------------------------------------------------------
 * Everything here builds DOM nodes with createElement + textContent. There is
 * NO innerHTML anywhere in this file: message text comes from the user and
 * from a language model, and textContent means neither can inject markup.
 * ========================================================================= */

/** Scroll the transcript to the newest message. */
function scrollToBottom() {
  elTranscript.scrollTop = elTranscript.scrollHeight;
}

/**
 * Create an empty bubble in the transcript and return it.
 *
 * @param {String} role        'user' or 'bot' — decides which side it sits on
 * @param {String} extraClass  optional extra bubble class ('error', 'note', ...)
 * @returns {Element} the bubble element (the row wrapper is its parent)
 */
function createBubble(role, extraClass) {
  var row = document.createElement('div');
  row.className = 'row ' + role;

  var bubble = document.createElement('div');
  bubble.className = 'bubble ' + role + (extraClass ? ' ' + extraClass : '');

  row.appendChild(bubble);
  elTranscript.appendChild(row);
  scrollToBottom();

  return bubble;
}

/** Remove a bubble (used for the temporary "thinking..." one). */
function removeBubble(bubble) {
  if (bubble && bubble.parentNode && bubble.parentNode.parentNode) {
    bubble.parentNode.parentNode.removeChild(bubble.parentNode);
  }
}

/**
 * Draw a stored/immediate message. This is the single renderer used both for
 * live messages and for messages restored from storage, so the two can never
 * drift apart.
 *
 * @param {Object} entry  { role, text, lines, note }
 *                        role  'user' | 'bot' | 'error' | 'note'
 *                        text  the message body
 *                        lines optional array of plain diff lines
 *                        note  optional trailing grey line ("Applied.")
 * @returns {Element} the bubble
 */
function drawEntry(entry) {
  var role = (entry.role === 'user') ? 'user' : 'bot';
  var extra = '';
  if (entry.role === 'error') { extra = 'error'; }
  if (entry.role === 'note')  { extra = 'note';  }

  var bubble = createBubble(role, extra);

  if (entry.text) {
    var textNode = document.createElement('div');
    textNode.textContent = entry.text;
    bubble.appendChild(textNode);
  }

  if (Array.isArray(entry.lines) && entry.lines.length > 0) {
    var box = document.createElement('div');
    box.className = 'diff';
    for (var i = 0; i < entry.lines.length; i++) {
      var line = document.createElement('span');
      line.className = 'diff-line';
      line.textContent = entry.lines[i];
      box.appendChild(line);
    }
    bubble.appendChild(box);
  }

  if (entry.note) {
    var noteNode = document.createElement('div');
    noteNode.className = 'confirm-question';
    noteNode.textContent = entry.note;
    bubble.appendChild(noteNode);
  }

  scrollToBottom();
  return bubble;
}

/** His message: draw it and remember it. */
function addUserMessage(text) {
  var entry = { role: 'user', text: text, at: Date.now() };
  drawEntry(entry);
  rememberEntry(entry);
}

/** A reply / note / error from the extension: draw it and remember it. */
function addBotMessage(text, role, lines, note) {
  var entry = {
    role:  role || 'bot',
    text:  text,
    lines: lines || null,
    note:  note || '',
    at:    Date.now()
  };
  drawEntry(entry);
  rememberEntry(entry);
}


/* ========================================================================= *
 * 9. THE PENDING-CHANGE CARD  (summary + diff + Apply / Discard)
 * ========================================================================= */

/**
 * Retire whatever change is currently awaiting confirmation.
 *
 * Called when he sends a new message without answering the previous card, and
 * after Apply / Discard. The card stays on screen for context but its buttons
 * are replaced with a sentence saying what happened, so there is never any
 * doubt about whether something was written.
 *
 * @param {String} reason  the sentence to leave behind
 */
function supersedePending(reason) {
  if (!pendingCard) {
    return;
  }

  /* Wipe the buttons and put the reason in their place. */
  pendingCard.actions.textContent = '';
  pendingCard.actions.className = 'confirm-question';
  pendingCard.actions.textContent = reason;

  pendingCard = null;
}

/**
 * Draw the "here is what I understood, shall I apply it?" card.
 *
 * @param {String} userText  the sentence he typed (kept for the audit log)
 * @param {String} summary   the model's plain-language summary
 * @param {Object} patch     the proposed patch
 * @param {Array}  rows      output of buildDiff()
 */
function renderPatchCard(userText, summary, patch, rows) {
  var bubble = createBubble('bot', '');

  /* --- 1. the summary sentence ------------------------------------------ */
  var summaryNode = document.createElement('div');
  summaryNode.textContent = summary;
  bubble.appendChild(summaryNode);

  /* --- 2. the diff -------------------------------------------------------
   * Each row is built out of separate <span>s so "before" can be struck
   * through and "after" can be green. Text always goes in via textContent. */
  var box = document.createElement('div');
  box.className = 'diff';

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];

    var line = document.createElement('span');
    line.className = 'diff-line';

    var pathSpan = document.createElement('span');
    pathSpan.className = 'diff-path';
    pathSpan.textContent = row.path + ': ';
    line.appendChild(pathSpan);

    var oldSpan = document.createElement('span');
    oldSpan.className = 'diff-old';
    oldSpan.textContent = formatValue(row.before);
    line.appendChild(oldSpan);

    var arrowSpan = document.createElement('span');
    arrowSpan.className = 'diff-arrow';
    arrowSpan.textContent = '->';
    line.appendChild(arrowSpan);

    var newSpan = document.createElement('span');
    newSpan.className = 'diff-new';
    newSpan.textContent = formatValue(row.after);
    line.appendChild(newSpan);

    /* Rule 5: an unknown path is applied, but it is FLAGGED so a hallucinated
     * key is impossible to miss. */
    if (row.isNew) {
      var badge = document.createElement('span');
      badge.className = 'badge-new';
      badge.textContent = 'new field: ' + row.path;
      line.appendChild(badge);
    } else if (!row.changed) {
      var same = document.createElement('span');
      same.className = 'badge-new';
      same.textContent = 'already set to this';
      line.appendChild(same);
    }

    box.appendChild(line);
  }

  bubble.appendChild(box);

  /* --- 3. the confirmation question ------------------------------------- */
  var question = document.createElement('div');
  question.className = 'confirm-question';
  question.textContent = 'Apply these changes?';
  bubble.appendChild(question);

  /* --- 4. the two buttons ------------------------------------------------ */
  var actions = document.createElement('div');
  actions.className = 'card-actions';

  var btnApply = document.createElement('button');
  btnApply.type = 'button';
  btnApply.className = 'btn primary small';
  btnApply.textContent = 'Apply';

  var btnDiscard = document.createElement('button');
  btnDiscard.type = 'button';
  btnDiscard.className = 'btn small';
  btnDiscard.textContent = 'Discard';

  actions.appendChild(btnApply);
  actions.appendChild(btnDiscard);
  bubble.appendChild(actions);

  /* Remember this card as THE pending one. Anything sent before it is answered
   * supersedes it. */
  pendingCard = { bubble: bubble, actions: actions, patch: patch, text: userText };

  /* Persist the card as plain text (no buttons on restore — see section 7). */
  var plainLines = [];
  for (var j = 0; j < rows.length; j++) {
    plainLines.push(diffRowToText(rows[j]));
  }
  rememberEntry({
    role:  'bot',
    text:  summary,
    lines: plainLines,
    note:  'Apply these changes? (answer this while the page is open — a change is never applied on its own)',
    at:    Date.now()
  });

  /* --- 5. behaviour ------------------------------------------------------ */

  btnApply.addEventListener('click', function () {
    /* Guard against a double click landing twice. */
    btnApply.disabled = true;
    btnDiscard.disabled = true;

    applyPatchToProfile(userText, patch, function (error) {
      if (error) {
        btnApply.disabled = false;
        btnDiscard.disabled = false;
        showStatus(error, 'error');
        addBotMessage('I could not save that change: ' + error, 'error');
        return;
      }

      supersedePending('Applied. Your profile now has these values.');
      showStatus('Saved. Future fills use the new values.', 'ok');
      addBotMessage('Done — your profile is updated. Press "Undo last change" if that was wrong.',
        'note');

      /* Write the fact to the audit log so "What I've learned" can show it, and
       * refresh the parts of the page that depend on stored state. */
      recordFact(userText, patch);
      refreshUndoButton();
      renderLearnedList();
    });
  });

  btnDiscard.addEventListener('click', function () {
    supersedePending('Discarded. Nothing was changed.');
    showStatus('Discarded — your profile is untouched.', 'info');
  });

  scrollToBottom();
}


/* ========================================================================= *
 * 10. TALKING TO THE SERVICE WORKER
 * ========================================================================= */

/** Enable / disable the composer while a request is in flight. */
function setBusy(isBusy) {
  busy = isBusy;
  elBtnSend.disabled = isBusy;
  elInput.disabled = isBusy;
  elBtnSend.textContent = isBusy ? 'Thinking…' : 'Send';
}

/**
 * Send whatever is in the textarea.
 *
 * The reply shape from background.js is { ok, patch, summary, error }.
 */
function sendCurrentMessage() {
  if (busy) {
    return;
  }

  var text = elInput.value.trim();
  if (text === '') {
    showStatus('Type something first — for example "my notice period is 60 days now".', 'info');
    elInput.focus();
    return;
  }

  /* Answering a card by ignoring it is not an answer. Say so explicitly. */
  supersedePending('Not applied — you sent another message before answering this one.');

  addUserMessage(text);
  elInput.value = '';
  showStatus('', 'info');
  setBusy(true);

  /* A temporary bubble that is NOT persisted; it is removed when the reply
   * arrives. */
  var thinking = createBubble('bot', 'pending');
  thinking.textContent = 'Working out what that changes…';

  chrome.runtime.sendMessage({ type: 'CHAT_UPDATE_PROFILE', text: text }, function (response) {
    removeBubble(thinking);
    setBusy(false);
    elInput.focus();

    /* lastError must be read inside the callback. It is set when nothing
     * answered — usually because background.js has no CHAT_UPDATE_PROFILE
     * branch, or the worker threw before replying. */
    if (chrome.runtime.lastError) {
      addBotMessage(
        'The extension\'s background worker did not answer. Open chrome://extensions, ' +
        'reload this extension, and try again. (' + chrome.runtime.lastError.message + ')',
        'error');
      showStatus('No answer from the background worker.', 'error');
      return;
    }

    if (!response || typeof response !== 'object') {
      addBotMessage('I got an empty answer back. Nothing was changed.', 'error');
      showStatus('Empty answer from the background worker.', 'error');
      return;
    }

    if (response.ok !== true) {
      addBotMessage(
        (typeof response.error === 'string' && response.error !== '')
          ? response.error
          : 'Something went wrong and I could not work out what to change.',
        'error');
      showStatus('Nothing was changed.', 'error');
      return;
    }

    handleSuccessfulReply(text, response);
  });
}

/**
 * We have an ok:true reply. Decide whether there is anything to confirm.
 */
function handleSuccessfulReply(userText, response) {
  var summary = (typeof response.summary === 'string' && response.summary.trim() !== '')
    ? response.summary.trim()
    : 'Here is what I understood.';

  var patch = response.patch;

  /* No patch at all, or a patch that is not an object: the model understood the
   * sentence but found nothing to change (or answered badly). Either way,
   * nothing is written. */
  if (!isPlainObject(patch) || Object.keys(patch).length === 0) {
    addBotMessage(summary, 'bot', null,
      'I did not find anything in your profile to change, so nothing was touched.');
    showStatus('No changes proposed.', 'info');
    return;
  }

  /* Diff against the CURRENT stored profile, not against the bundled default. */
  loadProfile(function (profile) {
    var rows = buildDiff(profile, patch);

    if (rows.length === 0) {
      addBotMessage(summary, 'bot', null, 'That patch was empty, so nothing was touched.');
      showStatus('No changes proposed.', 'info');
      return;
    }

    renderPatchCard(userText, summary, patch, rows);
    showStatus('Waiting for you: press Apply or Discard.', 'info');
  });
}


/* ========================================================================= *
 * 11. "WHAT I'VE LEARNED"  —  the lib/knowledge.js bridge
 * -------------------------------------------------------------------------
 * lib/knowledge.js owns the learned form answers. The three functions used here
 * are:
 *
 *   AF.knowledge.addFact(text, patch)   record that this sentence produced this
 *                                       patch (an audit trail)
 *   AF.knowledge.all()                  every learned answer
 *   AF.knowledge.forget(qKey)           delete one learned answer
 *
 * Every call below is wrapped defensively for two reasons:
 *   1. this page must still work if lib/knowledge.js fails to load;
 *   2. any of those functions may return either a plain value or a Promise
 *      (chrome.storage is asynchronous), so settle() copes with both.
 * ========================================================================= */

/** True when lib/knowledge.js loaded and exposes the function named. */
function hasKnowledgeFn(name) {
  return !!(AF.knowledge && typeof AF.knowledge[name] === 'function');
}

/**
 * Accept either a plain value or a Promise and hand the result to done().
 *
 * done(errorOrNull, value)
 */
function settle(value, done) {
  if (value && typeof value.then === 'function') {
    value.then(
      function (resolved) { done(null, resolved); },
      function (rejected) { done(rejected, null); }
    );
    return;
  }
  done(null, value);
}

/** Write one applied change to the knowledge audit log. Never fatal. */
function recordFact(text, patch) {
  if (!hasKnowledgeFn('addFact')) {
    return;   /* lib/knowledge.js missing — the profile is saved either way */
  }
  try {
    settle(AF.knowledge.addFact(text, patch), function (error) {
      if (error) {
        showStatus('Saved, but the change could not be added to the learning log.', 'info');
      }
    });
  } catch (error) {
    showStatus('Saved, but the change could not be added to the learning log.', 'info');
  }
}

/**
 * Normalise whatever AF.knowledge.all() returns into a flat array this page can
 * draw. Two shapes are accepted, because the exact one is decided in
 * lib/knowledge.js:
 *
 *   A) an ARRAY of entries   [ { qKey, question, answer, at }, ... ]
 *   B) an OBJECT keyed by qKey  { 'notice-period': { question, answer }, ... }
 *
 * Anything else yields an empty list rather than an exception.
 */
function normaliseKnowledge(raw) {
  var items = [];
  var i;

  if (Array.isArray(raw)) {
    for (i = 0; i < raw.length; i++) {
      items.push(normaliseKnowledgeItem(raw[i], null));
    }
  } else if (isPlainObject(raw)) {
    var keys = Object.keys(raw);
    for (i = 0; i < keys.length; i++) {
      items.push(normaliseKnowledgeItem(raw[keys[i]], keys[i]));
    }
  }

  /* Drop anything with nothing to show. */
  var kept = [];
  for (i = 0; i < items.length; i++) {
    if (items[i].question !== '' || items[i].answer !== '') {
      kept.push(items[i]);
    }
  }
  return kept;
}

/** One entry -> { qKey, question, answer, when }. Tolerates many field names. */
function normaliseKnowledgeItem(item, keyFromMap) {
  var out = { qKey: '', question: '', answer: '', when: '' };

  if (!isPlainObject(item)) {
    /* Shape B where the value is just the answer: { 'notice period': '60 days' } */
    out.qKey = keyFromMap || '';
    out.question = keyFromMap || '';
    out.answer = (item === null || item === undefined) ? '' : String(item);
    return out;
  }

  out.qKey = keyFromMap || item.qKey || item.key || item.id || item.q || '';

  var question = item.question || item.label || item.prompt || item.q || out.qKey;
  out.question = (question === undefined || question === null) ? '' : String(question);

  var answer = (item.answer !== undefined) ? item.answer : item.value;
  if (answer === undefined || answer === null) {
    out.answer = '';
  } else if (typeof answer === 'string') {
    out.answer = answer;
  } else {
    out.answer = formatValue(answer);
  }

  var when = item.at || item.savedAt || item.updatedAt || item.createdAt;
  out.when = formatWhen(when);

  return out;
}

/** Read the learned answers and redraw the collapsible list. */
function renderLearnedList() {
  elLearnedList.textContent = '';

  if (!hasKnowledgeFn('all')) {
    var missing = document.createElement('p');
    missing.className = 'empty';
    missing.textContent =
      'The learning store (lib/knowledge.js) is not loaded, so there is nothing to show here.';
    elLearnedList.appendChild(missing);
    return;
  }

  var raw;
  try {
    raw = AF.knowledge.all();
  } catch (error) {
    drawLearnedError('Could not read what has been learned: ' + error);
    return;
  }

  settle(raw, function (error, value) {
    if (error) {
      drawLearnedError('Could not read what has been learned: ' + error);
      return;
    }
    drawLearnedItems(normaliseKnowledge(value));
  });
}

function drawLearnedError(text) {
  elLearnedList.textContent = '';
  var node = document.createElement('p');
  node.className = 'empty';
  node.textContent = text;
  elLearnedList.appendChild(node);
}

function drawLearnedItems(items) {
  elLearnedList.textContent = '';

  if (items.length === 0) {
    var empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent =
      'Nothing yet. When a form asks something the extension cannot work out, it will ask you — ' +
      'and your answer shows up here.';
    elLearnedList.appendChild(empty);
    return;
  }

  for (var i = 0; i < items.length; i++) {
    elLearnedList.appendChild(buildLearnedRow(items[i]));
  }
}

/** One row of the learned list: question, answer, when, and a Forget button. */
function buildLearnedRow(item) {
  var row = document.createElement('div');
  row.className = 'learned-item';

  var textWrap = document.createElement('div');
  textWrap.className = 'learned-text';

  var q = document.createElement('div');
  q.className = 'learned-q';
  q.textContent = item.question;
  textWrap.appendChild(q);

  var a = document.createElement('div');
  a.className = 'learned-a';
  a.textContent = item.answer === '' ? '(no answer stored)' : item.answer;
  textWrap.appendChild(a);

  if (item.when !== '') {
    var meta = document.createElement('div');
    meta.className = 'learned-meta';
    meta.textContent = 'learned ' + item.when;
    textWrap.appendChild(meta);
  }

  row.appendChild(textWrap);

  /* Forget is only offered when there is a key to forget BY. */
  if (item.qKey !== '' && hasKnowledgeFn('forget')) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn tiny danger';
    btn.textContent = 'Forget';
    btn.title = 'Delete this learned answer. The extension will ask you again next time.';

    btn.addEventListener('click', function () {
      btn.disabled = true;
      try {
        settle(AF.knowledge.forget(item.qKey), function (error) {
          if (error) {
            btn.disabled = false;
            showStatus('Could not forget that: ' + error, 'error');
            return;
          }
          showStatus('Forgotten: ' + item.question, 'ok');
          renderLearnedList();
        });
      } catch (error) {
        btn.disabled = false;
        showStatus('Could not forget that: ' + error, 'error');
      }
    });

    row.appendChild(btn);
  }

  return row;
}


/* ========================================================================= *
 * 12. WIRING
 * ========================================================================= */

/* --- Send button --------------------------------------------------------- */
elBtnSend.addEventListener('click', sendCurrentMessage);

/* --- Enter to send, Shift+Enter for a newline ----------------------------
 * keydown (not keypress, which is deprecated). event.shiftKey tells the two
 * apart; preventDefault stops the plain Enter from inserting a newline before
 * we clear the box. isComposing guards IME input (typing Japanese/Chinese),
 * where Enter commits the candidate rather than sending. */
elInput.addEventListener('keydown', function (event) {
  if (event.key !== 'Enter') {
    return;
  }
  if (event.isComposing) {
    return;
  }
  if (event.shiftKey) {
    return;   /* let the newline through */
  }

  event.preventDefault();
  sendCurrentMessage();
});

/* --- Example chips -------------------------------------------------------
 * One listener on the container instead of three on the buttons (event
 * delegation): the click bubbles up and we read data-text off whatever was
 * clicked. Chips PREFILL the box, they do not send — "My phone number is …"
 * needs the number typing in first. */
elChips.addEventListener('click', function (event) {
  var target = event.target;
  if (!target || !target.classList || !target.classList.contains('chip')) {
    return;
  }

  var text = target.getAttribute('data-text') || target.textContent || '';
  elInput.value = text;
  elInput.focus();

  /* Put the caret at the very end so he can carry straight on typing. */
  var end = elInput.value.length;
  elInput.setSelectionRange(end, end);
});

/* --- Undo ---------------------------------------------------------------- */
elBtnUndo.addEventListener('click', function () {
  var confirmed = window.confirm(
    'Restore your profile to how it was before the last applied change?'
  );
  if (!confirmed) {
    return;
  }

  elBtnUndo.disabled = true;

  undoLastChange(function (error, snapshot) {
    if (error) {
      showStatus(error, 'error');
      refreshUndoButton();
      return;
    }

    var what = (snapshot && snapshot.text) ? ' ("' + truncate(snapshot.text, 60) + '")' : '';
    showStatus('Undone. Your profile is back to how it was before that change.', 'ok');
    addBotMessage('Undone' + what + '. Your profile is back to its previous values.', 'note');

    refreshUndoButton();
  });
});


/* ========================================================================= *
 * 13. STARTUP
 * ========================================================================= */

/**
 * Redraw the saved conversation, or greet him if there is none.
 *
 * The greeting is NOT persisted — it is regenerated whenever the transcript is
 * empty, so it never piles up.
 */
function restoreTranscript() {
  chrome.storage.local.get([KEY_TRANSCRIPT], function (stored) {
    if (chrome.runtime.lastError) {
      transcriptEntries = [];
    } else {
      var saved = stored ? stored[KEY_TRANSCRIPT] : undefined;
      transcriptEntries = Array.isArray(saved) ? saved : [];
    }

    elTranscript.textContent = '';

    for (var i = 0; i < transcriptEntries.length; i++) {
      var entry = transcriptEntries[i];
      if (entry && typeof entry === 'object') {
        drawEntry(entry);
      }
    }

    if (transcriptEntries.length === 0) {
      /* Drawn straight, not through addBotMessage, so it is not remembered. */
      drawEntry({
        role: 'bot',
        text: 'Tell me anything that has changed and I will update your profile — ' +
              'your city, your notice period, your years of experience, a new phone number, ' +
              'whether you would relocate. I will show you exactly what I want to change ' +
              'and change nothing until you press Apply.'
      });
    }

    scrollToBottom();
  });
}

/* Draw everything, then put the cursor in the box. */
restoreTranscript();
refreshUndoButton();
renderLearnedList();
elInput.focus();

/* Keep the page honest if the profile is changed somewhere else (the Settings
 * page, or a form fill that learned a new answer) while this page is open.
 * chrome.storage.onChanged fires in every extension page, so the Undo button
 * and the learned list stay accurate without a refresh. */
chrome.storage.onChanged.addListener(function (changes, areaName) {
  if (areaName !== 'local' || !changes) {
    return;
  }

  if (changes[KEY_HISTORY]) {
    refreshUndoButton();
  }

  /* lib/knowledge.js persists under its own key; rather than guess its name,
   * redraw the learned list whenever anything in local storage changes that is
   * not one of ours. Cheap, and it cannot go stale. */
  var changedKeys = Object.keys(changes);
  for (var i = 0; i < changedKeys.length; i++) {
    var key = changedKeys[i];
    if (key !== KEY_PROFILE && key !== KEY_HISTORY && key !== KEY_TRANSCRIPT) {
      renderLearnedList();
      break;
    }
  }
});

/* Expose the "start a fresh conversation" action for the console. It is not a
 * button: wiping the chat is not something to offer next to Undo, where a
 * mis-click would look like it had wiped the profile. */
AF.chat.clearTranscript = clearTranscript;
