/*
 * ask.js — the brain behind ask.html, the "please answer these for me" page.
 *
 * THE ONE-PARAGRAPH VERSION
 *   content.js finishes a fill run, notices some boxes it could not answer with
 *   confidence, and parks those fields in chrome.storage.local under the key
 *   'pendingQuestions'. This page reads that array, walks it one card at a time,
 *   and pushes each answer into the knowledge store via AF.knowledge.remember().
 *   Next time a form asks the same thing, the extension already knows.
 *
 * THE DATA THAT ARRIVES
 *   'pendingQuestions' is an ARRAY of serialisable Field objects — the exact
 *   shape AF.toSerialisable() produces in lib/scrape.js:
 *
 *     { index, kind, type, name, id, placeholder, ariaLabel, label, context,
 *       required, options: [{value, text}], groupName, filled }
 *
 *   plus, optionally, a couple of extras content.js may staple on so this page
 *   can show provenance:  url / pageUrl / sourceUrl, pageTitle, askedAt.
 *   Everything here treats those extras as OPTIONAL — if they are missing the
 *   card just shows less.
 *
 *   There is deliberately NO live DOM element in the queue. This page runs in a
 *   different tab from the job form; a DOM node could not survive the trip
 *   through storage, and would point at a page that has probably been closed.
 *
 * PERSISTENCE RULES THIS FILE OBEYS
 *   - chrome.storage.local is the ONLY store. It survives closing the tab,
 *     quitting Chrome, and restarting the machine.
 *   - The queue in storage is trimmed AS WE GO, one entry at a time, straight
 *     after each Save / Skip / Never. Close the tab halfway through and the
 *     answered ones are gone from the queue and the unanswered ones are still
 *     waiting. Nothing is batched up and lost.
 *   - The in-memory `queue` array below is a VIEW for rendering, never the
 *     source of truth. Every write re-reads storage first (see
 *     removeEntryFromStorage) so that a fill run happening in another tab, which
 *     appends new questions while he is typing, does not get clobbered.
 *
 * A NOTE FOR THE READER (Java/Spring + Flutter, not a JS dev)
 *   - `var AF = (globalThis.AF = globalThis.AF || {});` is the shared singleton
 *     namespace every file in this extension starts with. Think "static utility
 *     class". Load order then stops mattering.
 *   - `async` / `await` here works exactly like it does in Dart. A function
 *     marked async returns a Promise (a Future); await unwraps it.
 *   - Nothing is built or bundled. This is a plain classic script loaded by a
 *     <script src> tag. No import, no export.
 */

var AF = (globalThis.AF = globalThis.AF || {});


/* ------------------------------------------------------------------------- *
 * 1. Constants.
 * ------------------------------------------------------------------------- */

/* The storage key content.js writes the unanswered fields to. Spelled once. */
var KEY_PENDING = 'pendingQuestions';

/* What we hand to AF.knowledge.remember() for "never ask this again".
 *
 * It is a normal remembered answer, just one whose value is a marker string
 * instead of real text — a tombstone. The matching side (lib/knowledge.js and
 * content.js) is expected to recognise it and treat the field as "leave alone,
 * do not queue" rather than typing the marker into the form.
 *
 * If lib/knowledge.js publishes its own marker constant we use THAT instead
 * (see neverAskMarker() below), so the two files can never disagree.
 */
var FALLBACK_NEVER_ANSWER = '__af_never_ask__';

/* A question longer than this many characters gets the tall textarea, because
 * a long prompt almost always wants a long answer (cover letter, "why us?"). */
var LONG_QUESTION_CHARS = 120;

var TEXTAREA_ROWS_SHORT = 3;
var TEXTAREA_ROWS_LONG  = 8;

/* The extra radio we append to every multiple-choice question. Its value is a
 * sentinel string chosen so it can never collide with a real option's text. */
var OTHER_CHOICE_VALUE = '__af_other_choice__';

/* Console prefix, matching the rest of the extension. */
var LOG_PREFIX = '[AF ask]';


/* ------------------------------------------------------------------------- *
 * 2. Page elements, grabbed once.
 * ------------------------------------------------------------------------- */

var elProgress    = document.getElementById('progress');

var elCard        = document.getElementById('card');
var elCardContext = document.getElementById('cardContext');
var elCardLabel   = document.getElementById('cardLabel');
var elCardMeta    = document.getElementById('cardMeta');
var elCardSource  = document.getElementById('cardSource');
var elAnswerArea  = document.getElementById('answerArea');
var elCardError   = document.getElementById('cardError');

var elBtnSave     = document.getElementById('btnSave');
var elBtnSkip     = document.getElementById('btnSkip');
var elBtnNever    = document.getElementById('btnNever');

