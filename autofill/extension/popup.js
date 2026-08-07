/*
 * popup.js — the little window that appears when you click the toolbar icon.
 *
 * This file is NOT a content script. It runs in its own page, inside the popup.
 * It cannot touch the job application page directly. It can only:
 *
 *   1. ask the CONTENT SCRIPT (content.js, running inside the web page) to do work,
 *      using chrome.tabs.sendMessage(...)
 *   2. ask the SERVICE WORKER (background.js) whether the local AI bridge is up,
 *      using chrome.runtime.sendMessage(...)
 *
 * Mental model for a Spring developer: the popup is a thin controller. It sends a
 * request, waits for a response DTO, and renders it. All the real work happens
 * elsewhere.
 *
 * Message types this file SENDS to the content script:
 *   'FILL_ALL'            -> profile matching, then AI for the leftovers
 *   'FILL_DETERMINISTIC'  -> profile matching only, never calls the bridge
 *   'UNDO'                -> restore the values captured before the last fill
 *   'SCAN'                -> just dump the field inventory to the page console
 *
 * Message type this file SENDS to the service worker:
 *   'BRIDGE_PING'         -> { online: true|false, detail: String }
 *
 * Response shape this file EXPECTS back from the content script (all keys optional,
 * missing numbers are treated as 0 so a partial answer still renders):
 *   {
 *     ok:            Boolean,        // false means "I tried and something went wrong"
 *     error:         String,         // human-readable reason when ok === false
 *     deterministic: Number,         // fields filled from the profile
 *     learned:       Number,         // fields filled from an answer HE taught the extension
 *     ai:            Number,         // fields filled using the AI bridge
 *     skipped:       Number,         // fields deliberately left alone
 *     pending:       Number,         // questions now waiting in 'pendingQuestions'
 *     manual:        Array,          // file-upload fields the user must handle by hand;
 *                                    // either plain strings or Field-ish objects
 *     warning:       String          // one non-fatal problem ('' when the run was clean),
 *                                    // e.g. "AI step skipped: the bridge is not running".
 *                                    // Rendered on its own amber line — it must never go
 *                                    // in `manual`, which claims to list file uploads.
 *   }
 *
 * TWO EXTENSION PAGES THIS POPUP OPENS
 *   ask.html   the questions the extension could not answer. He answers each one
 *              once; lib/knowledge.js remembers it and every future form that
 *              asks the same thing fills itself.
 *   chat.html  the "teach it something" chat box — plain sentences like "I moved
 *              to Pune" that update the stored profile.
 *
 *   Both are opened with chrome.tabs.create + chrome.runtime.getURL. They are
 *   extension pages, so they do NOT need a web_accessible_resources entry in the
 *   manifest: that setting only governs pages on the open web reaching in.
 */

/* Namespace guard, kept identical across every file in this extension even though
 * the popup does not currently hang anything off it. Consistency beats cleverness. */
var AF = (globalThis.AF = globalThis.AF || {});


/* ------------------------------------------------------------------------- *
 * 1. Grab the page elements once, up front.
 * ------------------------------------------------------------------------- */

var elBridgeDot  = document.getElementById('bridgeDot');
var elBridgeText = document.getElementById('bridgeText');

var elBtnFillAll = document.getElementById('btnFillAll');
var elBtnFillDet = document.getElementById('btnFillDet');
var elBtnUndo    = document.getElementById('btnUndo');
var elBtnScan    = document.getElementById('btnScan');
var elBtnOptions = document.getElementById('btnOptions');
var elBtnAsk     = document.getElementById('btnAsk');
var elBtnTeach   = document.getElementById('btnTeach');

var elResults      = document.getElementById('results');
var elResultMsg    = document.getElementById('resultMessage');
var elStatBlock    = document.getElementById('statBlock');
var elNumDet       = document.getElementById('numDet');
var elNumLearned   = document.getElementById('numLearned');
var elNumAi        = document.getElementById('numAi');
var elNumSkip      = document.getElementById('numSkip');
var elStatPending  = document.getElementById('statPending');
var elNumPending   = document.getElementById('numPending');
var elManualBlock  = document.getElementById('manualBlock');
var elManualList   = document.getElementById('manualList');
var elWarningMsg   = document.getElementById('warningMessage');

