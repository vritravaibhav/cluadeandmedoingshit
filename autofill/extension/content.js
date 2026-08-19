/* =============================================================================
 * content.js — the orchestrator that runs INSIDE the job application page.
 * -----------------------------------------------------------------------------
 * WHERE THIS CODE LIVES
 *   Chrome injects this file into every frame of every page, AFTER the lib/
 *   files, in this exact manifest order:
 *
 *       lib/profile.js    (must be first: everything else reads the profile)
 *       lib/knowledge.js  (before match.js — the resolution order below asks
 *                          it first, so it has to exist by then)
 *       lib/scrape.js
 *       lib/fill.js
 *       lib/widgets.js    (after fill.js — it reuses fill.js's text-typing path
 *                          via AF.setValue to filter a fake dropdown's menu)
 *       lib/match.js
 *       content.js        (always last)
 *
 *   The content script shares the page's DOM but NOT the page's JavaScript
 *   variables — it runs in an "isolated world". The page cannot see AF, and we
 *   cannot see the page's own React internals except through the DOM.
 *
 * SPRING ANALOGY
 *   Think of this file as a @RestController with four endpoints
 *   (FILL_ALL, FILL_DETERMINISTIC, UNDO, SCAN). It owns no business logic of
 *   its own; it wires together the injected "services":
 *
 *       lib/scrape.js    -> reads the form           (like a Repository)
 *       lib/knowledge.js -> answers he taught us     (like a second Repository)
 *       lib/match.js     -> decides what goes where  (like a Service)
 *       lib/fill.js      -> writes to the DOM        (like a Repository write)
 *       lib/widgets.js   -> writes to FAKE dropdowns (same, for React widgets)
 *       background.js    -> calls the AI bridge      (like a RestTemplate client)
 *
 * THE RESOLUTION ORDER FOR ONE FIELD (this is the heart of the file)
 *
 *   a. AF.knowledge.matchFromKnowledge(field)
 *        An answer HE TYPED into the extension's own "questions for you" page.
 *        Highest priority — he told us in so many words, so nothing may
 *        override it, not the profile and certainly not a language model.
 *
 *   b. AF.matchField / AF.matchAll(fields, profile)
 *        The deterministic alias match against the resume profile.
 *
 *   c. AF.recognisedButBlank(field, profile)
 *        "I know this field and the profile leaves it empty ON PURPOSE"
 *        (salary, the EEO self-identification questions). Skip, never guess.
 *
 *   d. The AI bridge, via background.js.
 *
 *   e. Still nothing -> PUSH IT ONTO THE ASK QUEUE.
 *        The serialisable field is appended to chrome.storage.local under
 *        'pendingQuestions'. ask.html walks that queue, he answers once, and
 *        AF.knowledge.remember() means step (a) answers it for ever after —
 *        on this site and on every other site that asks the same thing.
 *
 * THE FOUR THINGS THAT WILL BITE YOU IF YOU EDIT THIS FILE
 *
 *   1. RETURN true FROM THE MESSAGE LISTENER FOR ANY ASYNC PATH.
 *      chrome.runtime.onMessage closes the reply channel the moment the
 *      listener returns, unless the listener returns the literal value `true`.
 *      Forget it and the popup's callback fires with `undefined` and NO error
 *      message, which looks exactly like "the extension is broken".
 *
 *   2. ...BUT NEVER RETURN true IN A FRAME THAT WILL NOT ANSWER.
 *      The manifest sets "all_frames": true, so a Greenhouse page with an
 *      embedded form runs THREE copies of this file (top page, form iframe,
 *      analytics iframe). chrome.tabs.sendMessage delivers to all of them and
 *      the FIRST responder wins. A frame with no fillable fields must return
 *      undefined so its channel closes immediately. If it returned true and
 *      then stayed silent, the popup would hang forever waiting on a port that
 *      nobody is ever going to write to.
 *
 *   3. NEVER SUBMIT THE FORM. There is deliberately no .submit(), no
 *      .click() on a submit button, and no Enter keypress anywhere in this
 *      file. The user always presses the final button themselves.
 *
 *   4. NEVER TOUCH FILE INPUTS. A page cannot set input.files for security
 *      reasons, and clicking one throws a native "choose a file" dialog in the
 *      user's face. File fields are counted and reported so the popup can list
 *      them under "Needs you".
 * ========================================================================== */