var elDone        = document.getElementById('done');
var elDoneTitle   = document.getElementById('doneTitle');
var elDoneBody    = document.getElementById('doneBody');
var elBtnClose    = document.getElementById('btnClose');

var elFatal       = document.getElementById('fatal');


/* ------------------------------------------------------------------------- *
 * 3. Page state.
 *
 *    Plain module-level variables are fine HERE. The warning in the project
 *    rules about module-scope state applies to background.js, the service
 *    worker, which Chrome evicts when idle. A page keeps its variables for as
 *    long as its tab is open — and even so, none of these are the source of
 *    truth: storage is.
 * ------------------------------------------------------------------------- */

/* The questions loaded when the page opened, each wrapped as:
 *     { entry: <serialisable field>, signature: <string identity> }
 * See makeSignature() for what the signature is for. */
var queue = [];

/* Which one is on screen. Only moves forward. */
var cursor = 0;

/* How many questions the page started with — the "of 7" in "Question 3 of 7".
 * Kept separate from queue.length so the denominator never changes mid-session. */
var totalQuestions = 0;

/* Tallies for the closing summary. */
var learnedCount = 0;
var skippedCount = 0;
var neverCount   = 0;

/* Set while a save is in flight, so a double click cannot answer twice or skip
 * past a question. */
var busy = false;

/* Can the question currently on screen actually be answered on this page?
 * false for file uploads. Kept as state because setBusyUi() has to restore the
 * Save button to the RIGHT value when a write finishes, not blindly enable it. */
var currentAnswerable = true;

/* Set by buildAnswerControls(): a zero-argument function that reads whatever
 * the current card's controls are holding and returns the answer as a String,
 * or returns null when nothing has been entered/selected yet. Rebuilt for every
 * card, because the controls differ per field.kind. */
var readCurrentAnswer = function () { return null; };


/* ------------------------------------------------------------------------- *
 * 4. Tiny helpers.
 * ------------------------------------------------------------------------- */

/** Log a warning with the shared prefix. Never throws. */
function logWarning(message, detail) {
  if (typeof detail === 'undefined') {
    console.warn(LOG_PREFIX + ' ' + message);
  } else {
    console.warn(LOG_PREFIX + ' ' + message, detail);
  }
}

/** Coerce anything to a trimmed String. undefined/null become ''. */
function asText(value) {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

/** Remove every child of an element. The plainest way to reset a container. */
function clearChildren(el) {
  while (el.firstChild) {
    el.removeChild(el.firstChild);
  }
}

/**
 * chrome.storage.local.get, wrapped as a Promise so the rest of this file can
 * use await and read top to bottom.
 *
 * Resolves with the stored value for `key`, or undefined. It NEVER rejects: a
 * storage read failure is logged and treated as "nothing stored", because a
 * half-crashed question page is worse than an empty one.
 */
function storageGet(key) {
  return new Promise(function (resolve) {
    try {
      chrome.storage.local.get([key], function (stored) {
        /* lastError has to be read inside the callback or Chrome logs an
         * "unchecked runtime.lastError" warning of its own. */
        if (chrome.runtime.lastError) {
          logWarning('could not read "' + key + '" from storage: ' + chrome.runtime.lastError.message);
          resolve(undefined);
          return;
        }
        resolve(stored ? stored[key] : undefined);
      });
    } catch (error) {
      logWarning('chrome.storage is unavailable for reading:', error);
      resolve(undefined);
    }
  });
}

/**
 * chrome.storage.local.set, wrapped as a Promise.
 *
 * Resolves true on success and false on failure — the caller decides whether a
 * failed write is worth telling him about.
 */
function storageSet(key, value) {
  return new Promise(function (resolve) {
    var payload = {};
    payload[key] = value;

    try {
      chrome.storage.local.set(payload, function () {
        if (chrome.runtime.lastError) {
          logWarning('could not write "' + key + '" to storage: ' + chrome.runtime.lastError.message);
          resolve(false);
          return;
        }
        resolve(true);
      });
    } catch (error) {
      logWarning('chrome.storage is unavailable for writing:', error);
      resolve(false);
    }
  });
}


/* ------------------------------------------------------------------------- *
 * 5. Reading a queue entry.
 *
 *    Everything below assumes the entry might be junk. It is data that has been
 *    sitting in storage, possibly written by an older version of the extension.
 *    Not one of these functions is allowed to throw.
 * ------------------------------------------------------------------------- */

/**
 * Is this queue entry usable at all?
 *
 * The bar is deliberately low: an object with SOMETHING we can show as a
 * question. A field with no label, no name, no id and no placeholder is
 * unanswerable and unidentifiable, so it is dropped.
 */
function isUsableEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return false;
  }
  return resolveLabel(entry) !== '';
}