/* All the buttons that trigger work in the page. Handy for enabling/disabling
 * them together while a run is in progress.
 *
 * btnAsk and btnTeach are deliberately NOT in this list: they only open a tab,
 * they do not touch the form, and there is no reason to lock him out of them
 * while a fill is in flight. */
var ACTION_BUTTONS = [elBtnFillAll, elBtnFillDet, elBtnUndo, elBtnScan];

/* The chrome.storage.local key content.js parks unanswered questions in.
 * Spelled the same in content.js (PENDING_KEY) and ask.js (KEY_PENDING). */
var PENDING_KEY = 'pendingQuestions';


/* ------------------------------------------------------------------------- *
 * 2. Small helpers.
 * ------------------------------------------------------------------------- */

/**
 * Turn anything into a non-negative whole number, defaulting to 0.
 * The content script may legitimately omit a counter; we must not render "undefined".
 */
function asCount(maybeNumber) {
  var n = Number(maybeNumber);
  if (isNaN(n) || n < 0) {
    return 0;
  }
  return Math.round(n);
}

/**
 * Produce a readable one-line description of a file-upload field.
 * Accepts either a plain string or a Field-shaped object (see the data contract:
 * label / ariaLabel / placeholder / name / id).
 */
function describeManualField(item) {
  if (typeof item === 'string') {
    return item;
  }
  if (!item || typeof item !== 'object') {
    return 'Unnamed upload field';
  }
  /* Try each identifying property in order of how human-friendly it is. */
  var candidates = [item.label, item.ariaLabel, item.placeholder, item.name, item.id];
  for (var i = 0; i < candidates.length; i++) {
    var text = candidates[i];
    if (typeof text === 'string' && text.trim() !== '') {
      return text.trim();
    }
  }
  return 'Unnamed upload field';
}

/**
 * Disable or re-enable every action button. Called around each run so the user
 * cannot fire two fills at the same time.
 */
function setButtonsEnabled(enabled) {
  for (var i = 0; i < ACTION_BUTTONS.length; i++) {
    ACTION_BUTTONS[i].disabled = !enabled;
  }
}

/**
 * Show the results panel with a plain message and NO number rows.
 * Used for errors and for "scan finished, look at the console".
 *
 * @param {String}  message  text to show
 * @param {Boolean} isError  true renders it in red
 */
function showMessageOnly(message, isError) {
  elResults.style.display = 'block';
  elResultMsg.textContent = message;
  elResultMsg.className = isError ? 'error' : '';
  elStatBlock.style.display = 'none';
  elManualBlock.style.display = 'none';
  showWarning('');
}

/**
 * Show (or hide) the single non-fatal warning line.
 * Pass '' to hide it. Kept separate from the file-upload list on purpose: a
 * bridge-is-offline message under a heading that says "Needs you (file
 * uploads)" reads as a file the user forgot to attach.
 *
 * @param {String} text
 */
function showWarning(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    elWarningMsg.textContent = '';
    elWarningMsg.style.display = 'none';
    return;
  }
  /* textContent, never innerHTML — the text can quote a page's own wording. */
  elWarningMsg.textContent = text.trim();
  elWarningMsg.style.display = 'block';
}

/**
 * Show the full results panel: headline, the counters, and the list of
 * file-upload fields that still need a human.
 */
function showRunResult(headline, response) {
  var det     = asCount(response.deterministic);
  var learned = asCount(response.learned);
  var ai      = asCount(response.ai);
  var skip    = asCount(response.skipped);
  var pending = asCount(response.pending);

  elResults.style.display = 'block';
  elResultMsg.textContent = headline;
  elResultMsg.className = '';

  elStatBlock.style.display = 'block';
  elNumDet.textContent     = String(det);
  elNumLearned.textContent = String(learned);
  elNumAi.textContent      = String(ai);
  elNumSkip.textContent    = String(skip);

  /* "Waiting for your answer" is only interesting when there IS something
   * waiting. A permanent "0" row would just be one more number to read past. */
  elNumPending.textContent = String(pending);
  elStatPending.style.display = (pending > 0) ? 'flex' : 'none';

  /* The badge above the fold has to agree with the row inside the panel, so
   * both are driven from the same number the content script just reported. */
  setPendingCount(pending);

  /* A run can succeed and still have something worth saying — most often
   * "the AI bridge is not running, so only the profile matches were filled". */
  showWarning(typeof response.warning === 'string' ? response.warning : '');

  /* Rebuild the manual-attention list from scratch every time. */
  elManualList.textContent = '';

  var manual = response.manual;
  if (!Array.isArray(manual)) {
    manual = [];
  }

  if (manual.length === 0) {
    elManualBlock.style.display = 'none';
    return;
  }

  for (var i = 0; i < manual.length; i++) {
    var li = document.createElement('li');
    /* textContent, never innerHTML: the text comes from the web page, so treating
     * it as markup would let a hostile page inject nodes into our popup. */
    li.textContent = describeManualField(manual[i]);
    elManualList.appendChild(li);
  }
  elManualBlock.style.display = 'block';
}


