/*
 * options.js — the profile editor behind "Edit profile & settings".
 *
 * Three things are edited on this page, and each is stored under its own key in
 * chrome.storage.local:
 *
 *   'profile'            an OBJECT (the parsed profile, shape defined by lib/profile.js)
 *   'bridgeUrl'          a STRING, default 'http://localhost:3111'
 *   'extraInstructions'  a STRING, appended verbatim to the AI prompt (may be empty)
 *
 * chrome.storage.local stores real JavaScript values, not strings — it serialises
 * for us. So 'profile' goes in as an object; the textarea is only a text VIEW of
 * that object. Think of the textarea as a JSON editor over a stored POJO.
 *
 * There is a FOURTH thing on this page that is not edited as text: the table of
 * LEARNED ANSWERS. Those live under the storage key 'knowledge', they are owned
 * entirely by lib/knowledge.js, and this page only reads them and offers to
 * forget them. Nothing about that table goes through the Save button — Forget
 * and "Clear all" take effect immediately.
 *
 * options.html loads lib/profile.js and lib/knowledge.js before this file, so
 * AF.DEFAULT_PROFILE and AF.knowledge are already defined by the time anything
 * below runs.
 */

/* Same defensive namespace line used everywhere else. lib/profile.js has already
 * created AF; this just guarantees the variable exists even if that file failed. */
var AF = (globalThis.AF = globalThis.AF || {});


/* ------------------------------------------------------------------------- *
 * 1. Constants.
 * ------------------------------------------------------------------------- */

/* Storage keys, written once here so a typo cannot drift between functions. */
var KEY_PROFILE      = 'profile';
var KEY_BRIDGE_URL   = 'bridgeUrl';
var KEY_INSTRUCTIONS = 'extraInstructions';

/* Used when the user has never set a bridge URL. */
var DEFAULT_BRIDGE_URL = 'http://localhost:3111';

/* Indent width for the pretty-printed JSON in the textarea. */
var JSON_INDENT = 2;


/* ------------------------------------------------------------------------- *
 * 2. Page elements.
 * ------------------------------------------------------------------------- */

var elProfileText      = document.getElementById('profileText');
var elBridgeUrlInput   = document.getElementById('bridgeUrlInput');
var elInstructionsText = document.getElementById('instructionsText');

var elBtnSave  = document.getElementById('btnSave');
var elBtnReset = document.getElementById('btnReset');

var elMessage = document.getElementById('message');

/* --- the "Learned answers" section --- */
var elLearnedBody      = document.getElementById('learnedBody');
var elLearnedEmpty     = document.getElementById('learnedEmpty');
var elLearnedTableWrap = document.getElementById('learnedTableWrap');
var elBtnClearLearned  = document.getElementById('btnClearLearned');
var elLearnedMessage   = document.getElementById('learnedMessage');

/* How much of a long answer to show in the table. The FULL answer is still
 * what gets typed into forms; this only shortens the display so one cover
 * letter cannot make the table a mile tall. */
var ANSWER_PREVIEW_CHARS = 160;


/* ------------------------------------------------------------------------- *
 * 3. Helpers.
 * ------------------------------------------------------------------------- */

/**
 * Show a one-line status under the buttons.
 *
 * @param {String} text  what to say
 * @param {String} kind  'ok' (green) | 'error' (red) | 'info' (grey)
 */
function showMessage(text, kind) {
  elMessage.textContent = text;
  elMessage.className = kind;
}

/**
 * The bundled fallback profile, as a fresh copy.
 *
 * A copy matters: if we handed out the real AF.DEFAULT_PROFILE object and some
 * later code mutated it, the "default" would quietly stop being the default for
 * the rest of the page's life. JSON round-tripping is the plainest deep copy
 * available and the profile is pure data, so it is safe here.
 */
function getBundledDefaultProfile() {
  if (!AF.DEFAULT_PROFILE || typeof AF.DEFAULT_PROFILE !== 'object') {
    /* lib/profile.js missing or broken. Do not crash the settings page — an empty
     * object still lets the user paste a profile in by hand. */
    return {};
  }
  return JSON.parse(JSON.stringify(AF.DEFAULT_PROFILE));
}

/**
 * Render a profile object into the textarea as readable, indented JSON.
 */