/**
 * The heading text for a card: the best human-readable name for the field.
 *
 * Preference order matches what a person reading the form would see first.
 * lib/scrape.js already does the hard work of finding `label`; the rest are
 * fallbacks for the awkward forms that ship without one.
 */
function resolveLabel(entry) {
  var candidates = [
    asText(entry.label),
    asText(entry.ariaLabel),
    asText(entry.placeholder),
    asText(entry.name),
    asText(entry.id)
  ];

  var i;
  for (i = 0; i < candidates.length; i++) {
    if (candidates[i] !== '') {
      return candidates[i];
    }
  }
  return '';
}

/**
 * The source page URL, if content.js recorded one.
 *
 * Three spellings are accepted because this page cannot see how content.js was
 * written, and guessing wrong would silently drop the link. Anything that is
 * not an http(s) URL is refused: an href we cannot vouch for does not belong in
 * a link this page renders.
 */
function resolveUrl(entry) {
  var raw = asText(entry.url) || asText(entry.pageUrl) || asText(entry.sourceUrl);
  if (raw === '') {
    return '';
  }

  try {
    var parsed = new URL(raw);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.href;
    }
  } catch (error) {
    /* Not a URL at all. Fall through and show nothing. */
  }
  return '';
}

/**
 * A short, readable version of a URL for the link text —
 * "boards.greenhouse.io/acme/jobs/12345" rather than the full query string.
 */
function shortenUrl(url) {
  try {
    var parsed = new URL(url);
    var shown = parsed.host + parsed.pathname;

    if (shown.length > 70) {
      shown = shown.substring(0, 67) + '...';
    }
    return shown;
  } catch (error) {
    return url;
  }
}

/**
 * A stable identity string for a queue entry.
 *
 * WHY THIS EXISTS
 *   To remove an answered question from storage we must find it again in the
 *   stored array. We cannot compare by array position (another tab may have
 *   appended questions since we loaded) and we cannot compare by object
 *   reference (the objects come back from storage freshly deserialised, so
 *   `===` is always false). So we compare a signature built from the parts that
 *   identify the field.
 *
 *   It is also used to de-duplicate the queue on load: the same question
 *   collected twice — say a fill run repeated on the same page — should be
 *   asked once.
 */
function makeSignature(entry) {
  var parts = [
    resolveUrl(entry),
    asText(entry.kind),
    asText(entry.name),
    asText(entry.id),
    asText(entry.groupName),
    resolveLabel(entry).toLowerCase()
  ];
  return parts.join('\u001f');   /* a separator no real label can contain */
}

/**
 * The option list for a select/radio question, cleaned up.
 *
 * Returns [{value, text}] where text is always non-empty. Placeholder rows that
 * every dropdown starts with ("", "Select...", "Please choose") are dropped —
 * they are not answers, and offering them as choices is confusing.
 */
function usableOptions(entry) {
  var raw = Array.isArray(entry.options) ? entry.options : [];
  var out = [];
  var seen = {};
  var i;

  for (i = 0; i < raw.length; i++) {
    var option = raw[i];
    if (!option || typeof option !== 'object') {
      continue;
    }

    var text = asText(option.text);
    var value = asText(option.value);

    /* Some forms label a real option only by its value. Fall back to it. */
    if (text === '') {
      text = value;
    }
    if (text === '') {
      continue;
    }

    /* Drop the classic "nothing chosen yet" rows. */
    var lower = text.toLowerCase();
    if (lower === 'select...' || lower === 'select' || lower === 'please select' ||
        lower === 'choose...' || lower === 'choose' || lower === 'please choose' ||
        lower === '--' || lower === '---') {
      continue;
    }

    /* Duplicate option texts do happen; keep the first. */
    if (seen[lower]) {
      continue;
    }
    seen[lower] = true;

    out.push({ value: value, text: text });
  }

  return out;
}


/* ------------------------------------------------------------------------- *
 * 6. Talking to the knowledge store.
 *
 *    lib/knowledge.js owns the storage format. This page only ever asks it to
 *    load and to remember. Both calls are wrapped so that a missing or older
 *    knowledge.js degrades into a visible message instead of a broken page.
 * ------------------------------------------------------------------------- */

/** Is AF.knowledge present and shaped the way we need? */
function knowledgeIsUsable() {
  return !!(AF.knowledge && typeof AF.knowledge.remember === 'function');
}