/* ------------------------------------------------------------------------- *
 * 2b. The "questions need your answer" badge, and the two extension pages.
 * ------------------------------------------------------------------------- */

/**
 * Paint the amber badge above the secondary buttons.
 *
 * Hidden entirely at zero. A badge that says "0 questions need your answer" is
 * not information, it is furniture.
 *
 * @param {Number} count
 */
function setPendingCount(count) {
  var n = asCount(count);

  if (n === 0) {
    elBtnAsk.style.display = 'none';
    return;
  }

  elBtnAsk.textContent = n === 1
    ? '1 question needs your answer'
    : n + ' questions need your answer';

  /* The stylesheet keeps this button at display:none until now — see the
   * #btnAsk rule in popup.html for why the `hidden` attribute would not work. */
  elBtnAsk.style.display = 'block';
}

/**
 * Read the real count straight out of storage.
 *
 * Called when the popup opens, and again after every action, so the badge is
 * right even when the last thing he did was answer questions in another tab.
 * chrome.storage.local is the single source of truth for the queue — never a
 * number cached in this page.
 */
function refreshPendingCount() {
  try {
    chrome.storage.local.get([PENDING_KEY], function (stored) {
      /* lastError must be read inside the callback or Chrome logs a warning. */
      if (chrome.runtime.lastError) {
        setPendingCount(0);
        return;
      }
      var list = (stored && Array.isArray(stored[PENDING_KEY])) ? stored[PENDING_KEY] : [];
      setPendingCount(list.length);
    });
  } catch (error) {
    /* Storage unavailable (the extension was reloaded under us). The badge
     * simply stays hidden; nothing else in the popup depends on it. */
    setPendingCount(0);
  }
}

/**
 * Open one of the extension's own pages in a new tab and close the popup.
 *
 * WHY A TAB AND NOT THE POPUP ITSELF: a Chrome popup is destroyed the moment
 * it loses focus. Typing a paragraph-long answer, or a chat message, inside a
 * window that vanishes when you glance at the form behind it is unusable.
 *
 * chrome.runtime.getURL turns 'ask.html' into the full
 * chrome-extension://<id>/ask.html URL. No web_accessible_resources entry is
 * needed: that manifest key is about letting WEB pages reach extension files,
 * and this call comes from the extension itself.
 *
 * @param {String} fileName  'ask.html' or 'chat.html'
 */
function openExtensionPage(fileName) {
  try {
    chrome.tabs.create({ url: chrome.runtime.getURL(fileName) });
    /* The popup has done its job. Closing it keeps the new tab in focus. */
    window.close();
  } catch (error) {
    showMessageOnly('Could not open ' + fileName + ': ' + error, true);
  }
}


/* ------------------------------------------------------------------------- *
 * 3. Talking to the content script.
 * ------------------------------------------------------------------------- */

/* Pages the extension is never allowed to touch. Trying anyway just produces a
 * confusing error, so we detect them and say something useful instead. */
function isRestrictedUrl(url) {
  if (typeof url !== 'string' || url === '') {
    return true;
  }
  var blockedPrefixes = [
    'chrome://',
    'chrome-extension://',
    'edge://',
    'about:',
    'devtools://',
    'view-source:',
    'https://chrome.google.com/webstore',
    'https://chromewebstore.google.com'
  ];
  for (var i = 0; i < blockedPrefixes.length; i++) {
    if (url.indexOf(blockedPrefixes[i]) === 0) {
      return true;
    }
  }
  return false;
}