function writeProfileToTextarea(profileObject) {
  elProfileText.value = JSON.stringify(profileObject, null, JSON_INDENT);
  elProfileText.classList.remove('invalid');
}

/**
 * Try to parse whatever is currently in the textarea.
 *
 * Returns an object shaped like a tiny Result type rather than throwing, because
 * the caller always wants to show the parse error rather than blow up:
 *
 *   { ok: true,  value: <parsed object> }
 *   { ok: false, error: '<message from JSON.parse>' }
 */
function parseProfileTextarea() {
  var raw = elProfileText.value;

  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, error: 'The profile is empty. Paste JSON, or click "Reset to bundled default".' };
  }

  var parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (parseError) {
    /* parseError.message is genuinely useful here — modern Chrome reports the
     * offending position, e.g. 'Unexpected token } in JSON at position 412'. */
    return { ok: false, error: parseError.message };
  }

  /* A bare string, number, or array parses fine but is not a profile. */
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'The profile must be a JSON object, i.e. it must start with { and end with }.' };
  }

  return { ok: true, value: parsed };
}

/**
 * Tidy up a bridge URL: trim it and drop any trailing slash, so callers can
 * safely do bridgeUrl + '/answer' without producing a double slash.
 * An empty box means "use the default".
 */
function normaliseBridgeUrl(raw) {
  var url = (typeof raw === 'string') ? raw.trim() : '';

  if (url === '') {
    return DEFAULT_BRIDGE_URL;
  }

  while (url.length > 1 && url.charAt(url.length - 1) === '/') {
    url = url.substring(0, url.length - 1);
  }
  return url;
}


/* ------------------------------------------------------------------------- *
 * 4. Load everything when the page opens.
 * ------------------------------------------------------------------------- */

function loadSettings() {
  chrome.storage.local.get([KEY_PROFILE, KEY_BRIDGE_URL, KEY_INSTRUCTIONS], function (stored) {
    /* Storage errors are rare but must be read inside the callback or Chrome
     * logs an unchecked-error warning. */
    if (chrome.runtime.lastError) {
      showMessage('Could not read saved settings: ' + chrome.runtime.lastError.message, 'error');
      writeProfileToTextarea(getBundledDefaultProfile());
      elBridgeUrlInput.value = DEFAULT_BRIDGE_URL;
      elInstructionsText.value = '';
      return;
    }

    /* --- profile --- */
    var savedProfile = stored ? stored[KEY_PROFILE] : undefined;
    if (savedProfile && typeof savedProfile === 'object' && !Array.isArray(savedProfile)) {
      writeProfileToTextarea(savedProfile);
      showMessage('Loaded your saved profile.', 'info');
    } else {
      /* Nothing saved yet (fresh install), so show the bundled default. It is
       * NOT written to storage here — the user has to press Save. */
      writeProfileToTextarea(getBundledDefaultProfile());
      showMessage('No saved profile yet — showing the bundled default. Press Save to keep it.', 'info');
    }

    /* --- bridge URL --- */
    var savedUrl = stored ? stored[KEY_BRIDGE_URL] : undefined;
    elBridgeUrlInput.value = (typeof savedUrl === 'string' && savedUrl.trim() !== '')
      ? savedUrl
      : DEFAULT_BRIDGE_URL;

    /* --- extra instructions --- */
    var savedInstructions = stored ? stored[KEY_INSTRUCTIONS] : undefined;
    elInstructionsText.value = (typeof savedInstructions === 'string') ? savedInstructions : '';
  });
}


/* ------------------------------------------------------------------------- *
 * 5. Save.
 * ------------------------------------------------------------------------- */