/**
 * AF.knowledge.load(), tolerated in every plausible form.
 *
 * knowledge.js may return a Promise, or may be synchronous and return nothing.
 * Promise.resolve() flattens both cases, so the caller can always await.
 */
function knowledgeLoad() {
  if (!AF.knowledge || typeof AF.knowledge.load !== 'function') {
    /* Not fatal on its own: a knowledge module with no load() step is a
     * perfectly reasonable design. remember() is the call we truly need. */
    return Promise.resolve();
  }
  return Promise.resolve(AF.knowledge.load());
}

/**
 * The marker string that means "never ask me this again".
 *
 * Prefer a constant published by lib/knowledge.js so the two files agree even
 * if one of them is edited later. Fall back to our own.
 */
function neverAskMarker() {
  if (AF.knowledge && typeof AF.knowledge.NEVER_ANSWER === 'string' && AF.knowledge.NEVER_ANSWER !== '') {
    return AF.knowledge.NEVER_ANSWER;
  }
  return FALLBACK_NEVER_ANSWER;
}

/**
 * Store one answer.
 *
 * @param {Object} entry   the serialisable field the question came from
 * @param {String} answer  what he typed or picked
 * @returns {Promise<Boolean>} true when it was stored
 *
 * Never rejects. A failure resolves false and the caller shows an error line
 * instead of crashing out of the queue.
 */
function rememberAnswer(entry, answer) {
  if (!knowledgeIsUsable()) {
    return Promise.resolve(false);
  }

  try {
    /* Promise.resolve() again covers both a Promise-returning and a synchronous
     * implementation of remember(). */
    return Promise.resolve(AF.knowledge.remember(entry, answer)).then(
      function () {
        return true;
      },
      function (error) {
        logWarning('AF.knowledge.remember() failed:', error);
        return false;
      }
    );
  } catch (error) {
    logWarning('AF.knowledge.remember() threw:', error);
    return Promise.resolve(false);
  }
}

/**
 * Record the "never ask this again" tombstone.
 *
 * If lib/knowledge.js offers a purpose-built call we use it; otherwise we store
 * the marker string through the ordinary remember() path. Either way the field
 * ends up WITH a remembered answer, which is what keeps it out of the pending
 * queue on future runs — an unanswered field is exactly what gets re-queued.
 */
function rememberNeverAsk(entry) {
  if (AF.knowledge && typeof AF.knowledge.neverAsk === 'function') {
    try {
      return Promise.resolve(AF.knowledge.neverAsk(entry)).then(
        function () { return true; },
        function (error) {
          logWarning('AF.knowledge.neverAsk() failed:', error);
          return false;
        }
      );
    } catch (error) {
      logWarning('AF.knowledge.neverAsk() threw:', error);
      return Promise.resolve(false);
    }
  }

  return rememberAnswer(entry, neverAskMarker());
}


/* ------------------------------------------------------------------------- *
 * 7. The pending queue in storage.
 * ------------------------------------------------------------------------- */

/**
 * Read 'pendingQuestions' and turn it into the render list.
 *
 * Malformed entries are logged and dropped — the rule is that one bad row can
 * never stop him answering the good ones.
 */
async function loadQueue() {
  var stored = await storageGet(KEY_PENDING);

  if (typeof stored === 'undefined' || stored === null) {
    return [];
  }

  if (!Array.isArray(stored)) {
    logWarning('"' + KEY_PENDING + '" is not an array, ignoring it:', stored);
    return [];
  }

  var items = [];
  var seen = {};
  var i;

  for (i = 0; i < stored.length; i++) {
    var entry = stored[i];

    if (!isUsableEntry(entry)) {
      logWarning('skipping unusable pending question at position ' + i + ':', entry);
      continue;
    }

    var signature = makeSignature(entry);

    if (seen[signature]) {
      /* The same question twice. Ask it once. */
      continue;
    }
    seen[signature] = true;

    items.push({ entry: entry, signature: signature });
  }

  return items;
}

/**
 * Drop one question from the stored queue, matched by signature.
 *
 * Re-reads storage first rather than writing back a cached copy, so questions
 * appended by a fill run in another tab while he was typing survive.
 */
async function removeEntryFromStorage(signature) {
  var stored = await storageGet(KEY_PENDING);

  if (!Array.isArray(stored)) {
    /* Nothing to trim — someone else already cleared it. Not an error. */
    return;
  }

  var kept = [];
  var i;

  for (i = 0; i < stored.length; i++) {
    var entry = stored[i];

    /* Junk rows are dropped on the way past. Cleaning them up here means the
     * queue slowly repairs itself instead of accumulating rubbish forever. */
    if (!isUsableEntry(entry)) {
      continue;
    }

    if (makeSignature(entry) === signature) {
      continue;   /* this is the one being answered/skipped */
    }

    kept.push(entry);
  }

  await storageSet(KEY_PENDING, kept);
}