/**
 * Find the tab the user is looking at, then post a message to its content script.
 *
 * Two failure modes matter and are both handled here rather than thrown:
 *
 *   a) The page is a restricted browser page — content scripts never run there.
 *   b) The page was already open before the extension was installed / reloaded.
 *      Chrome does NOT retro-inject content scripts into existing tabs, so nobody
 *      is listening and chrome.runtime.lastError is set to "Could not establish
 *      connection. Receiving end does not exist." The cure is a page reload.
 *
 * Note on frames: the content script runs in ALL frames (Greenhouse and Workday
 * embed their forms in iframes). chrome.tabs.sendMessage without a frameId
 * delivers to every frame, and the FIRST frame that answers wins. content.js is
 * expected to stay silent in frames that contain no fillable fields, so the frame
 * holding the real form is the one that replies. If every frame stays silent we
 * get the same lastError as case (b) and report it as "no form found here".
 *
 * @param {String}   messageType  one of FILL_ALL / FILL_DETERMINISTIC / UNDO / SCAN
 * @param {Function} onDone       called as onDone(errorStringOrNull, responseObject)
 */
function sendToContentScript(messageType, onDone) {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (!tabs || tabs.length === 0 || !tabs[0] || typeof tabs[0].id !== 'number') {
      onDone('No active tab found. Click into the application tab and try again.', null);
      return;
    }

    var tab = tabs[0];

    if (isRestrictedUrl(tab.url)) {
      onDone('This is a browser page, not an application form. Open the job form and try again.', null);
      return;
    }

    /* The message payload. Keeping it an object leaves room to add fields later
     * without breaking the receiver. */
    var message = { type: messageType };

    chrome.tabs.sendMessage(tab.id, message, function (response) {
      /* IMPORTANT: chrome.runtime.lastError must be read inside this callback.
       * If it is set and we ignore it, Chrome logs an unchecked-error warning. */
      if (chrome.runtime.lastError) {
        onDone('Reload the page and try again. (The extension is not running on this page yet.)', null);
        return;
      }

      if (!response || typeof response !== 'object') {
        /* Somebody answered but with nothing useful. */
        onDone('Reload the page and try again. (No usable answer from the page.)', null);
        return;
      }

      if (response.ok === false) {
        var reason = (typeof response.error === 'string' && response.error !== '')
          ? response.error
          : 'The page reported a problem.';
        onDone(reason, null);
        return;
      }

      onDone(null, response);
    });
  });
}

/**
 * Wire one button to one message type.
 *
 * @param {Element}  button           the button element
 * @param {String}   messageType      what to send
 * @param {String}   busyText         message shown while the run is in flight
 * @param {Function} renderSuccess    called as renderSuccess(response)
 */
function wireAction(button, messageType, busyText, renderSuccess) {
  button.addEventListener('click', function () {
    setButtonsEnabled(false);
    showMessageOnly(busyText, false);

    sendToContentScript(messageType, function (errorText, response) {
      setButtonsEnabled(true);

      if (errorText) {
        showMessageOnly(errorText, true);
      } else {
        renderSuccess(response);
      }

      /* Re-read the queue from storage after EVERY action, including the
       * failed ones. A fill adds questions; answering them in the other tab
       * removes them. Storage is the truth, so the badge is rebuilt from it
       * rather than from anything this page has been holding on to. */
      refreshPendingCount();
    });
  });
}


/* ------------------------------------------------------------------------- *
 * 4. Button wiring.
 * ------------------------------------------------------------------------- */

/* Primary: profile matching first, AI bridge for whatever is left over. */
wireAction(elBtnFillAll, 'FILL_ALL', 'Filling…', function (response) {
  showRunResult('Done.', response);
});

/* Secondary: profile matching only. Works with the bridge switched off. */
wireAction(elBtnFillDet, 'FILL_DETERMINISTIC', 'Filling (no AI)…', function (response) {
  showRunResult('Done — deterministic only.', response);
});

/* Undo: put everything back the way it was before the last fill. */
wireAction(elBtnUndo, 'UNDO', 'Undoing…', function (response) {
  /* AF.restore() returns a Boolean, so content.js may answer with { ok:true,
   * restored:true/false } and no counters. Handle both shapes. */
  if (response.restored === false) {
    showMessageOnly('Nothing to undo — no fill has run on this page yet.', false);
    return;
  }

  /* Some controls genuinely cannot be put back: a radio group that a strictly
   * controlled React form re-selects for itself, or a dropdown whose option
   * list was rebuilt after the fill. Saying "the form is back to its previous
   * values" when it is not is worse than saying nothing, because the user
   * then submits an answer the extension chose. */
  var failed = asCount(response.failedCount);
  if (failed > 0) {
    var names = Array.isArray(response.failedFields) ? response.failedFields : [];
    showMessageOnly('Undone, but ' + failed + ' field' + (failed === 1 ? '' : 's') +
      ' could not be put back — please check ' +
      (names.length > 0 ? names.join(', ') : 'the form') + ' yourself.', false);
    return;
  }

  showMessageOnly('Undone. The form is back to its previous values.', false);
});