function saveSettings() {
  /* Validate the JSON FIRST. Nothing at all is written if it does not parse —
   * a half-saved settings page is worse than an unsaved one. */
  var result = parseProfileTextarea();

  if (!result.ok) {
    elProfileText.classList.add('invalid');
    showMessage('Not saved — the profile is not valid JSON. ' + result.error, 'error');
    return;
  }

  elProfileText.classList.remove('invalid');

  var bridgeUrl = normaliseBridgeUrl(elBridgeUrlInput.value);
  /* Reflect the cleaned-up value back so the user sees exactly what was stored. */
  elBridgeUrlInput.value = bridgeUrl;

  var instructions = (typeof elInstructionsText.value === 'string')
    ? elInstructionsText.value.trim()
    : '';

  var toStore = {};
  toStore[KEY_PROFILE]      = result.value;
  toStore[KEY_BRIDGE_URL]   = bridgeUrl;
  toStore[KEY_INSTRUCTIONS] = instructions;

  chrome.storage.local.set(toStore, function () {
    if (chrome.runtime.lastError) {
      showMessage('Save failed: ' + chrome.runtime.lastError.message, 'error');
      return;
    }

    /* Re-render the textarea from the parsed object. This normalises the user's
     * formatting (indentation, key order stays as written) and is instant proof
     * that what got stored is what they see. */
    writeProfileToTextarea(result.value);

    showMessage('Saved. New fills will use these settings immediately.', 'ok');
  });
}


/* ------------------------------------------------------------------------- *
 * 6. Reset.
 * ------------------------------------------------------------------------- */

function resetToDefault() {
  /* Destructive, so ask first. */
  var confirmed = window.confirm(
    'Replace the profile in this editor with the bundled default?\n\n' +
    'Your saved profile is not touched until you press Save.'
  );
  if (!confirmed) {
    return;
  }

  writeProfileToTextarea(getBundledDefaultProfile());
  elBridgeUrlInput.value = DEFAULT_BRIDGE_URL;
  elInstructionsText.value = '';

  showMessage('Bundled default loaded into the editor. Press Save to keep it.', 'info');
}


/* ------------------------------------------------------------------------- *
 * 7. Live validation while typing.
 * ------------------------------------------------------------------------- */

/* Give immediate feedback on the JSON without waiting for a Save click. This only
 * paints the border and the message; it never writes to storage. */
elProfileText.addEventListener('input', function () {
  var result = parseProfileTextarea();

  if (result.ok) {
    elProfileText.classList.remove('invalid');
    showMessage('Valid JSON. Press Save to store it.', 'info');
  } else {
    elProfileText.classList.add('invalid');
    showMessage('Invalid JSON: ' + result.error, 'error');
  }
});


/* ------------------------------------------------------------------------- *
 * 7b. The "Learned answers" table.
 *
 *     Everything here goes through the lib/knowledge.js public API — all(),
 *     forget() — and never reaches into chrome.storage.local['knowledge']
 *     directly. That module owns the stored shape, does its own repair of a
 *     half-written store, and keeps an in-memory cache that other open tabs
 *     rely on; writing the key from here behind its back would desynchronise
 *     all of that.
 * ------------------------------------------------------------------------- */

/**
 * One-line status under the Clear button. Separate from showMessage(), which
 * belongs to the Save/Reset controls further up the page — mixing them made
 * "Saved." appear as the answer to clicking Forget.
 *
 * @param {String} text
 * @param {String} kind  'ok' | 'error' | 'info'
 */
function showLearnedMessage(text, kind) {
  elLearnedMessage.textContent = text;
  elLearnedMessage.className = kind;
}

/** Did lib/knowledge.js actually load on this page? */
function knowledgeReady() {
  return !!(AF.knowledge && typeof AF.knowledge.all === 'function');
}

/**
 * Turn a stored answer into something readable in a table cell.
 *
 * An answer is not always a string: lib/knowledge.js stores booleans (a tick
 * box), numbers (years of experience), and arrays (a multi-select). String()
 * on an array gives "a,b,c" with no spaces, which reads badly, so arrays are
 * joined explicitly.
 */
function formatLearnedAnswer(value) {
  if (value === null || value === undefined) {
    return '(blank — you chose not to answer)';
  }
  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }
  if (Array.isArray(value)) {
    return value.join(', ');
  }

  var text = String(value);

  if (text.trim() === '') {
    return '(blank — you chose not to answer)';
  }

  /* The tombstone written by "Never ask this again" in ask.html. Showing the
   * raw marker string would be baffling; showing what it MEANS is the point of
   * this table. */
  if (text === '__af_never_ask__' ||
      (typeof AF.knowledge === 'object' && AF.knowledge &&
       text === AF.knowledge.NEVER_ANSWER)) {
    return '(silenced — you asked never to be shown this again)';
  }

  if (text.length > ANSWER_PREVIEW_CHARS) {
    return text.substring(0, ANSWER_PREVIEW_CHARS) + '…';
  }
  return text;
}