/* ------------------------------------------------------------------------- *
 * 8. Building the answer controls for one card.
 *
 *    Everything is built with document.createElement + textContent, never
 *    innerHTML. The label and option text come from a third-party job site;
 *    treating them as text rather than markup is the whole defence.
 * ------------------------------------------------------------------------- */

/**
 * Fill #answerArea with the right control(s) for this field, and set the module
 * level readCurrentAnswer() to a function that reads them back.
 *
 * @returns {Boolean} true when the question can actually be answered here.
 *                    false for things like file uploads, where the only sane
 *                    buttons are Skip and Never.
 */
function buildAnswerControls(entry) {
  clearChildren(elAnswerArea);
  readCurrentAnswer = function () { return null; };

  var kind = asText(entry.kind).toLowerCase();

  /* --- file uploads: nothing to type, he must attach it on the form itself --- */
  if (kind === 'file') {
    var note = document.createElement('p');
    note.className = 'note';
    note.textContent =
      'This is a file upload. The extension cannot attach a file for you, so there ' +
      'is nothing to answer here — attach it on the form itself, or silence this ' +
      'question with "Never ask this again".';
    elAnswerArea.appendChild(note);
    return false;
  }

  /* --- checkbox: a tick box is a Yes/No question in disguise --- */
  if (kind === 'checkbox') {
    buildRadioGroup([
      { value: 'Yes', text: 'Yes' },
      { value: 'No',  text: 'No'  }
    ], false);
    return true;
  }

  /* --- select / radio: real radio buttons, one per option --- */
  if (kind === 'select' || kind === 'radio') {
    var options = usableOptions(entry);

    if (options.length > 0) {
      buildRadioGroup(options, true);
      return true;
    }
    /* A dropdown whose options were not captured (some are built by JS only
     * after you click them). Fall through to a plain text box. */
    logWarning('no usable options captured for a ' + kind + ' question, showing a text box instead.');
  }

  /* --- everything else: free text --- */
  buildTextarea(entry);
  return true;
}

/**
 * A textarea, 3 rows normally and 8 for a long question.
 */
function buildTextarea(entry) {
  var question = resolveLabel(entry) + ' ' + asText(entry.context);
  var wantsRoom =
    asText(entry.kind).toLowerCase() === 'textarea' ||
    question.length > LONG_QUESTION_CHARS;

  var box = document.createElement('textarea');
  box.id = 'answerText';
  box.rows = wantsRoom ? TEXTAREA_ROWS_LONG : TEXTAREA_ROWS_SHORT;
  box.spellcheck = true;
  box.setAttribute('aria-label', 'Your answer');
  box.placeholder = wantsRoom
    ? 'Write it the way you would want it to appear on the form.'
    : 'Type your answer';

  elAnswerArea.appendChild(box);

  /* Typing clears any leftover "answer this first" error. */
  box.addEventListener('input', function () {
    setError('');
  });

  readCurrentAnswer = function () {
    var text = box.value;
    if (typeof text !== 'string' || text.trim() === '') {
      return null;
    }
    /* Trailing whitespace is trimmed, but internal newlines are kept — a
     * multi-line answer to an essay question is a legitimate answer. */
    return text.trim();
  };
}

/**
 * A list of radio buttons, optionally with an "Other / type my own" row at the
 * end that reveals a text box.
 *
 * @param {Array}   options    [{value, text}]
 * @param {Boolean} allowOther append the Other row?
 */