(function () {
  'use strict';

  /* Defensive namespace creation, identical in every file of this extension.
   * By the time this line runs the lib/ files have already created AF; this is
   * only insurance in case one of them failed to load. */
  var AF = (globalThis.AF = globalThis.AF || {});

  /* ---------------------------------------------------------------------------
   * SECTION 0 — double-injection guard
   * -------------------------------------------------------------------------
   * Chrome injects content scripts once per frame, but chrome.scripting can
   * inject them a second time, and some single-page apps re-create frames.
   * Registering the message listener twice would make one frame answer twice.
   *
   * `globalThis` here is the isolated world of THIS frame, so the flag is
   * per-frame — which is exactly what we want.
   * ------------------------------------------------------------------------ */
  if (globalThis.__AF_LOADED === true) {
    return; /* Already running in this frame. Do nothing at all. */
  }
  globalThis.__AF_LOADED = true;

  /* ---------------------------------------------------------------------------
   * SECTION 1 — tunable constants
   * ------------------------------------------------------------------------ */

  /* The four messages the popup can send us. Anything else is ignored. */
  var MSG_FILL_ALL = 'FILL_ALL';
  var MSG_FILL_DETERMINISTIC = 'FILL_DETERMINISTIC';
  var MSG_UNDO = 'UNDO';
  var MSG_SCAN = 'SCAN';

  /* The message we send to background.js (the service worker) when we want AI
   * answers. The fetch MUST happen there, not here — see SECTION 7. */
  var MSG_AI_FILL = 'AI_FILL';

  /* ---- the "ask me" queue --------------------------------------------------
   * The one chrome.storage.local key that holds questions waiting for a human
   * answer. ask.js reads exactly this key (its own KEY_PENDING constant), so
   * the two spellings must stay identical.
   *
   * chrome.storage.local — not sessionStorage, not chrome.storage.session, not
   * a variable in this file. It has to survive closing the tab, quitting
   * Chrome, and restarting the machine. */
  var PENDING_KEY = 'pendingQuestions';

  /* Never let the queue grow without bound. A mis-scrape on one hostile page
   * could otherwise park two hundred junk "questions" in front of him. The
   * OLDEST entries are dropped when we go over. */
  var MAX_PENDING_QUESTIONS = 150;

  /* The tombstone ask.js stores when he presses "Never ask this again".
   *
   * It is an ordinary remembered answer whose VALUE is this marker string, so
   * the field counts as "already dealt with" and never comes back onto the
   * queue. The one thing we must never do is type it into the form, hence the
   * explicit check in isNeverAskAnswer() below.
   *
   * lib/knowledge.js does not currently publish a constant of its own, so this
   * literal is the agreed spelling (ask.js's FALLBACK_NEVER_ANSWER). If a
   * later version of knowledge.js exports AF.knowledge.NEVER_ANSWER we prefer
   * that, exactly as ask.js does, and the two can never drift apart. */
  var FALLBACK_NEVER_ANSWER = '__af_never_ask__';

  /* Hard cap on how much job-description text we ship to the model. 4000
   * characters is roughly 1000 tokens: enough to know the company, the role
   * and the tech stack, small enough to keep the CLI call fast. */
  var JOB_DESCRIPTION_MAX_CHARS = 4000;

  /* Where the job description usually lives, tried in this order. The first
   * five are the ones named in the project spec; the Workday / Lever specific
   * ones are inserted before the generic <article> / <main> because those two
   * often swallow the whole page including the nav bar. */
  var JOB_DESCRIPTION_SELECTORS = [
    '#job-description',
    '.job-description',
    '[data-testid*="description"]',
    '[data-automation-id*="jobPostingDescription"]', /* Workday          */
    '.posting-description',                          /* Lever            */
    '.job__description',                             /* Ashby / misc     */
    'article',
    'main'
  ];

  /* Words that mark a box we must never hand to the AI: site search, login
   * forms, newsletter signups, promo-code boxes. lib/match.js already refuses
   * to match these deterministically, which means they fall through into the
   * "unmatched" bucket — without this second filter we would cheerfully ask an
   * LLM what to type into the site's search box. */
  var NOISE_WORDS = [
    'search', 'query', 'filter', 'keyword',
    'password', 'passcode', 'username', 'user name', 'login', 'log in', 'sign in',
    'otp', 'captcha', 'verification code',
    'newsletter', 'subscribe', 'promo', 'coupon', 'discount', 'referral code'
  ];

  /* Should we overwrite a field that already contains something?
   *
   * false  = leave anything the user (or Chrome's own autofill, or the ATS's
   *          resume parser) already typed. Safer, and the default.
   * true   = overwrite everything from the profile.
   *
   * Flip this one constant if you would rather the extension always win. */
  var OVERWRITE_ALREADY_FILLED = false;

  /* Frames with fewer than this many fields are probably not the real
   * application form (a cookie banner, a newsletter box, a search widget).
   * They still do their work, but they delay their ANSWER so that the frame
   * holding the real form wins the "first responder wins" race and the popup
   * shows the interesting counters. */
  var SMALL_FRAME_FIELD_COUNT = 3;
  var SMALL_FRAME_ANSWER_DELAY_MS = 400;

  /* How many fields the sequential fill loop may handle before it hands
   * control back to the browser with a setTimeout(..., 0).
   *
   * WHY THIS EXISTS. The loop is written as "do this field, then call the
   * function again for the next one". When a field fills instantly — which is
   * every ordinary text box — that call happens straight away, so the loop is
   * really RECURSION, and 200 fields would stack 200 unfinished calls on top of
   * each other. Yielding every 25 fields unwinds that stack, and as a bonus it
   * stops a huge form freezing the tab while it fills. */
  var FIELDS_PER_YIELD = 25;

  /* Absolute last-resort timer. If some future bug meant sendResponse were
   * never called, the popup would spin forever. This guarantees an answer.
   *
   * It has to clear the sum of the two slow stages, not just one of them:
   *   - the bridge's own CLI timeout is 120s and background.js waits 150s;
   *   - the deterministic pass is now SEQUENTIAL, and a field that has to go
   *     through lib/widgets.js costs up to 8s of clicking and polling before
   *     it gives up. A form with several unfillable fake dropdowns can
   *     therefore spend the best part of a minute before the AI call starts.
   * 240s leaves room for both without ever firing on a healthy run. */
  var WATCHDOG_MS = 240000;

  /* Log prefix so the user can filter the page console with "[AF]". */
  var LOG_PREFIX = '[AF content]';

  /* ---------------------------------------------------------------------------
   * SECTION 2 — tiny helpers
   * ------------------------------------------------------------------------ */

  function log() {
    /* Build the argument list by hand: `arguments` is not a real Array. */
    var parts = [LOG_PREFIX];
    var i;
    for (i = 0; i < arguments.length; i++) {
      parts.push(arguments[i]);
    }
    try {
      console.log.apply(console, parts);
    } catch (error) {
      /* A page can delete console.log. Never let logging break a fill. */
    }
  }

  function logWarning() {
    var parts = [LOG_PREFIX];
    var i;
    for (i = 0; i < arguments.length; i++) {
      parts.push(arguments[i]);
    }
    try {
      console.warn.apply(console, parts);
    } catch (error) {
      /* ignored on purpose */
    }
  }

  /** Turn anything into a trimmed lowercase string. Never throws. */
  function lower(value) {
    if (value === null || value === undefined) {
      return '';
    }
    return String(value).trim().toLowerCase();
  }

  /**
   * The field's own identifying text, glued into one string.
   *
   * Returned with its ORIGINAL capitalisation, because the caller normalises
   * it and that step needs to see camelCase in order to split "searchQuery"
   * into two words. Lowercasing here would destroy that evidence.
   *
   * NOTE what is missing: field.context. Context is the nearest heading or
   * legend, so a question sitting under a "Job Search" heading would inherit
   * the word "search" and be wrongly discarded by the noise filter below. Only
   * the control's OWN wording is trustworthy for that decision.
   */
  function fieldOwnText(field) {
    if (!field) {
      return '';
    }
    var pieces = [
      field.label,
      field.ariaLabel,
      field.placeholder,
      field.name,
      field.id
    ];
    var text = '';
    var i;
    for (i = 0; i < pieces.length; i++) {
      if (pieces[i]) {
        text += ' ' + String(pieces[i]);
      }
    }
    return text.trim();
  }

  /**
   * Normalise a piece of form text the same way lib/match.js does, so the two
   * modules agree on what a "word" is:
   *   - camelCase is split apart ("searchQuery" -> "search Query"), because
   *     name and id attributes are written that way
   *   - lowercase
   *   - underscores, hyphens and dots become spaces
   *   - anything else that is not a letter or digit becomes a space
   *   - runs of whitespace collapse to one space
   *
   * Because the result has single spaces only, " " is a real word boundary and
   * the whole-word test below does not need \b.
   */
  function normaliseText(value) {
    if (value === null || value === undefined) {
      return '';
    }
    var text = String(value);
    text = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2'); /* camelCase -> two words */
    text = text.toLowerCase();
    text = text.replace(/[_\-.]/g, ' ');
    text = text.replace(/[^a-z0-9 ]/g, ' ');
    text = text.replace(/\s+/g, ' ');
    return text.trim();
  }

  /**
   * True when `needle` appears in `haystack` as a complete word or phrase.
   *
   * THIS MUST NOT BE A PLAIN indexOf. lib/match.js makes the same test with
   * the same care and says why: "research assistant" must not trip the
   * 'search' guard. This function is the LAST gate before the AI stage, so a
   * looser test here silently throws away real application questions that
   * match.js deliberately let through — a required textarea labelled
   * "Describe your research experience" was being dropped because 'search'
   * sits inside 'research'.
   *
   * Both arguments must already be normalised by normaliseText.
   */
  function containsWholeWord(haystack, needle) {
    if (haystack === '' || needle === '') {
      return false;
    }
    /* Escape regex metacharacters — NOISE_WORDS is hand-written, but a future
     * entry with a '.' or '(' in it must not blow up the fill. */
    var escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var pattern = new RegExp('(^| )' + escaped + '( |$)');
    return pattern.test(haystack);
  }

  /**
   * Is this a box we must never ask the AI about?
   * Site search, login, newsletter, promo code — see NOISE_WORDS.
   */
  function looksLikeNoiseField(field) {
    if (!field) {
      return true;
    }

    /* A password box is unambiguous, no word matching needed. */
    if (lower(field.type) === 'password' || lower(field.type) === 'search') {
      return true;
    }

    var haystack = normaliseText(fieldOwnText(field));
    var i;
    for (i = 0; i < NOISE_WORDS.length; i++) {
      /* Multi-word entries such as 'user name' and 'referral code' work too:
       * the regex matches the whole phrase between word boundaries. */
      if (containsWholeWord(haystack, NOISE_WORDS[i])) {
        return true;
      }
    }
    return false;
  }

  /**
   * Is the control still empty RIGHT NOW?
   *
   * field.filled is a snapshot taken during the scrape. By the time the AI
   * answers, seconds have passed and the deterministic pass has already
   * written to some of these elements, so we re-read the live DOM instead of
   * trusting the flag.
   */
  function isStillEmpty(field) {
    try {
      if (!field || !field.el) {
        return false;
      }
      var el = field.el;

      if (field.kind === 'checkbox' || field.kind === 'radio') {
        /* For a radio GROUP, field.el is only the first radio, so asking
         * el.checked would report "empty" whenever the user picked any other
         * option. Ask the whole group instead. */
        if (field.kind === 'radio') {
          return !anyRadioInGroupChecked(field);
        }
        return el.checked !== true;
      }

      if (field.kind === 'contenteditable') {
        return lower(el.textContent) === '';
      }

      /* text, textarea, select */
      return lower(el.value) === '';
    } catch (error) {
      /* If we cannot tell, assume it is NOT empty. Doing nothing is always
       * safer than overwriting something we failed to read. */
      return false;
    }
  }

  /**
   * Does any radio in this group currently have a dot in it?
   * Uses getRootNode() so the lookup also works inside a shadow root
   * (Workday and Ashby both render parts of their forms that way).
   */
  function anyRadioInGroupChecked(field) {
    try {
      var el = field.el;
      var groupName = field.groupName || field.name || '';

      if (groupName === '') {
        /* Unnamed radio: it is a group of one. */
        return el.checked === true;
      }

      var root = el.getRootNode ? el.getRootNode() : document;
      var escaped = (globalThis.CSS && CSS.escape) ? CSS.escape(groupName) : groupName;
      var radios = root.querySelectorAll('input[type="radio"][name="' + escaped + '"]');

      var i;
      for (i = 0; i < radios.length; i++) {
        if (radios[i].checked === true) {
          return true;
        }
      }
      return false;
    } catch (error) {
      return false;
    }
  }

  /**
   * "Did the matcher recognise this field but find nothing to put in it?"
   *
   * Thin, defensive wrapper around AF.recognisedButBlank. It is wrapped
   * because lib/match.js could be an older build without that function, and a
   * missing helper must degrade to the previous behaviour, not throw.
   *
   * @returns {Object|null} {key, confidence, reason} or null
   */
  function recognisedButBlank(field, profile) {
    try {
      if (typeof AF.recognisedButBlank !== 'function') {
        return null;
      }
      return AF.recognisedButBlank(field, profile);
    } catch (error) {
      logWarning('recognisedButBlank failed:', error);
      return null;
    }
  }

  /**
   * Thin, defensive wrapper around AF.screening.answer — the bank of standard
   * answers to the screening questions that appear on nearly every form
   * ("convicted of a crime" -> No, "authorised to work" -> Yes).
   *
   * Wrapped for the same reason as recognisedButBlank above: lib/screening.js
   * is a newer file than the rest of the extension, so a profile loaded from
   * an older build must degrade to the previous behaviour rather than throw.
   *
   * @returns {Object|null} {key, value, confidence, screeningId, review, why}
   */
  /**
   * Thin, defensive wrapper around AF.intuition.answer — the answer of last
   * resort, reached only when knowledge, match, screening AND the AI have all
   * declined. Wrapped for the same reason as screeningAnswer above: a missing
   * or older lib/intuition.js must degrade to "no guess", never break the run.
   *
   * @returns {Object|null} {value, confidence, review, why}
   */
  function intuitionAnswer(field, profile) {
    try {
      if (!AF.intuition || typeof AF.intuition.answer !== 'function') {
        return null;
      }
      return AF.intuition.answer(field, profile);
    } catch (error) {
      logWarning('intuition.answer failed:', error);
      return null;
    }
  }

  /**
   * Fill a whole batch of fields from intuition. Used when the AI stage could
   * not run at all, so nothing else is going to answer these.
   *
   * Uses the same chunked loop as the other passes (see FIELDS_PER_YIELD):
   * a form with 80 leftovers must not freeze the page.
   *
   * @param {Function} done  called with the number of fields actually filled
   */
  function applyIntuition(candidates, profile, tally, done) {
    var list = candidates || [];
    var position = 0;
    var sinceYield = 0;
    var filled = 0;

    function step() {
      if (position >= list.length) {
        done(filled);
        return;
      }
      var field = list[position];
      position++;

      var guess = null;
      try {
        guess = intuitionAnswer(field, profile);
      } catch (error) {
        guess = null;
      }

      /* Nothing sensible to say, or the field left the DOM while we waited. */
      if (!guess || guess.value === null || guess.value === undefined || guess.value === '' ||
          (field.el && field.el.isConnected === false) ||
          (!isStillEmpty(field) && OVERWRITE_ALREADY_FILLED === false)) {
        tally.skipped++;
        tally.askCandidates.push(field);
        next();
        return;
      }

      writeValue(field, guess.value, function (applied) {
        if (applied) {
          tally.guessed++;
          filled++;
          /* Amber, not blue: this is a guess made without the model, and it is
           * the one thing on the page he really should read. */
          AF.highlight(field.el, 'skip');
          if (tally.firstFilledElement === null) {
            tally.firstFilledElement = field.el;
          }
        } else {
          tally.skipped++;
        }
        /* Either way it stays on the ask queue: teaching a real answer once
         * means knowledge.js answers it for ever and this guess never returns. */
        tally.askCandidates.push(field);
        next();
      });
    }

    function next() {
      sinceYield++;
      if (sinceYield >= FIELDS_PER_YIELD) {
        sinceYield = 0;
        setTimeout(step, 0);
        return;
      }
      step();
    }

    step();
  }

  function screeningAnswer(field, profile) {
    try {
      if (!AF.screening || typeof AF.screening.answer !== 'function') {
        return null;
      }
      return AF.screening.answer(field, profile);
    } catch (error) {
      logWarning('screening.answer failed:', error);
      return null;
    }
  }

  /**
   * A short human-readable name for a field, used in the popup's
   * "Needs you (file uploads)" list and in console logs.
   */
  function describeField(field) {
    if (!field) {
      return 'Unnamed field';
    }
    var candidates = [field.label, field.ariaLabel, field.placeholder, field.name, field.id];
    var i;
    for (i = 0; i < candidates.length; i++) {
      var text = candidates[i];
      if (typeof text === 'string' && text.trim() !== '') {
        return text.trim();
      }
    }
    return 'Unnamed field';
  }

  /* ---------------------------------------------------------------------------
   * SECTION 2b — the learned-answer memory (lib/knowledge.js)
   * -------------------------------------------------------------------------
   * Everything here is a thin, defensive wrapper. lib/knowledge.js could fail
   * to load (a syntax error, an older build, a stripped-down install) and when
   * it does the extension must fall straight back to its previous behaviour —
   * profile, then AI — rather than throwing on the first field.
   *
   * lookup() and matchFromKnowledge() are SYNCHRONOUS by design: the fill loop
   * visits every field on the page and awaiting a storage read per field would
   * be both slow and a rewrite of working code. The price is that
   * AF.knowledge.load() must have been called at least once first, which
   * runFill() does before it touches a single field.
   * ------------------------------------------------------------------------ */

  /** Is lib/knowledge.js actually here and usable? */
  function knowledgeAvailable() {
    return !!(AF.knowledge && typeof AF.knowledge.lookup === 'function');
  }

  /**
   * Pull the whole learned store into memory so the synchronous lookups below
   * can work. Never fails: a broken memory degrades to an empty memory.
   *
   * @param {Function} callback called with no arguments when it is safe to
   *                            start looking things up
   */
  function loadKnowledge(callback) {
    if (!knowledgeAvailable() || typeof AF.knowledge.load !== 'function') {
      callback();
      return;
    }
    try {
      AF.knowledge.load().then(
        function () { callback(); },
        function (error) {
          logWarning('could not load the learned answers:', error);
          callback();
        }
      );
    } catch (error) {
      logWarning('the learned-answer store threw while loading:', error);
      callback();
    }
  }

  /** The "never ask me this again" marker, preferring knowledge.js's own. */
  function neverAskMarker() {
    if (AF.knowledge && typeof AF.knowledge.NEVER_ANSWER === 'string' &&
        AF.knowledge.NEVER_ANSWER !== '') {
      return AF.knowledge.NEVER_ANSWER;
    }
    return FALLBACK_NEVER_ANSWER;
  }

  /**
   * Is this stored answer the "never ask me this again" tombstone rather than
   * a real answer?
   *
   * This check is not optional. Without it the marker string itself would be
   * typed into the form the next time the question came round — the single
   * worst outcome this whole feature could produce.
   */
  function isNeverAskAnswer(value) {
    return (typeof value === 'string' && value === neverAskMarker());
  }

  /**
   * The stored record for this question, or null.
   *
   * A NON-NULL record means "he has already dealt with this question", whatever
   * the answer turned out to be — a real answer, a deliberate blank, or the
   * never-ask tombstone. That is the test the ask queue uses, so that a
   * question he chose to leave empty is not put back in front of him for ever.
   */
  function learnedRecordFor(field) {
    if (!knowledgeAvailable()) {
      return null;
    }
    try {
      return AF.knowledge.lookup(field);
    } catch (error) {
      logWarning('the learned-answer lookup failed:', error);
      return null;
    }
  }

  /**
   * A learned answer worth TYPING, shaped exactly like an AF.matchField result
   * ({key, value, confidence}) so it drops into the existing pipeline.
   *
   * Returns null for a deliberate blank and for the never-ask tombstone —
   * neither is something to write into a box.
   */
  function learnedMatchFor(field) {
    if (!knowledgeAvailable() || typeof AF.knowledge.matchFromKnowledge !== 'function') {
      return null;
    }
    try {
      var match = AF.knowledge.matchFromKnowledge(field);
      if (!match) {
        return null;
      }
      if (isNeverAskAnswer(match.value)) {
        return null;
      }
      return match;
    } catch (error) {
      logWarning('the learned-answer match failed:', error);
      return null;
    }
  }

  /**
   * The normalised key for a question. Used to de-duplicate the ask queue, so
   * the same question coming from five different job sites is only ever asked
   * once. Returns '' when the field has no usable wording at all.
   */
  function questionKeyFor(field) {
    if (!knowledgeAvailable() || typeof AF.knowledge.qKey !== 'function') {
      return '';
    }
    try {
      var key = AF.knowledge.qKey(field);
      return (typeof key === 'string') ? key : '';
    } catch (error) {
      logWarning('could not build a question key:', error);
      return '';
    }
  }

  /**
   * "This learned answer was just used." Bumps useCount / lastUsedAt so the
   * options page can show how often each answer earns its keep, and so the
   * store's LRU eviction throws away the right ones when it fills up.
   *
   * Fire and forget: the fill must not wait on a storage write, and a failure
   * here costs a statistic, nothing more.
   */
  function touchLearnedAnswer(field) {
    if (!knowledgeAvailable() || typeof AF.knowledge.touch !== 'function') {
      return;
    }
    try {
      var key = questionKeyFor(field);
      if (key === '') {
        return;
      }
      AF.knowledge.touch(key).catch(function (error) {
        logWarning('could not record that a learned answer was used:', error);
      });
    } catch (error) {
      logWarning('could not record that a learned answer was used:', error);
    }
  }

  /* ---------------------------------------------------------------------------
   * SECTION 2c — writing one value, with the fake-dropdown retry
   * -------------------------------------------------------------------------
   * AF.setValue handles every REAL control: <input>, <textarea>, <select>,
   * checkboxes, radios, contenteditable. It returns false when it cannot do the
   * job — most often a <select> whose option list does not contain our value.
   *
   * Modern ATS forms are full of controls that only LOOK like dropdowns:
   * react-select, Workday's own combobox, a headless <div role="listbox">.
   * They have no .value and no <option> elements, so AF.setValue can only fail
   * on them. lib/widgets.js knows how to drive those: click to open, type to
   * filter, click the matching row, then verify the displayed text.
   *
   * That work is asynchronous (it polls for a menu that a React app renders a
   * few frames later), which is why this helper is callback-based and why the
   * whole fill loop below had to become sequential. Sequential is also what
   * lib/widgets.js requires: it keeps ONE error slot and two open menus fight
   * over the page's focus.
   * ------------------------------------------------------------------------ */

  /** Would lib/widgets.js recognise this element as a fake dropdown? */
  function isFakeDropdown(el) {
    try {
      return !!(AF.widgets && typeof AF.widgets.isCustomDropdown === 'function' &&
        AF.widgets.isCustomDropdown(el));
    } catch (error) {
      return false;
    }
  }

  /**
   * Write one value into one control, retrying through lib/widgets.js when the
   * ordinary path fails on something that is really a custom dropdown.
   *
   * @param {Object}   field  the live Field (field.el is the DOM element)
   * @param {*}        value  what to write
   * @param {Function} done   called as done(appliedBoolean). ALWAYS called, and
   *                          always exactly once.
   */
  function writeValue(field, value, done) {
    var applied = false;

    try {
      applied = AF.setValue(field.el, value, field);
    } catch (error) {
      logWarning('setValue threw on field #' + field.index + ':', error);
      applied = false;
    }

    if (applied) {
      done(true);
      return;
    }

    /* --- the retry ------------------------------------------------------- *
     * Only for controls that could plausibly BE a fake dropdown: a scraped
     * kind of select/radio (fill.js failed to find the option), or anything
     * lib/widgets.js positively recognises. A plain text box that refused a
     * value is not a dropdown and clicking on it would achieve nothing. */
    var kind = lower(field.kind);
    var worthRetrying = (kind === 'select' || kind === 'radio' || isFakeDropdown(field.el));

    if (!worthRetrying || !AF.widgets || typeof AF.widgets.setCustomDropdown !== 'function') {
      done(false);
      return;
    }

    try {
      /* setCustomDropdown returns a Promise<Boolean> and is documented never
       * to reject — the .catch is belt and braces, because a rejection that
       * escaped here would silently abandon the rest of the form. */
      AF.widgets.setCustomDropdown(field.el, value).then(
        function (ok) {
          if (ok) {
            log('filled "' + describeField(field) + '" through the custom-dropdown path.');
          }
          done(ok === true);
        },
        function (error) {
          logWarning('the custom-dropdown path failed on field #' + field.index + ':', error);
          done(false);
        }
      );
    } catch (error) {
      logWarning('the custom-dropdown path threw on field #' + field.index + ':', error);
      done(false);
    }
  }

  /* ---------------------------------------------------------------------------
   * SECTION 3 — loading the profile
   * -------------------------------------------------------------------------
   * chrome.storage is asynchronous, hence the callback. We deliberately re-read
   * it on EVERY run rather than caching it in a variable: the user may edit the
   * profile in the options tab while the application form is still open, and a
   * cached copy would quietly keep filling the old values. A storage read costs
   * well under a millisecond.
   * ------------------------------------------------------------------------ */
  function loadProfile(callback) {
    var fallback = AF.DEFAULT_PROFILE || {};

    try {
      chrome.storage.local.get(['profile'], function (stored) {
        /* chrome.runtime.lastError must be READ inside the callback, otherwise
         * Chrome prints an "unchecked runtime.lastError" warning. */
        if (chrome.runtime.lastError) {
          logWarning('could not read the saved profile, using the bundled default:',
            chrome.runtime.lastError.message);
          callback(fallback);
          return;
        }

        var saved = stored ? stored.profile : null;

        /* A profile must be a plain object. An array or a string means the
         * storage was written by something else, or by an older version. */
        if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
          callback(saved);
          return;
        }

        /* Fresh install: nothing saved yet. */
        callback(fallback);
      });
    } catch (error) {
      /* Happens when the extension has been reloaded while this page stayed
       * open — the old content script's chrome.* handles become invalid. */
      logWarning('chrome.storage is unavailable, using the bundled default:', error);
      callback(fallback);
    }
  }

  /* ---------------------------------------------------------------------------
   * SECTION 4 — reading the job description off the page
   * -------------------------------------------------------------------------
   * The AI needs to know what job this is, mostly so it can (a) fill the
   * {{COMPANY}} / {{ROLE}} tokens in the profile's cover letters and (b) answer
   * "why do you want to work here?" without inventing a company.
   *
   * CAVEAT WORTH KNOWING: on a careers site that EMBEDS the ATS form in an
   * iframe, the description sits in the parent page and the form sits in the
   * iframe. Same-origin parents can be read; cross-origin ones (the common
   * case) throw, and we fall back to whatever text this frame has.
   * ------------------------------------------------------------------------ */
  function readJobDescription() {
    var text = '';

    /* --- 1) the obvious containers, best first ---------------------------- */
    text = firstMatchingContainerText(document);

    /* --- 2) a same-origin parent page ------------------------------------- */
    if (text === '' && window !== window.top) {
      try {
        /* Throws a SecurityError for a cross-origin parent. That is expected
         * and harmless — the catch simply moves on. */
        var parentDocument = window.parent.document;
        text = firstMatchingContainerText(parentDocument);
      } catch (error) {
        /* Cross-origin parent. Nothing to do. */
      }
    }

    /* --- 3) the whole page as a last resort ------------------------------- */
    if (text === '') {
      try {
        text = document.body ? document.body.innerText : '';
      } catch (error) {
        text = '';
      }
    }

    return tidyAndCap(text, JOB_DESCRIPTION_MAX_CHARS);
  }

  /** Try every selector in order and return the text of the first real hit. */
  function firstMatchingContainerText(doc) {
    var i;
    for (i = 0; i < JOB_DESCRIPTION_SELECTORS.length; i++) {
      try {
        var node = doc.querySelector(JOB_DESCRIPTION_SELECTORS[i]);
        if (!node) {
          continue;
        }
        var text = node.innerText || node.textContent || '';
        /* Anything shorter than this is a heading or a breadcrumb, not a
         * description. Keep looking. */
        if (text.trim().length >= 200) {
          return text;
        }
      } catch (error) {
        /* An invalid selector or a hostile page. Try the next one. */
      }
    }
    return '';
  }

  /** Collapse runs of blank lines and spaces, then cut to `maxChars`. */
  function tidyAndCap(rawText, maxChars) {
    var text = (rawText === null || rawText === undefined) ? '' : String(rawText);

    text = text.replace(/[ \t]+/g, ' ');    /* runs of spaces/tabs -> one space */
    text = text.replace(/\n{3,}/g, '\n\n'); /* 3+ blank lines      -> one blank */
    text = text.trim();

    if (text.length > maxChars) {
      text = text.substring(0, maxChars) + '\n[...truncated]';
    }
    return text;
  }

  /* ---------------------------------------------------------------------------
   * SECTION 5 — the deterministic pass
   * -------------------------------------------------------------------------
   * Scrape -> snapshot -> match -> write. No network, no AI, works offline.
   * ------------------------------------------------------------------------ */

  /**
   * A mutable tally passed down the pipeline, so every stage can add to the
   * same counters instead of merging objects at the end.
   */
  function newTally() {
    return {
      deterministic: 0,  /* written from the profile                          */
      learned: 0,        /* written from an answer HE taught the extension    */
      screening: 0,      /* written from lib/screening.js standard answers    */
      ai: 0,             /* written from an AI suggestion                     */
      guessed: 0,        /* written from lib/intuition.js (amber, review me)  */
      skipped: 0,        /* deliberately left alone (files are NOT counted)   */
      /* Screening answers with legal weight (criminal history, work
       * authorisation, sponsorship, consent boxes). Filled with the
       * common-case value, highlighted amber, and surfaced in the popup so
       * they are checked rather than silently trusted. */
      review: [],
      manual: [],        /* file-upload fields the user must handle by hand   */
      warning: '',       /* one non-fatal problem, e.g. "the bridge is down"  */
      firstFilledElement: null,
      aiCandidates: [],  /* Field[] handed to SECTION 6 when AI is enabled    */
      /* Field[] nobody could answer. These become the "questions for you"
       * queue in SECTION 6b. A field is only ever in here if it is NOT noise,
       * NOT a file upload, and NOT something he has already dealt with. */
      askCandidates: [],
      pending: 0         /* how many questions are waiting after this run     */
    };
  }

  /**
   * Apply everything we can work out WITHOUT the AI: first the answers he
   * taught the extension, then the profile.
   *
   * ASYNCHRONOUS, and one field at a time.
   *   The loop used to be a plain synchronous `for`. It cannot be any more:
   *   when AF.setValue fails on what turns out to be a fake React dropdown we
   *   retry through lib/widgets.js, which has to click the control, wait for a
   *   menu to render, and click a row. Two of those running at once would
   *   fight over the page's focus, so each field is finished before the next
   *   one starts. Wall-clock cost on a normal form is zero — the slow path is
   *   only entered by the handful of fields that failed outright.
   *
   * @param {Array}    fields  Field[] straight from AF.scrapeFields
   * @param {Object}   profile the user's profile object
   * @param {Object}   tally   mutated in place
   * @param {Function} done    called with no arguments when every field is done
   */
  function applyDeterministicMatches(fields, profile, tally, done) {
    /* One call does all the profile scoring; the result keeps each field paired
     * with its match (or null), in the original document order. The learned
     * answers are consulted per field inside the loop, because they win over
     * this result and there is no batch call for them. */
    var results = AF.matchAll(fields, profile);

    var position = 0;
    var sinceYield = 0;

    /* Handle results[position], then call next() to move on. This is the
     * callback equivalent of a `for` loop with an `await` in it. */
    function step() {
      if (position >= results.length) {
        done();
        return;
      }

      var row = results[position];
      position++;

      var field = row.field;

      /* Requirement: wrap EVERY field application in its own try/catch. One
       * exotic control on one exotic ATS must not abort the other 39 fields.
       * Note that the try only covers the SYNCHRONOUS decisions — the
       * asynchronous write has its own error handling inside writeValue. */
      try {
        processOneField(field, row.match, profile, tally, next);
      } catch (error) {
        logWarning('field #' + field.index + ' threw during the deterministic pass:', error);
        tally.skipped++;
        next();
      }
    }

    /* Move to the next field, unwinding the stack every FIELDS_PER_YIELD. */
    function next() {
      sinceYield++;
      if (sinceYield >= FIELDS_PER_YIELD) {
        sinceYield = 0;
        setTimeout(step, 0);
        return;
      }
      step();
    }

    step();
  }

  /**
   * The resolution order for a single field, steps (a) to (c) plus the write.
   * Steps (d) and (e) — the AI and the ask queue — happen later, in SECTION 6,
   * for everything this function parks in tally.aiCandidates.
   *
   * @param {Function} next  call exactly once, whatever happens, to move on
   */
  function processOneField(field, profileMatch, profile, tally, next) {

    /* --- file inputs: report, never touch -------------------------------- *
     * A page cannot set input.files, and clicking one throws a native file
     * dialog in his face. They are listed under "Needs you" in the popup and
     * are deliberately NOT queued as questions: there is nothing he could type
     * into the extension that would attach a file for him. */
    if (field.kind === 'file') {
      tally.manual.push(describeField(field));
      AF.highlight(field.el, 'skip');
      next();
      return;
    }

    /* --- already has a value --------------------------------------------- */
    if (field.filled === true && OVERWRITE_ALREADY_FILLED === false) {
      tally.skipped++;
      next();
      return;
    }

    /* --- (a) an answer HE TAUGHT US -------------------------------------- *
     * Highest priority in the whole extension. He sat down, read this exact
     * question in ask.html, and typed the answer himself. Nothing overrides
     * that. */
    var learnedRecord = learnedRecordFor(field);

    if (learnedRecord !== null) {
      var learnedMatch = learnedMatchFor(field);

      if (learnedMatch) {
        writeValue(field, learnedMatch.value, function (applied) {
          if (applied) {
            tally.learned++;
            /* Green, like a profile match: this is HIS answer, not a guess. */
            AF.highlight(field.el, 'ok');
            if (tally.firstFilledElement === null) {
              tally.firstFilledElement = field.el;
            }
            touchLearnedAnswer(field);
          } else {
            /* We know the answer but the control would not take it. Do not
             * hand it to the AI: it would only invent a different answer to a
             * question he has already answered. Amber, so he can see it. */
            logWarning('could not apply your saved answer to "' + describeField(field) + '".');
            tally.skipped++;
            AF.highlight(field.el, 'skip');
          }
          next();
        });
        return;
      }

      /* A record exists but there is nothing to type: either he answered with
       * a deliberate BLANK, or he pressed "Never ask this again". Both mean
       * "leave this box alone and stop bothering me about it" — so it is
       * skipped here AND, because learnedRecordFor() is checked again before
       * queueing, it never returns to the questions list. */
      log('leaving "' + describeField(field) + '" alone (you asked me not to fill it).');
      tally.skipped++;
      AF.highlight(field.el, 'skip');
      next();
      return;
    }

    /* --- (b) / (c): the profile ------------------------------------------ */
    if (!profileMatch) {
      /* No confident profile match. Before parking it for the AI, ask whether
       * the matcher RECOGNISED the field and the profile leaves it blank on
       * purpose. Salary, and the four EEO self-identification questions, are
       * empty in profile.js because the user must answer them personally — see
       * the comments there. A null match alone cannot tell "no idea" apart
       * from "deliberately blank", which is how a language model ended up
       * inventing a salary figure and picking a protected-class answer. */
      /* --- SCREENING BANK -------------------------------------------------
       * Before either skipping or paying for an AI round trip, try the
       * standard-answer bank. "Have you ever been convicted of a crime",
       * "are you authorised to work here", "willing to relocate" are not
       * facts stored in a resume — they are questions with a normal answer
       * that is the same on nearly every form. Answering them here is
       * instant, works offline, and costs nothing.
       *
       * This runs BEFORE recognisedButBlank on purpose. The EEO questions
       * are blank-on-purpose in the profile, but the bank answers them with
       * the form's own decline-to-answer option, which is a real choice
       * rather than an invented value — strictly better than leaving them
       * empty for him to click through by hand.
       *
       * Anything the bank answers that he later corrects in the ask panel is
       * stored in knowledge.js, which is checked earlier and therefore wins
       * permanently. */
      var screened = screeningAnswer(field, profile);
      if (screened) {
        writeValue(field, screened.value, function (ok) {
          if (ok) {
            tally.screening++;
            /* Legal/consent answers are highlighted amber, not green, and
             * listed in the popup afterwards, so they are visibly "check
             * this" rather than silently accepted. */
            AF.highlight(field.el, screened.review ? 'skip' : 'ok');
            if (screened.review) {
              tally.review.push({
                label: describeField(field),
                value: String(screened.value),
                why: screened.why || '',
              });
            }
            if (tally.firstFilledElement === null) {
              tally.firstFilledElement = field.el;
            }
          } else if (!looksLikeNoiseField(field)) {
            /* The control refused our answer — let the AI read the real
             * option list and choose. */
            tally.aiCandidates.push(field);
          }
          next();
        });
        return;
      }

      var blankOnPurpose = recognisedButBlank(field, profile);
      if (blankOnPurpose) {
        log('leaving "' + describeField(field) + '" for you to answer (' +
          blankOnPurpose.key + ' is blank in your profile on purpose).');
        tally.skipped++;
        AF.highlight(field.el, 'skip');
        next();
        return;
      }

      if (looksLikeNoiseField(field)) {
        /* Search / login / newsletter boxes are never an application question.
         * Do not spend an AI call on them, and never put them on the list of
         * things to ask him about. */
        tally.skipped++;
      } else {
        tally.aiCandidates.push(field);
      }
      next();
      return;
    }

    /* --- write the profile match ----------------------------------------- */
    writeValue(field, profileMatch.value, function (applied) {
      if (applied) {
        tally.deterministic++;
        AF.highlight(field.el, 'ok');
        if (tally.firstFilledElement === null) {
          tally.firstFilledElement = field.el;
        }
      } else {
        /* We knew the answer but the control refused it — most often a
         * <select> whose options do not contain our value (fill.js returns
         * false rather than picking a random option), and lib/widgets.js could
         * not drive it either. Let the AI try, since it can read the option
         * list and choose properly. */
        logWarning('could not apply "' + profileMatch.key + '" to field #' + field.index +
          ' (' + describeField(field) + ')');
        if (looksLikeNoiseField(field)) {
          tally.skipped++;
        } else {
          tally.aiCandidates.push(field);
        }
      }
      next();
    });
  }

  /* ---------------------------------------------------------------------------
   * SECTION 6 — the AI pass
   * -------------------------------------------------------------------------
   * Everything the profile could not answer is sent, as PLAIN DATA, to the
   * service worker. The service worker builds the prompt and POSTs it to the
   * local Spring bridge. See SECTION 7 for why the fetch cannot live here.
   * ------------------------------------------------------------------------ */

  /**
   * Ask the service worker for AI values.
   *
   * @param {Array}    candidates  Field[] (live DOM refs — stripped before send)
   * @param {Object}   profile
   * @param {Function} callback    callback(errorStringOrNull, valuesObject)
   */
  function requestAiValues(candidates, profile, callback) {
    /* AF.toSerialisable removes the live `el` property. This is not optional:
     * chrome.runtime.sendMessage copies its argument with the structured-clone
     * algorithm, and a DOM node cannot be cloned — leaving `el` in place throws
     * "An object could not be cloned" and the whole run dies. */
    var serialisableFields = AF.toSerialisable(candidates);

    var payload = {
      type: MSG_AI_FILL,
      fields: serialisableFields,
      profile: profileForPrompt(profile),
      jobDescription: readJobDescription(),
      pageTitle: safePageTitle(),
      pageUrl: safePageUrl(),
      /* For an embedded ATS iframe this is the careers page that hosts it,
       * which is often the only place the company name appears. */
      referrer: (typeof document.referrer === 'string') ? document.referrer : ''
    };

    try {
      chrome.runtime.sendMessage(payload, function (response) {
        if (chrome.runtime.lastError) {
          callback('The extension background worker did not answer: ' +
            chrome.runtime.lastError.message, null);
          return;
        }
        if (!response || typeof response !== 'object') {
          callback('The extension background worker returned nothing.', null);
          return;
        }
        if (response.ok !== true) {
          callback(typeof response.error === 'string' && response.error !== ''
            ? response.error
            : 'The AI bridge could not answer.', null);
          return;
        }
        callback(null, response.values || {});
      });
    } catch (error) {
      /* "Extension context invalidated" lands here: the extension was reloaded
       * while this page stayed open. A page reload is the only cure. */
      callback('Could not reach the extension background worker (reload the page): ' +
        error, null);
    }
  }

  /**
   * Trim the profile down before it goes into a prompt.
   *
   * profile.aliases is a 500+ entry synonym dictionary that exists purely to
   * help lib/match.js score form labels. It is noise to a language model and
   * would roughly double the prompt size, so it is dropped here.
   */
  function profileForPrompt(profile) {
    var copy = {};
    var keys = Object.keys(profile || {});
    var i;
    for (i = 0; i < keys.length; i++) {
      if (keys[i] === 'aliases') {
        continue;
      }
      copy[keys[i]] = profile[keys[i]];
    }
    return copy;
  }

  function safePageTitle() {
    try {
      return String(document.title || '');
    } catch (error) {
      return '';
    }
  }

  function safePageUrl() {
    try {
      return String(window.location.href || '');
    } catch (error) {
      return '';
    }
  }

  /**
   * Write the AI's answers into the page.
   *
   * Walks the CANDIDATES rather than the answers, because every candidate needs
   * a decision: filled by the AI, or handed on to the ask queue. Sequential and
   * callback-based for the same reason as the deterministic pass — a failed
   * write may be retried through lib/widgets.js, which is asynchronous.
   *
   * @param {Object}   values      { "<field index as string>": "value" | true/false }
   * @param {Array}    candidates  the exact Field[] we asked about
   * @param {Object}   tally       mutated in place
   * @param {Function} done        called with no arguments when all are handled
   */
  function applyAiValues(values, candidates, profile, tally, done) {
    var answers = values || {};

    /* Anything the model answered for a field we did not ask about is dropped.
     *
     * SECURITY-ISH POINT: the loop below only ever reads answers BY CANDIDATE.
     * If the model hallucinated an index for a field we already filled from the
     * profile, that key is never looked up. The AI can never overwrite a
     * deterministic answer or one he taught us. */
    var asked = {};
    var i;
    for (i = 0; i < candidates.length; i++) {
      asked[String(candidates[i].index)] = true;
    }
    var answeredKeys = Object.keys(answers);
    for (i = 0; i < answeredKeys.length; i++) {
      if (asked[answeredKeys[i]] !== true) {
        logWarning('the AI answered for field #' + answeredKeys[i] +
          ', which we did not ask about — ignored.');
      }
    }

    var position = 0;
    var sinceYield = 0;

    function step() {
      if (position >= candidates.length) {
        done();
        return;
      }

      var field = candidates[position];
      position++;

      try {
        applyOneAiValue(field, answers[String(field.index)], profile, tally, next);
      } catch (error) {
        logWarning('field #' + field.index + ' threw while applying an AI value:', error);
        tally.skipped++;
        next();
      }
    }

    /* Same stack-unwinding trick as the deterministic loop — see
     * FIELDS_PER_YIELD in SECTION 1. */
    function next() {
      sinceYield++;
      if (sinceYield >= FIELDS_PER_YIELD) {
        sinceYield = 0;
        setTimeout(step, 0);
        return;
      }
      step();
    }

    step();
  }

  /**
   * One candidate: either the AI answered it, or it becomes a question for him.
   *
   * @param {Function} next  call exactly once, whatever happens
   */
  function applyOneAiValue(field, value, profile, tally, next) {

    /* --- no answer, or an empty one -------------------------------------- *
     * The prompt tells the model in so many words that omitting a field is a
     * good answer, so this is the expected path for a salary box. It gets an
     * amber outline when it is required, and it goes on the ask list: the
     * whole point of the queue is that HE can answer it once, and then it is
     * answered for ever. */
    if (value === null || value === undefined ||
        (typeof value === 'string' && value.trim() === '')) {
      /* The model declined this one. Before giving up, let intuition.js try:
       * it answers from ordinary judgement and only refuses the two cases
       * where guessing is actively harmful (a credential he must supply, an
       * unset salary expectation). Those still land on the ask queue. */
      var guess = intuitionAnswer(field, profile);
      if (guess && guess.value !== null && guess.value !== undefined && guess.value !== '') {
        writeValue(field, guess.value, function (applied) {
          if (applied) {
            tally.guessed++;
            AF.highlight(field.el, 'skip'); // amber: filled, but check it
            if (tally.firstFilledElement === null) {
              tally.firstFilledElement = field.el;
            }
            tally.askCandidates.push(field); // still worth teaching a real answer
          } else {
            tally.skipped++;
            tally.askCandidates.push(field);
          }
          next();
        });
        return;
      }

      tally.skipped++;
      if (field.required === true) {
        AF.highlight(field.el, 'skip');
      }
      tally.askCandidates.push(field);
      next();
      return;
    }

    /* The AI round trip takes seconds. React may have re-rendered and thrown
     * our element away in the meantime; writing to a detached node changes
     * nothing the user can see. */
    if (field.el && field.el.isConnected === false) {
      logWarning('field #' + field.index + ' left the DOM while the AI was thinking — skipped.');
      tally.skipped++;
      next();
      return;
    }

    /* Do not clobber something the user typed while waiting. */
    if (!isStillEmpty(field) && OVERWRITE_ALREADY_FILLED === false) {
      tally.skipped++;
      next();
      return;
    }

    writeValue(field, value, function (applied) {
      if (applied) {
        tally.ai++;
        /* Blue outline, not green: an AI answer is a suggestion and the user
         * should read it before submitting. */
        AF.highlight(field.el, 'ai');
        if (tally.firstFilledElement === null) {
          tally.firstFilledElement = field.el;
        }
      } else {
        tally.skipped++;
        AF.highlight(field.el, 'skip');
        /* The model had an answer and the control refused it — a dropdown
         * whose options it could not match, usually. He can pick the right
         * option once in ask.html and we will remember it. */
        tally.askCandidates.push(field);
      }
      next();
    });
  }

  /* ---------------------------------------------------------------------------
   * SECTION 6b — step (e): the ask queue
   * -------------------------------------------------------------------------
   * Everything that survived the knowledge store, the profile, and the AI is a
   * genuine open question. Rather than leaving him to spot the amber outlines,
   * the fields are parked in chrome.storage.local under 'pendingQuestions' and
   * ask.html walks them one card at a time. Whatever he types goes into
   * lib/knowledge.js, and the NEXT form that asks the same thing fills itself.
   *
   * TWO RULES THAT MATTER
   *
   *   1. ONLY SERIALISABLE FIELDS GO IN. AF.toSerialisable strips the live
   *      `el` DOM node. chrome.storage copies its argument with the structured
   *      clone algorithm and a DOM node cannot be cloned — leaving `el` in
   *      place would throw and the whole queue write would be lost.
   *
   *   2. DE-DUPLICATE BY AF.knowledge.qKey. That key is deliberately company-
   *      neutral, so "Why do you want to work at Acme?" and "Why do you want to
   *      work at Globex?" collapse into ONE question. Five job sites asking the
   *      same thing must cost him one answer, not five.
   * ------------------------------------------------------------------------ */

  /**
   * Append this run's unanswered fields to the stored queue.
   *
   * Never fails the run: a storage error is logged and the callback still fires
   * with whatever count we know, because the fill itself already succeeded and
   * the popup has a result to show.
   *
   * @param {Array}    candidates  Field[] with live DOM references
   * @param {Function} done        called as done(totalPendingCount)
   */
  function queuePendingQuestions(candidates, done) {
    var serialisable = [];

    try {
      /* One call converts the whole array and drops every `el`. */
      var stripped = AF.toSerialisable(candidates);
      var url = safePageUrl();
      var title = safePageTitle();
      var now = Date.now();
      var i;

      for (i = 0; i < stripped.length; i++) {
        var entry = stripped[i];

        /* Provenance, so ask.html can show "asked by <site>" and link back.
         * ask.js accepts `url`, `pageUrl` or `sourceUrl`; we send the first
         * two because they cost nothing and remove a guess. */
        entry.url = url;
        entry.pageUrl = url;
        entry.pageTitle = title;
        entry.askedAt = now;

        serialisable.push(entry);
      }
    } catch (error) {
      logWarning('could not prepare the pending questions:', error);
      serialisable = [];
    }

    /* Read the existing queue, merge, write back. Read-modify-write rather
     * than a blind append, because a fill running in another tab may have
     * added questions since this page loaded. */
    try {
      chrome.storage.local.get([PENDING_KEY], function (stored) {
        if (chrome.runtime.lastError) {
          logWarning('could not read the pending questions:', chrome.runtime.lastError.message);
          done(0);
          return;
        }

        var existing = (stored && Array.isArray(stored[PENDING_KEY])) ? stored[PENDING_KEY] : [];
        var merged = mergePendingQuestions(existing, serialisable);

        /* Nothing new AND nothing dropped: skip the write entirely. A write
         * would wake every other tab's storage listener for nothing, and — on
         * a page whose form lives in an iframe, where this code runs in several
         * frames at once — every write is a chance for two frames to overwrite
         * each other's read-modify-write. Not writing when there is nothing to
         * say is the cheapest possible protection against that. */
        if (merged.length === existing.length && serialisable.length === 0) {
          done(merged.length);
          return;
        }

        var payload = {};
        payload[PENDING_KEY] = merged;

        chrome.storage.local.set(payload, function () {
          if (chrome.runtime.lastError) {
            logWarning('could not save the pending questions:', chrome.runtime.lastError.message);
            done(existing.length);
            return;
          }
          if (merged.length > existing.length) {
            log('added ' + (merged.length - existing.length) +
              ' question(s) to your "answer these" list.');
          }
          done(merged.length);
        });
      });
    } catch (error) {
      /* "Extension context invalidated" — the extension was reloaded while
       * this page stayed open. Nothing to save to. */
      logWarning('chrome.storage is unavailable, the questions were not saved:', error);
      done(0);
    }
  }

  /**
   * Merge new questions into the stored queue, de-duplicated by question key.
   *
   * @param {Array} existing  what is already in storage (may contain junk)
   * @param {Array} incoming  this run's serialisable fields
   * @returns {Array} the array to write back, oldest first, capped
   */
  function mergePendingQuestions(existing, incoming) {
    var out = [];
    var seenKeys = {};
    var seenFallback = {};
    var i;

    /* Keep the existing entries first so the oldest question stays at the top
     * of his list, and so the cap below drops the NEWEST rather than throwing
     * away something he has been waiting to answer. */
    for (i = 0; i < existing.length; i++) {
      acceptPendingEntry(existing[i], out, seenKeys, seenFallback);
    }
    for (i = 0; i < incoming.length; i++) {
      acceptPendingEntry(incoming[i], out, seenKeys, seenFallback);
    }

    if (out.length > MAX_PENDING_QUESTIONS) {
      out = out.slice(0, MAX_PENDING_QUESTIONS);
    }

    return out;
  }

  /**
   * Should this entry go on the queue? Pushes it onto `out` when yes.
   *
   * Rejected: anything that is not a plain object, anything with no readable
   * question text, anything he has already dealt with (answered, left blank,
   * or silenced), and any duplicate.
   */
  function acceptPendingEntry(entry, out, seenKeys, seenFallback) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return false;
    }

    /* Already answered / already silenced — drop it, and note that this also
     * CLEANS UP the stored queue: a question he answered on another machine,
     * or through a different route, disappears from the list by itself. */
    if (learnedRecordFor(entry) !== null) {
      return false;
    }

    var key = questionKeyFor(entry);

    if (key !== '') {
      if (seenKeys[key] === true) {
        return false;
      }
      seenKeys[key] = true;
      out.push(entry);
      return true;
    }

    /* No question key. Either lib/knowledge.js is missing, or the field has no
     * wording at all. Fall back to the field's own identifying text so the
     * queue still de-duplicates instead of growing a copy per fill. A field
     * with no text whatsoever is dropped: it could never be displayed as a
     * question, and ask.js would discard it anyway. */
    var fallback = normaliseText(fieldOwnText(entry));
    if (fallback === '') {
      return false;
    }
    if (seenFallback[fallback] === true) {
      return false;
    }
    seenFallback[fallback] = true;
    out.push(entry);
    return true;
  }


  /* ---------------------------------------------------------------------------
   * SECTION 7 — the four run functions
   * ------------------------------------------------------------------------ */

  /**
   * FILL_ALL and FILL_DETERMINISTIC share this function; `useAi` is the only
   * difference. FILL_DETERMINISTIC stops after the profile pass and never
   * touches the network, so it works with the bridge switched off entirely.
   *
   * @param {Array}    fields  the already-scraped Field[] (scraped once, by the
   *                           message listener, so the silence decision and the
   *                           fill agree on what is on the page)
   * @param {Boolean}  useAi
   * @param {Function} done    callback(responseObject)
   */
  function runFill(fields, useAi, done) {
    /* The learned answers have to be in memory BEFORE the first field is
     * looked at, because AF.knowledge.lookup is synchronous. One storage read
     * per run, exactly like the profile. */
    loadKnowledge(function () {
      loadProfile(function (profile) {
        var tally = newTally();

        /* Record the "before" state FIRST, so Undo can put everything back even
         * if a later stage throws. AF.snapshot keeps the buffer internally.
         *
         * This runs on EVERY fill, including the second and third one. That is
         * safe by design: AF.snapshot only ADDS records for controls it has not
         * seen since the last Undo, so pressing Fill twice cannot overwrite the
         * genuinely original values with the autofilled ones. */
        try {
          AF.snapshot(fields);
        } catch (error) {
          logWarning('snapshot failed, Undo will not work for this run:', error);
        }

        applyDeterministicMatches(fields, profile, tally, function () {

          /* Bring the first thing we changed into view, so the user immediately
           * sees that something happened. */
          if (tally.firstFilledElement) {
            AF.scrollToFirst(tally.firstFilledElement);
          }

          /* --- deterministic-only path: answer now ------------------------ */
          if (!useAi) {
            /* Every field we chose not to fill counts as skipped — and every
             * one of them is a question worth asking him, because with the AI
             * switched off step (d) never ran and step (e) is all that is
             * left. */
            tally.skipped += tally.aiCandidates.length;
            appendAll(tally.askCandidates, tally.aiCandidates);
            finishRun(tally, done);
            return;
          }

          /* --- nothing left for the AI: answer now ------------------------ */
          if (tally.aiCandidates.length === 0) {
            finishRun(tally, done);
            return;
          }

          log('asking the AI bridge about ' + tally.aiCandidates.length + ' field(s)…');

          requestAiValues(tally.aiCandidates, profile, function (errorText, values) {
            if (errorText) {
              /* THE IMPORTANT BIT: an offline or broken bridge must degrade to
               * "deterministic only", never to a failed run. The profile fields
               * are already in the page and they stay there.
               *
               * It used to stop there, and every AI candidate was left blank —
               * a form with thirty empty boxes and a note saying "AI step
               * skipped". That is the worst outcome available: a blank costs
               * him reading, thinking and typing, where a wrong guess costs two
               * seconds to correct. So fall through to lib/intuition.js, which
               * answers everything from ordinary judgement, offline. Every one
               * of its answers is amber and listed for review, and anything he
               * corrects once is remembered by knowledge.js and never guessed
               * again. */
              logWarning('AI stage unavailable:', errorText);

              applyIntuition(tally.aiCandidates, profile, tally, function (filled) {
                tally.warning = 'AI unavailable (' + errorText + ') — ' + filled +
                  ' field(s) filled from built-in judgement instead. They are amber: check them.';
                if (tally.firstFilledElement) {
                  AF.scrollToFirst(tally.firstFilledElement);
                }
                finishRun(tally, done);
              });
              return;
            }

            applyAiValues(values, tally.aiCandidates, profile, tally, function () {
              if (tally.firstFilledElement) {
                AF.scrollToFirst(tally.firstFilledElement);
              }
              finishRun(tally, done);
            });
          });
        });
      });
    });
  }

  /** Push every element of `source` onto `target`. (No spread syntax: plain
   *  readable ES5, like the rest of this project.) */
  function appendAll(target, source) {
    var i;
    for (i = 0; i < source.length; i++) {
      target.push(source[i]);
    }
  }

  /**
   * The last thing every fill does: park the unanswered fields on the "ask me"
   * queue, then answer the popup with the counters INCLUDING how many questions
   * are now waiting.
   *
   * The response is deliberately built after the storage write, so the number
   * the popup shows is the number that is really in storage — not an optimistic
   * guess that a failed write would make a lie.
   */
  function finishRun(tally, done) {
    /* Called even when this run has nothing new to ask, and deliberately so.
     * queuePendingQuestions also CLEANS the stored queue: it drops questions
     * that have since been answered, silenced, or corrupted. Skipping it on a
     * clean run would leave a question he answered last week sitting on the
     * list for ever. It writes nothing when nothing changed. */
    queuePendingQuestions(tally.askCandidates, function (count) {
      tally.pending = count;
      done(buildResponse(tally));
    });
  }

  /**
   * Turn the tally into the exact response shape popup.js expects.
   * Missing keys render as 0 in the popup, but sending them all explicitly
   * makes the contract obvious to anyone reading this file.
   */
  function buildResponse(tally) {
    return {
      ok: true,
      error: '',
      deterministic: tally.deterministic,
      /* Filled from an answer he typed into the extension himself. */
      learned: tally.learned,
      ai: tally.ai,
      guessed: tally.guessed,
      skipped: tally.skipped,
      manual: tally.manual,
      /* How many questions are sitting in 'pendingQuestions' RIGHT NOW —
       * this run's leftovers plus anything still waiting from earlier forms.
       * The popup turns this into the "N questions need your answer" badge. */
      pending: tally.pending,
      /* Non-fatal problem, '' when the run was clean. Rendered in its own
       * amber line by the popup, never in the "Needs you" list. */
      warning: tally.warning
    };
  }

  /** UNDO — restore whatever AF.snapshot recorded before the last fill. */
  function runUndo(done) {
    var restored = false;
    try {
      restored = AF.restore();
    } catch (error) {
      logWarning('undo failed:', error);
      restored = false;
    }

    /* How much of the undo actually worked. A radio group that a strictly
     * controlled React form refuses to clear, or a dropdown whose option list
     * was rebuilt, cannot always be put back — and the popup used to claim a
     * perfect undo regardless. Pass the counts on so it can tell the truth. */
    var report = { restored: 0, failed: 0, failedLabels: [] };
    try {
      if (typeof AF.lastRestoreReport === 'function') {
        report = AF.lastRestoreReport();
      }
    } catch (error) {
      logWarning('could not read the undo report:', error);
    }

    /* popup.js special-cases `restored === false` into "nothing to undo". */
    done({
      ok: true,
      restored: restored,
      restoredCount: report.restored,
      failedCount: report.failed,
      failedFields: report.failedLabels
    });
  }

  /**
   * SCAN — fill nothing, just print the field inventory to the PAGE console.
   * This is the first thing to run on a new ATS: it shows whether the scraper
   * can see the form at all before any value is written.
   */
  function runScan(fields, done) {
    var count = fields.length;
    try {
      /* AF.debugDump re-scrapes and prints a console.table. The second scrape
       * costs a millisecond and keeps the printed table identical to what the
       * user would get by typing AF.debugDump() themselves. */
      var dumped = AF.debugDump();
      count = dumped.length;
    } catch (error) {
      logWarning('debugDump failed, falling back to a plain log:', error);
      log('scraped ' + count + ' field(s):', AF.toSerialisable(fields));
    }
    done({ ok: true, count: count, total: count });
  }

  /* ---------------------------------------------------------------------------
   * SECTION 8 — the message listener
   * -------------------------------------------------------------------------
   * Read the header comment at the top of this file before changing anything
   * here. The `return true` / `return undefined` decision is the single most
   * error-prone line in the whole extension.
   * ------------------------------------------------------------------------ */

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {

    /* --- is this even for us? ------------------------------------------- */
    if (!message || typeof message !== 'object') {
      return; /* undefined -> channel closes immediately. */
    }

    var type = message.type;
    if (type !== MSG_FILL_ALL && type !== MSG_FILL_DETERMINISTIC &&
        type !== MSG_UNDO && type !== MSG_SCAN) {
      return; /* Not one of ours (e.g. a message meant for background.js). */
    }

    /* --- are the libraries actually loaded? ------------------------------ */
    if (typeof AF.scrapeFields !== 'function' ||
        typeof AF.matchAll !== 'function' ||
        typeof AF.setValue !== 'function') {
      /* One of the lib/ files failed to parse. Answering with a clear error is
       * far better than silence, which the popup can only describe as
       * "reload the page". */
      sendResponse({
        ok: false,
        error: 'The extension libraries did not load on this page. Reload the extension at chrome://extensions.'
      });
      return; /* Answered synchronously, so no `return true` needed. */
    }

    /* --- scrape once, synchronously -------------------------------------- */
    /* This must happen BEFORE we decide whether to keep the channel open,
     * because that decision has to be made synchronously (see below). */
    var fields = [];
    try {
      fields = AF.scrapeFields(document);
    } catch (error) {
      logWarning('scrape failed:', error);
      fields = [];
    }

    /* --- THE SILENCE RULE ------------------------------------------------ *
     * With "all_frames": true this listener exists in every frame of the tab,
     * and chrome.tabs.sendMessage (sent without a frameId) reaches all of
     * them. The first frame to call sendResponse wins.
     *
     * A frame with no fillable fields — an ad iframe, a tracking pixel, a
     * cookie banner — must therefore say nothing at all and let the frame with
     * the real form answer. "Saying nothing" means returning undefined here:
     * returning true would hold the reply channel open, and if EVERY frame did
     * that the popup would wait forever for an answer that never comes.
     *
     * UNDO is the exception: after a fill, the frame that did the filling is
     * the one holding the snapshot, so it must answer even if the form has
     * since been re-rendered and scrapes as empty.
     * -------------------------------------------------------------------- */
    var hasSnapshot = false;
    try {
      hasSnapshot = (typeof AF.hasSnapshot === 'function') ? AF.hasSnapshot() : false;
    } catch (error) {
      hasSnapshot = false;
    }

    if (fields.length === 0 && !(type === MSG_UNDO && hasSnapshot)) {
      return; /* Silence. This frame has nothing to offer. */
    }

    /* --- from here on we WILL answer, but not synchronously -------------- */

    /* respondOnce guards three separate hazards:
     *   1. calling sendResponse twice (Chrome logs an error),
     *   2. calling it after the popup closed (the port is gone and the call
     *      throws — harmless, but it must not break the run),
     *   3. never calling it at all because of a bug (the watchdog). */
    var alreadyAnswered = false;

    function respondOnce(response) {
      if (alreadyAnswered) {
        return;
      }
      alreadyAnswered = true;
      clearTimeout(watchdogTimer);

      /* Tiny frames (a search box, a newsletter form) answer late on purpose,
       * so that the frame holding the real application form wins the race and
       * the popup shows its counters instead. */
      var delay = (fields.length < SMALL_FRAME_FIELD_COUNT) ? SMALL_FRAME_ANSWER_DELAY_MS : 0;

      setTimeout(function () {
        try {
          sendResponse(response);
        } catch (error) {
          /* The popup was closed before we finished. The page has still been
           * filled correctly; there is simply nobody left to tell. */
          log('nobody was listening for the result (popup closed).');
        }
      }, delay);
    }

    var watchdogTimer = setTimeout(function () {
      respondOnce({ ok: false, error: 'Timed out while filling this page.' });
    }, WATCHDOG_MS);

    /* --- dispatch --------------------------------------------------------- */
    try {
      if (type === MSG_FILL_ALL) {
        runFill(fields, true, respondOnce);
      } else if (type === MSG_FILL_DETERMINISTIC) {
        runFill(fields, false, respondOnce);
      } else if (type === MSG_UNDO) {
        runUndo(respondOnce);
      } else if (type === MSG_SCAN) {
        runScan(fields, respondOnce);
      }
    } catch (error) {
      logWarning('run failed:', error);
      respondOnce({ ok: false, error: 'The fill failed: ' + error });
    }

    /* THE line. Everything above is asynchronous (storage read, then possibly
     * a bridge call), so the reply channel must be held open. Returning
     * anything falsy here closes it and the popup receives `undefined`. */
    return true;
  });

  /* ---------------------------------------------------------------------------
   * SECTION 9 — ready
   * ------------------------------------------------------------------------ */

  /* Logged once per frame. On a Greenhouse page you will see this line two or
   * three times, once per frame — that is expected, not a bug. */
  log('ready on ' + safePageUrl());

  /* The two NEW libraries are optional at runtime: if either is missing the
   * extension still fills forms exactly as it did before, it just loses the
   * feature. Saying so once, here, turns "why did it stop remembering my
   * answers?" into a one-line answer in the console instead of an afternoon.
   *
   * If you see either warning, check that manifest.json lists the file in
   * content_scripts.js[] in the documented order and reload the extension at
   * chrome://extensions. */
  if (!knowledgeAvailable()) {
    logWarning('lib/knowledge.js is not loaded — saved answers and the ' +
      '"questions for you" list are disabled on this page.');
  }
  if (!AF.widgets || typeof AF.widgets.setCustomDropdown !== 'function') {
    logWarning('lib/widgets.js is not loaded — React / Workday style fake ' +
      'dropdowns cannot be filled on this page.');
  }

})();