/**
 * Build one <tr>. Every piece of text goes in with textContent, never
 * innerHTML: the question wording was scraped off a third-party job site and
 * must be treated as text, not as markup.
 */
function makeLearnedRow(record) {
  var row = document.createElement('tr');

  var questionCell = document.createElement('td');
  questionCell.className = 'question';
  questionCell.textContent = (typeof record.question === 'string' && record.question !== '')
    ? record.question
    : record.qKey;
  /* The full wording on hover, in case the table clipped it. */
  questionCell.title = questionCell.textContent;
  row.appendChild(questionCell);

  var answerCell = document.createElement('td');
  answerCell.className = 'answer';
  answerCell.textContent = formatLearnedAnswer(record.answer);
  row.appendChild(answerCell);

  var usesCell = document.createElement('td');
  usesCell.className = 'uses';
  usesCell.textContent = String(record.useCount || 0);
  row.appendChild(usesCell);

  var actionCell = document.createElement('td');
  actionCell.className = 'act';

  var forgetButton = document.createElement('button');
  forgetButton.type = 'button';
  forgetButton.className = 'btn mini';
  forgetButton.textContent = 'Forget';
  forgetButton.title = 'Delete this answer. The next form that asks it will put ' +
    'the question back on your list.';

  /* The closure captures this record's key, so the handler needs no lookup and
   * cannot go wrong if the table is re-sorted underneath it. */
  forgetButton.addEventListener('click', function () {
    forgetOneAnswer(record.qKey, forgetButton);
  });

  actionCell.appendChild(forgetButton);
  row.appendChild(actionCell);

  return row;
}

/**
 * Draw the whole table from scratch.
 *
 * Redrawing wholesale rather than patching rows is deliberate: the list is
 * short, and a full redraw can never drift out of step with storage.
 */
function renderLearnedAnswers() {
  if (!knowledgeReady()) {
    elLearnedTableWrap.style.display = 'none';
    elLearnedEmpty.style.display = 'block';
    elLearnedEmpty.textContent =
      'lib/knowledge.js did not load, so learned answers cannot be shown. ' +
      'Reload the extension at chrome://extensions.';
    elBtnClearLearned.disabled = true;
    return;
  }

  AF.knowledge.all().then(function (records) {
    /* Empty the body without innerHTML. */
    elLearnedBody.textContent = '';

    if (!Array.isArray(records) || records.length === 0) {
      elLearnedTableWrap.style.display = 'none';
      elLearnedEmpty.style.display = 'block';
      elLearnedEmpty.textContent =
        'Nothing learned yet. When a form asks something the extension cannot answer, ' +
        'it collects the question; answer it once from the popup and it will appear here.';
      elBtnClearLearned.disabled = true;
      return;
    }

    var i;
    for (i = 0; i < records.length; i++) {
      elLearnedBody.appendChild(makeLearnedRow(records[i]));
    }

    elLearnedEmpty.style.display = 'none';
    elLearnedTableWrap.style.display = 'block';
    elBtnClearLearned.disabled = false;
  }, function (error) {
    elLearnedTableWrap.style.display = 'none';
    elLearnedEmpty.style.display = 'block';
    elLearnedEmpty.textContent = 'Could not read the learned answers: ' + error;
    elBtnClearLearned.disabled = true;
  });
}

/**
 * Delete one answer.
 *
 * No confirm() here on purpose: this is a single, cheap, obviously-labelled
 * action, and the worst case is being asked that one question again. The
 * "Clear all" button IS guarded, because that one cannot be walked back.
 */
function forgetOneAnswer(qKey, button) {
  button.disabled = true;

  AF.knowledge.forget(qKey).then(function (removed) {
    if (removed) {
      showLearnedMessage('Forgotten. You will be asked that question again next time.', 'ok');
    } else {
      showLearnedMessage('That answer was already gone.', 'info');
    }
    renderLearnedAnswers();
  }, function (error) {
    button.disabled = false;
    showLearnedMessage('Could not forget it: ' + error, 'error');
  });
}