function buildRadioGroup(options, allowOther) {
  var fieldset = document.createElement('fieldset');
  fieldset.className = 'choices';

  /* A radio group needs a shared name; the value is irrelevant as long as it is
   * the same for every button in this card. */
  var groupName = 'answerChoice';

  /* The Other text box is created up front and only shown when Other is picked.
   * Building it lazily would lose whatever he had already typed if he clicked
   * around between options. */
  var otherWrap = document.createElement('div');
  otherWrap.className = 'other-box';
  otherWrap.hidden = true;

  var otherInput = document.createElement('input');
  otherInput.type = 'text';
  otherInput.id = 'answerOther';
  otherInput.placeholder = 'Type your own answer';
  otherInput.setAttribute('aria-label', 'Your own answer');
  otherWrap.appendChild(otherInput);

  var radios = [];
  var i;

  for (i = 0; i < options.length; i++) {
    var row = makeChoiceRow(groupName, options[i].text, options[i].text);
    radios.push(row.input);
    fieldset.appendChild(row.label);
  }

  var otherRadio = null;
  if (allowOther) {
    var otherRow = makeChoiceRow(groupName, OTHER_CHOICE_VALUE, 'Other / type my own');
    otherRadio = otherRow.input;
    radios.push(otherRadio);
    fieldset.appendChild(otherRow.label);
    fieldset.appendChild(otherWrap);
  }

  /* One shared change handler: show or hide the Other box, clear the error. */
  for (i = 0; i < radios.length; i++) {
    radios[i].addEventListener('change', function () {
      setError('');

      if (otherRadio) {
        otherWrap.hidden = !otherRadio.checked;
        if (otherRadio.checked) {
          otherInput.focus();
        }
      }
    });
  }

  otherInput.addEventListener('input', function () {
    setError('');
  });

  elAnswerArea.appendChild(fieldset);

  readCurrentAnswer = function () {
    var j;
    for (j = 0; j < radios.length; j++) {
      if (!radios[j].checked) {
        continue;
      }

      /* The Other row means "use the text box instead of the radio's value". */
      if (radios[j].value === OTHER_CHOICE_VALUE) {
        var typed = otherInput.value;
        if (typeof typed !== 'string' || typed.trim() === '') {
          return null;   /* Other picked but nothing typed = not answered yet */
        }
        return typed.trim();
      }

      return radios[j].value;
    }
    return null;   /* nothing selected */
  };
}

/**
 * One "[o] Some option text" row: a <label> wrapping a radio plus its text, so
 * that clicking anywhere on the row selects it.
 *
 * @returns {{label: HTMLElement, input: HTMLElement}}
 */
function makeChoiceRow(groupName, value, text) {
  var label = document.createElement('label');
  label.className = 'choice';

  var input = document.createElement('input');
  input.type = 'radio';
  input.name = groupName;
  input.value = value;

  var span = document.createElement('span');
  span.textContent = text;      /* textContent, never innerHTML — see section 8 */

  label.appendChild(input);
  label.appendChild(span);

  return { label: label, input: input };
}


/* ------------------------------------------------------------------------- *
 * 9. Rendering.
 * ------------------------------------------------------------------------- */

/** Show (or clear, with '') the red line above the buttons. */
function setError(message) {
  elCardError.textContent = message || '';
}

/** Add one small pill to the badge row. */
function addBadge(text, extraClass) {
  var badge = document.createElement('span');
  badge.className = 'badge' + (extraClass ? ' ' + extraClass : '');
  badge.textContent = text;
  elCardMeta.appendChild(badge);
}

/** A friendly name for a field kind, for the badge row. */
function describeKind(kind) {
  switch (asText(kind).toLowerCase()) {
    case 'textarea':        return 'Long answer';
    case 'select':          return 'Dropdown';
    case 'radio':           return 'Multiple choice';
    case 'checkbox':        return 'Tick box';
    case 'file':            return 'File upload';
    case 'contenteditable': return 'Rich text';
    case 'text':            return 'Short answer';
    default:                return 'Question';
  }
}

/**
 * Draw the question at position `cursor`.
 *
 * Wrapped in a try/catch as a last line of defence: if some entry manages to
 * break rendering despite every check above, the page drops that one question
 * and carries on to the next rather than dying with a blank screen.
 */
function renderCurrent() {
  if (cursor >= queue.length) {
    renderDone();
    return;
  }

  var item = queue[cursor];

  try {
    var entry = item.entry;

    /* --- progress line --- */
    elProgress.textContent = 'Question ' + (cursor + 1) + ' of ' + totalQuestions;

    /* --- context (small grey line) --- */
    var context = asText(entry.context);
    var pageTitle = asText(entry.pageTitle);

    if (context !== '' && pageTitle !== '') {
      elCardContext.textContent = pageTitle + ' — ' + context;
    } else if (context !== '') {
      elCardContext.textContent = context;
    } else if (pageTitle !== '') {
      elCardContext.textContent = pageTitle;
    } else {
      elCardContext.textContent = 'From your last form';
    }

    /* --- the question --- */
    elCardLabel.textContent = resolveLabel(entry);

    /* --- badges --- */
    clearChildren(elCardMeta);
    if (entry.required === true) {
      addBadge('Required', 'required');
    }
    addBadge(describeKind(entry.kind));

    /* --- source link --- */
    var url = resolveUrl(entry);
    if (url !== '') {
      elCardSource.href = url;
      elCardSource.textContent = shortenUrl(url);
      elCardSource.hidden = false;
      if (elCardSource.parentNode) {
        elCardSource.parentNode.hidden = false;
      }
    } else {
      /* No usable URL recorded. Blank the href so it cannot be clicked, and
       * hide the whole line so the card does not carry an empty gap. */
      elCardSource.removeAttribute('href');
      elCardSource.textContent = '';
      if (elCardSource.parentNode) {
        elCardSource.parentNode.hidden = true;
      }
    }

    /* --- the answer control(s) --- */
    currentAnswerable = buildAnswerControls(entry);
    elBtnSave.disabled = !currentAnswerable;

    setError('');

    /* --- reveal the card --- */
    elDone.hidden = true;
    elCard.hidden = false;

    /* Put the cursor in the box so he can just start typing. Guarded because a
     * file-upload card has nothing focusable. */
    var firstControl = elAnswerArea.querySelector('textarea, input');
    if (firstControl) {
      firstControl.focus();
    }
  } catch (error) {
    logWarning('could not render a pending question, skipping it:', error);
    /* Take it out of storage too, otherwise it jams the queue on every visit. */
    removeEntryFromStorage(item.signature);
    cursor = cursor + 1;
    renderCurrent();
  }
}