/* Debug: dump the field inventory to the PAGE's console (right-click the form,
 * Inspect, Console tab — not this popup's console). */
wireAction(elBtnScan, 'SCAN', 'Scanning…', function (response) {
  var count = asCount(response.count !== undefined ? response.count : response.total);
  showMessageOnly(
    'Scanned ' + count + ' field' + (count === 1 ? '' : 's') +
    '. Full inventory printed to the page console (F12 > Console).',
    false
  );
});

/* The amber badge: the list of questions the extension could not answer.
 * He answers each one once and lib/knowledge.js remembers it for ever. */
elBtnAsk.addEventListener('click', function () {
  openExtensionPage('ask.html');
});

/* The chatbot: "my address is now Pune", "I have 3 years of experience now". */
elBtnTeach.addEventListener('click', function () {
  openExtensionPage('chat.html');
});

/* Footer link: open the profile editor. */
elBtnOptions.addEventListener('click', function () {
  /* openOptionsPage is the supported way; it focuses an already-open tab if there
   * is one instead of opening a second copy. */
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  } else {
    window.open(chrome.runtime.getURL('options.html'));
  }
});


/* ------------------------------------------------------------------------- *
 * 5. Bridge status, checked once when the popup opens.
 * ------------------------------------------------------------------------- */

/**
 * Paint the status dot and its caption.
 *
 * @param {String} state   'online' | 'offline'
 * @param {String} text    caption next to the dot
 * @param {String} [detail] the service worker's diagnosis, shown as hover text.
 *        This matters: "the bridge is not started" and "the bridge is running
 *        but claude.binary-path points at a file that does not exist" both
 *        paint the same red dot, and they need completely different fixes.
 *        background.js builds that sentence on every ping; dropping it left
 *        the user restarting Maven instead of running `which claude`.
 */
function setBridgeStatus(state, text, detail) {
  elBridgeDot.className = state;          /* CSS colours .online green, .offline red */
  elBridgeText.textContent = text;

  /* title = the browser's own tooltip on hover. The popup is 300px wide, so
   * the full sentence does not fit as visible text. */
  var hover = (typeof detail === 'string' && detail.trim() !== '') ? detail.trim() : text;
  elBridgeText.title = hover;
  elBridgeDot.title = hover;

  /* When the bridge is down, the AI path cannot work. Rather than let the user
   * click a button that will half-fail, point them at the offline button. */
  if (state === 'offline') {
    elBtnFillAll.title = 'The AI bridge is offline. This will still fill everything the profile matches.';
  } else {
    elBtnFillAll.title = 'Match from your profile, then ask the AI bridge about the leftovers.';
  }
}

function checkBridge() {
  chrome.runtime.sendMessage({ type: 'BRIDGE_PING' }, function (response) {
    /* Same rule as before: always read lastError inside the callback. A missing
     * or crashed service worker lands here. */
    if (chrome.runtime.lastError || !response || typeof response !== 'object') {
      setBridgeStatus('offline', 'Bridge offline - deterministic only',
        'The extension background worker did not answer the status check.');
      return;
    }

    /* response.detail is a full, actionable sentence built by background.js —
     * pass it through instead of throwing it away. */
    var detail = typeof response.detail === 'string' ? response.detail : '';

    if (response.online === true) {
      setBridgeStatus('online', 'Bridge online', detail);
      return;
    }

    /* One special case is worth showing in the caption itself, because the
     * remedy is not "start the bridge": the bridge IS running, but it cannot
     * find the Claude CLI. */
    var caption = (detail.indexOf('Claude CLI was not found') !== -1)
      ? 'Bridge up, claude CLI missing'
      : 'Bridge offline - deterministic only';

    setBridgeStatus('offline', caption, detail);
  });
}

/* Kick the check off immediately; the dot stays grey for the fraction of a
 * second it takes to answer. */
checkBridge();

/* And find out whether there are questions waiting for him. This is the first
 * thing he sees when he opens the popup on any page, not just on a form — the
 * queue is global, and a question learned on Greenhouse fills a Workday box. */
refreshPendingCount();