/**
 * Delete every answer, one at a time.
 *
 * WHY A LOOP AND NOT ONE BIG WRITE: forget() is the only public way to remove
 * an answer, and going around it — writing chrome.storage.local['knowledge']
 * from here — would mean this file had to know the stored shape, would wipe the
 * chatbot's fact log along with the answers, and would leave the module's cache
 * holding rows that no longer exist. The calls are chained one after another
 * rather than fired all at once so the store's own read-modify-write ordering
 * is respected. A few hundred sequential writes still finish in well under a
 * second, and the button is disabled throughout.
 */
function clearAllLearnedAnswers() {
  if (!knowledgeReady()) {
    return;
  }

  elBtnClearLearned.disabled = true;
  showLearnedMessage('Working…', 'info');

  AF.knowledge.all().then(function (records) {
    if (!Array.isArray(records) || records.length === 0) {
      showLearnedMessage('There was nothing to clear.', 'info');
      renderLearnedAnswers();
      return null;
    }

    /* Destructive and unrecoverable, so ask first — and say how many. */
    var confirmed = window.confirm(
      'Delete all ' + records.length + ' learned answer' +
      (records.length === 1 ? '' : 's') + '?\n\n' +
      'The extension will start asking you these questions again from scratch. ' +
      'Your profile and the chatbot history are not touched.'
    );

    if (!confirmed) {
      showLearnedMessage('Nothing was deleted.', 'info');
      elBtnClearLearned.disabled = false;
      return null;
    }

    /* Build the chain: forget the first, then the second, and so on. Each
     * .then() starts the next call only after the previous one has finished. */
    var chain = Promise.resolve();
    var i;

    for (i = 0; i < records.length; i++) {
      /* The extra function wrapper is what gives each step its OWN copy of the
       * key. Without it, `var i` would have reached records.length by the time
       * any of these callbacks ran and every step would delete the same one. */
      chain = chain.then(makeForgetStep(records[i].qKey));
    }

    return chain.then(function () {
      showLearnedMessage('Cleared ' + records.length + ' learned answer' +
        (records.length === 1 ? '' : 's') + '.', 'ok');
      renderLearnedAnswers();
    });
  }).catch(function (error) {
    showLearnedMessage('Could not clear the learned answers: ' + error, 'error');
    elBtnClearLearned.disabled = false;
    renderLearnedAnswers();
  });
}

/** One link in the chain built by clearAllLearnedAnswers. */
function makeForgetStep(qKey) {
  return function () {
    return AF.knowledge.forget(qKey);
  };
}


/* ------------------------------------------------------------------------- *
 * 8. Wiring and startup.
 * ------------------------------------------------------------------------- */

elBtnSave.addEventListener('click', saveSettings);
elBtnReset.addEventListener('click', resetToDefault);
elBtnClearLearned.addEventListener('click', clearAllLearnedAnswers);

/* Keep the table honest while this tab is open.
 *
 * He can be answering questions in ask.html, or teaching the chatbot, in
 * another tab at the same time. chrome.storage fires this event in every
 * extension page when a key changes, so the table redraws itself instead of
 * showing a stale list until he presses F5. */
try {
  chrome.storage.onChanged.addListener(function (changes, areaName) {
    if (areaName !== 'local' || !changes) {
      return;
    }
    /* 'knowledge' is the key lib/knowledge.js owns. Ignore everything else —
     * our own Save writes 'profile' and must not trigger a redraw. */
    if (changes.knowledge) {
      renderLearnedAnswers();
    }
  });
} catch (storageListenerError) {
  /* Storage events unavailable. The table simply will not live-update; every
   * other part of this page still works. */
}

/* Ctrl+S / Cmd+S saves, because everyone tries it in a big textarea. */
document.addEventListener('keydown', function (event) {
  var isSaveCombo = (event.key === 's' || event.key === 'S') && (event.ctrlKey || event.metaKey);
  if (isSaveCombo) {
    event.preventDefault();     /* stop the browser's "save this page" dialog */
    saveSettings();
  }
});

/* Populate the form as soon as the page opens. */
loadSettings();

/* ...and the learned-answer table with it. This is a separate storage key and
 * a separate read, so it is a separate call. */
renderLearnedAnswers();