/**
 * The end-of-queue summary.
 */
function renderDone() {
  elCard.hidden = true;
  elProgress.textContent = '';

  if (totalQuestions === 0) {
    elDoneTitle.textContent = 'Nothing to answer right now.';
    elDoneBody.textContent =
      'This page lists the boxes the extension could not fill on its own. ' +
      'Run a fill on a job application form and anything it gets stuck on will show up here.';
    elDone.hidden = false;
    return;
  }

  /* --- headline: what he actually taught it --- */
  if (learnedCount === 0) {
    elDoneTitle.textContent = 'No new answers this time.';
  } else if (learnedCount === 1) {
    elDoneTitle.textContent = 'Learned 1 new answer. It will fill automatically next time.';
  } else {
    elDoneTitle.textContent =
      'Learned ' + learnedCount + ' new answers. They will fill automatically next time.';
  }

  /* --- second line: the leftovers, only mentioned when there are any --- */
  var extras = [];
  if (skippedCount === 1) {
    extras.push('1 question was skipped and will be asked again');
  } else if (skippedCount > 1) {
    extras.push(skippedCount + ' questions were skipped and will be asked again');
  }

  if (neverCount === 1) {
    extras.push('1 question was silenced for good');
  } else if (neverCount > 1) {
    extras.push(neverCount + ' questions were silenced for good');
  }

  elDoneBody.textContent = extras.length > 0 ? (extras.join('. ') + '.') : '';

  elDone.hidden = false;
  elBtnClose.focus();
}

/**
 * Show a fatal problem instead of the queue. Used when the page cannot do its
 * job at all — for example lib/knowledge.js failed to load, in which case an
 * answered question would silently go nowhere and he would type it all again
 * tomorrow. Better to say so.
 */
function renderFatal(message) {
  elCard.hidden = true;
  elDone.hidden = true;
  elProgress.textContent = '';

  elFatal.textContent = message;
  elFatal.hidden = false;
}


/* ------------------------------------------------------------------------- *
 * 10. Moving through the queue.
 * ------------------------------------------------------------------------- */

/**
 * Take the current question out of storage and draw the next one.
 *
 * Storage is trimmed BEFORE the screen moves on, so if he closes the tab in
 * that same instant the worst case is a question that stays in the queue and
 * gets asked once more — never a lost answer.
 */
async function advance(signature) {
  await removeEntryFromStorage(signature);
  cursor = cursor + 1;
  renderCurrent();
}

/** "Save & next". */
async function onSave() {
  if (busy || cursor >= queue.length) {
    return;
  }

  var item = queue[cursor];
  var answer = null;

  try {
    answer = readCurrentAnswer();
  } catch (error) {
    logWarning('could not read the answer controls:', error);
    answer = null;
  }

  if (answer === null || asText(answer) === '') {
    setError('Type or pick an answer first — or press "Skip this one".');
    return;
  }

  busy = true;
  setBusyUi(true);

  var stored = await rememberAnswer(item.entry, answer);

  if (!stored) {
    busy = false;
    setBusyUi(false);
    setError('That could not be saved, so the question is being kept. Check the console for details.');
    return;
  }

  learnedCount = learnedCount + 1;
  await advance(item.signature);

  busy = false;
  setBusyUi(false);
}

/** "Skip this one" — no answer recorded, so it will be asked again next time. */
async function onSkip() {
  if (busy || cursor >= queue.length) {
    return;
  }

  var item = queue[cursor];

  busy = true;
  setBusyUi(true);

  /* The entry leaves the pending queue but NOTHING goes into the knowledge
   * store. The next fill run that meets this field will not find an answer and
   * will queue it again — which is exactly what "skip" should mean. */
  skippedCount = skippedCount + 1;
  await advance(item.signature);

  busy = false;
  setBusyUi(false);
}

/** "Never ask this again" — writes the tombstone so it is not re-queued. */
async function onNever() {
  if (busy || cursor >= queue.length) {
    return;
  }

  var item = queue[cursor];

  var confirmed = window.confirm(
    'Never ask about "' + resolveLabel(item.entry) + '" again?\n\n' +
    'The extension will leave that box alone from now on instead of asking you. ' +
    'You can undo this later by editing the profile in Settings.'
  );
  if (!confirmed) {
    return;
  }

  busy = true;
  setBusyUi(true);

  var stored = await rememberNeverAsk(item.entry);

  if (!stored) {
    busy = false;
    setBusyUi(false);
    setError('That could not be saved, so the question is being kept. Check the console for details.');
    return;
  }

  neverCount = neverCount + 1;
  await advance(item.signature);

  busy = false;
  setBusyUi(false);
}

/**
 * Grey the buttons out while a storage write is in flight.
 *
 * Note the Save button is NOT simply re-enabled afterwards: a file-upload card
 * has nothing to save, so it goes back to whatever currentAnswerable says.
 */
function setBusyUi(isBusy) {
  elBtnSave.disabled = isBusy || !currentAnswerable;
  elBtnSkip.disabled = isBusy;
  elBtnNever.disabled = isBusy;
}


/* ------------------------------------------------------------------------- *
 * 11. Wiring.
 * ------------------------------------------------------------------------- */

elBtnSave.addEventListener('click', onSave);
elBtnSkip.addEventListener('click', onSkip);
elBtnNever.addEventListener('click', onNever);

elBtnClose.addEventListener('click', function () {
  /* window.close() works here because the tab was opened by the extension
   * itself. If Chrome ever refuses, he can just close the tab by hand. */
  window.close();
});

/* Ctrl+Enter / Cmd+Enter saves. Plain Enter is left alone so it still inserts a
 * newline in a long answer. */
document.addEventListener('keydown', function (event) {
  var isSaveCombo = event.key === 'Enter' && (event.ctrlKey || event.metaKey);
  if (isSaveCombo) {
    event.preventDefault();
    onSave();
  }
});


/* ------------------------------------------------------------------------- *
 * 12. Startup.
 *
 *     Order matters: the knowledge store has to be loaded BEFORE the first card
 *     appears, because he could answer and hit Save within a second of the page
 *     opening and remember() must be ready for it.
 * ------------------------------------------------------------------------- */

async function start() {
  /* Hard requirement. Without it, answers would vanish. */
  if (!knowledgeIsUsable()) {
    renderFatal(
      'lib/knowledge.js did not load, so answers could not be saved. ' +
      'Check that the file exists next to ask.html and that ask.html loads it ' +
      'before ask.js, then reload this page.'
    );
    logWarning('AF.knowledge.remember is missing — refusing to ask questions that cannot be stored.');
    return;
  }

  try {
    await knowledgeLoad();
  } catch (error) {
    /* A failed load is survivable: remember() may still work and will simply be
     * starting from an empty store. Log it, warn nobody, carry on. */
    logWarning('AF.knowledge.load() failed, continuing anyway:', error);
  }

  queue = await loadQueue();
  totalQuestions = queue.length;
  cursor = 0;

  renderCurrent();   /* renders the summary card when the queue is empty */
}

/* Kick everything off. The .catch is the outermost safety net: an async
 * function that rejects with nobody listening produces a silent dead page, and
 * a dead page with no explanation is the one failure mode he cannot debug. */
start().catch(function (error) {
  logWarning('the questions page failed to start:', error);
  renderFatal('Something went wrong opening your questions. Details are in the console (Ctrl+Shift+J).');
});


/* ------------------------------------------------------------------------- *
 * 13. What this file publishes on AF.
 *
 *     Only for debugging from the DevTools console on this page, and so that a
 *     future file can reuse the tombstone marker instead of re-typing the
 *     string. Nothing else in the extension needs to call into this page.
 * ------------------------------------------------------------------------- */

AF.ask = {
  /* Storage key holding the queue. */
  PENDING_KEY: KEY_PENDING,

  /* The "never ask this again" marker actually in use (knowledge.js's own
   * constant when it has one, ours otherwise). */
  NEVER_ANSWER: neverAskMarker(),

  /* Read and clean the queue without rendering:  await AF.ask.loadQueue() */
  loadQueue: loadQueue,

  /* The identity string used to match a question inside the stored array. */
  signatureOf: makeSignature,

  /* The heading text this page would show for a given field. */
  labelOf: resolveLabel
};
