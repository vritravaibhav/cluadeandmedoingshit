/* =============================================================================
 * autofill / extension / lib / knowledge.js
 * -----------------------------------------------------------------------------
 * WHAT THIS FILE IS FOR
 *   The extension can answer the obvious boxes from the profile (match.js) and
 *   can ask the local AI about the odd ones. There is a third case, and this
 *   file owns it:
 *
 *       "I have no idea what this box wants. ASK THE USER, and never ask him
 *        the same thing twice."
 *
 *   So this is the LEARNED-ANSWER MEMORY. When the user types an answer into
 *   the extension's own "questions for you" list, we store it here keyed by a
 *   normalised form of the question. The next time ANY site asks that same
 *   question — Greenhouse today, Workday next month — the answer is already
 *   known and the box fills itself.
 *
 *   It also keeps an audit log of the plain-language facts he typed into the
 *   chatbot ("my address changed", "I now have 3 years of experience"), so the
 *   chat UI can show him what it changed and offer to undo it.
 *
 * WHERE IT LIVES
 *   chrome.storage.local, under the single key 'knowledge'. That is the only
 *   storage in Chrome that survives a browser restart AND a device restart,
 *   which is exactly what the user asked for. NOT sessionStorage, NOT
 *   chrome.storage.session, and NOT the module-level cache in this file.
 *
 * THE STORED SHAPE
 *   {
 *     version: 1,
 *     answers: [
 *       {
 *         qKey:       String,   // normalised question key — see AF.knowledge.qKey
 *         question:   String,   // the human wording we saw, for display only
 *         answer:     *,        // String | Boolean | Number | String[]
 *         kind:       String,   // field kind at learn time: text|select|radio|...
 *         options:    Array,    // [{value, text}] when it was a select/radio
 *         learnedAt:  Number,   // epoch millis, when we FIRST learned it
 *         lastUsedAt: Number,   // epoch millis, last remember()/touch()  (*)
 *         useCount:   Number,   // how many times it has been confirmed/used
 *         sourceUrl:  String    // where we first saw it (origin + path only)
 *       }, ...
 *     ],
 *     facts: [
 *       { text: String, appliedPatch: Object|null, at: Number }, ...
 *     ]
 *   }
 *
 *   (*) lastUsedAt is not in the original written spec. It has to exist: the
 *       spec also demands LRU eviction, and "least recently used" is
 *       unanswerable without a per-record timestamp of the last use. It is an
 *       ADDITION to the record, never a replacement for anything — every field
 *       named in the spec is still present and still means what it says.
 *
 * A NOTE FOR THE READER (Java/Spring + Flutter dev, not a JS dev)
 *   - `var AF = (globalThis.AF = globalThis.AF || {});` is the singleton idiom
 *     used by every file here: "give me AF, creating it if I loaded first".
 *   - The body is wrapped in an IIFE — `(function () { ... })();` — which is
 *     JS's private static block. Only what we assign onto AF escapes.
 *   - A `Promise` is a `CompletableFuture`. `await x` is `x.join()`, except it
 *     does not block a thread. Everything that touches storage returns one,
 *     because chrome.storage is asynchronous with no synchronous twin.
 *
 * PUBLIC API (exact names — three other modules are written against these)
 *   AF.knowledge.load()                   -> Promise<store>
 *   AF.knowledge.qKey(field, companyName) -> String
 *   AF.knowledge.lookup(field, company)   -> answer record | null   (SYNCHRONOUS)
 *   AF.knowledge.remember(field, answer)  -> Promise<void>
 *   AF.knowledge.forget(qKey)             -> Promise<Boolean>
 *   AF.knowledge.all()                    -> Promise<Array>
 *   AF.knowledge.addFact(text, patch)     -> Promise<void>
 *   AF.knowledge.stats()                  -> Promise<{answers, facts, totalUses}>
 *   AF.knowledge.matchFromKnowledge(f)    -> {key:'knowledge', value, confidence} | null
 *
 * EXTRAS (not in the original list, added because the UI genuinely needs them —
 * they take nothing away from the API above)
 *   AF.knowledge.lookupByKey(qKey)        -> answer record | null   (SYNCHRONOUS)
 *   AF.knowledge.touch(qKey)              -> Promise<Boolean>  "this one was used"
 *   AF.knowledge.allFacts()               -> Promise<Array>    the chat audit log
 *   AF.knowledge.removeFact(at)           -> Promise<Boolean>  undo a chat entry
 *   AF.knowledge.STORAGE_KEY / .VERSION / .MAX_ANSWERS / .MAX_FACTS / .CONFIDENCE
 * ===========================================================================*/

var AF = (globalThis.AF = globalThis.AF || {});

(function () {
  'use strict';

  /* ===========================================================================
   * SECTION 1 — constants
   * =========================================================================*/

  /** The one and only chrome.storage.local key this module owns. */
  var STORAGE_KEY = 'knowledge';

  /** Bump ONLY when the stored shape changes. An unknown version starts fresh. */
  var STORE_VERSION = 1;

  /** Hard caps, so storage cannot grow without bound. LRU is evicted first. */
  var MAX_ANSWERS = 500;
  var MAX_FACTS = 200;

  /** Confidence reported by matchFromKnowledge. Deliberately below 1.0
   *  (an exact profile hit) but far above AF.MIN_CONFIDENCE (0.55): the user
   *  himself typed this answer, so it beats every guess, yet it is still a
   *  remembered answer rather than a fact from the resume. */
  var KNOWLEDGE_CONFIDENCE = 0.95;

  /** Longest qKey we ever produce. See makeKey() for what happens past it. */
  var MAX_KEY_LENGTH = 120;

  /** Display / storage caps so one pathological page cannot bloat the store. */
  var MAX_QUESTION_LENGTH = 300;
  var MAX_ANSWER_LENGTH = 5000;   /* cover letters are legitimately long */
  var MAX_OPTIONS = 40;
  var MAX_OPTION_TEXT = 120;
  var MAX_FACT_LENGTH = 2000;
  var MAX_URL_LENGTH = 200;

  /**
   * Words dropped from a question key. These carry no meaning for identifying
   * WHICH question is being asked, and different sites sprinkle them
   * differently ("What is your notice period" vs "Notice period").
   *
   * Keep this list SHORT. Every word added here is a word that can no longer
   * tell two questions apart.
   *
   * TWO ENTRIES HAVE A HISTORY — do not "tidy" them back:
   *
   *   'what' and 'which' are here because the comment above promises that
   *   "What is your notice period" and "Notice period" land on the same key,
   *   and dropping only 'is' and 'your' did not achieve that. They are pure
   *   question wrappers: no real form question is identified by them.
   *
   *   'how', 'when', 'where' and 'who' are deliberately NOT here, and must
   *   never be added. They are load-bearing:
   *       "How many years..."  vs  "How did you hear..."
   *       "When can you start" vs  "Where can you start"
   *   Removing them would merge genuinely different questions.
   *
   *   'us' is deliberately NOT here either, although 'we' and 'our' are.
   *   normaliseText lowercases before this list is applied, so by the time we
   *   look at the word there is no way to tell the pronoun "us" from the
   *   country code "US". Dropping it made "US Salary Expectation" collapse
   *   onto "Salary Expectation" and "Are you a US citizen?" onto "Are you a
   *   citizen?" — while "UK", "EU" and "INR" all survived, so the form lost
   *   exactly one side of a distinction it was drawing on purpose. The
   *   pronoun sense ("How did you hear about us?") costs us nothing to keep.
   */
  var STOPWORDS = [
    'the', 'a', 'an',
    'your', 'you',
    'please',
    'do', 'does', 'did',
    'is', 'are',
    'we', 'our',
    'what', 'which'
  ];

  /**
   * Form-decoration words that mean "this box is compulsory / not compulsory".
   * They describe the BOX, never the QUESTION, so "Email *" and "Email" must
   * land on the same key. (scrape.js already strips most of these from
   * field.label; we repeat it here because qKey is also called with raw strings
   * from the options page and the chat box.)
   */
  var DECORATION_WORDS = ['required', 'optional', 'mandatory'];

  /**
   * Legal-entity suffixes. "Acme", "Acme Inc", "Acme Inc." and "Acme Pvt Ltd"
   * are the same employer, and a question key must not depend on which spelling
   * the careers page used.
   */
  var COMPANY_SUFFIXES = [
    'inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation',
    'company', 'gmbh', 'plc', 'pvt', 'pte', 'ag', 'bv', 'nv', 'sa', 'sas',
    'srl', 'oy', 'ab', 'holdings', 'group'
  ];

  /**
   * THE "…work at <EMPLOYER>" TAIL RULE HAS BEEN DELETED. READ THIS BEFORE
   * PUTTING IT BACK.
   *
   * There used to be a caseless heuristic here: a verb from
   *     ['work','working','works','join','joining','apply','applying']
   * followed by a preposition from ['at','for','with','to'] followed by one to
   * four more words meant "those last words are the employer's name, throw
   * them away". It was there so the key would be company-neutral even when the
   * caller did not know the employer.
   *
   * It threw away the SUBJECT OF THE QUESTION far more often than it threw
   * away a company name, and everything it threw away was thrown away at
   * confidence 0.95:
   *
   *   "Are you comfortable working with React?"    ]
   *   "Are you comfortable working with Java?"     ]-> ONE key: comfortable-with-working
   *   "Are you comfortable working with children?" ]
   *
   *   "Are you applying for an internship?"  ]
   *   "Are you applying for a referral?"     ]-> ONE key: applying-for
   *
   *   "Are you willing to work at night?"           ]
   *   "Are you willing to work at our Pune office?" ]-> ONE key: at-to-willing-work
   *
   * The last group shows that even 'at' — the one preposition that really does
   * usually introduce an employer — is not safe on its own. Since normaliseText
   * has already destroyed capitalisation by the time the rule ran, there was no
   * way left to tell "Acme" from "night".
   *
   * WHAT REPLACES IT: step 4 (buildCompanyWordSet) and nothing else. The
   * employer's name is removed because the CALLER TOLD US what the employer is,
   * not because a word happened to sit after a preposition. content.js derives
   * the employer from the page URL and passes it on every call, and it staples
   * the same name onto every queued question so ask.js remembers the answer
   * under exactly the same key. See SECTION 4 for the worked examples.
   *
   * When no employer name is available the key simply keeps the company's name
   * in it. That is the SAFE failure: the same question at a second employer
   * gets asked once more, instead of being answered with the wrong value.
   */

  /* ===========================================================================
   * SECTION 2 — module-level cache
   *
   * READ THIS BEFORE CHANGING ANYTHING BELOW.
   *
   * `_cache` is a CONVENIENCE, never the truth. The truth is always
   * chrome.storage.local. Three rules keep the two honest:
   *
   *   1. Every mutation re-reads storage, changes what it read, writes it back,
   *      and only then updates _cache. It never mutates _cache and hopes.
   *   2. A chrome.storage.onChanged listener refreshes _cache when ANOTHER
   *      context writes (the options page, the popup, a second tab). Without
   *      it, two tabs would silently diverge and the last one to write would
   *      quietly delete the other's answers.
   *   3. In an MV3 service worker this whole module is thrown away when the
   *      worker is evicted. That is FINE precisely because of rule 1 — nothing
   *      lives here that is not already on disk.
   *
   * The only thing _cache is really needed for is lookup(), which has to be
   * synchronous: match.js and the filler run in a tight non-async loop over
   * every field on the page, and awaiting storage per field would be both slow
   * and a rewrite of code that already works.
   * =========================================================================*/

  /** The last known store, or null when load() has never run here. */
  var _cache = null;

  /**
   * Mutations are serialised through this promise chain.
   *
   * Why: remember() is read-modify-write. If the user answers three questions
   * in the same tick, three overlapping read-modify-writes would each read the
   * SAME old store and the last write would win, losing two answers. Chaining
   * them means each one reads what the previous one wrote.
   *
   * (Java analogy: a single-threaded ExecutorService around the critical
   * section. It only serialises within one JS context, which is why rule 1
   * above — always re-read storage — still matters across contexts.)
   */
  var _writeChain = Promise.resolve();

  /** So the "storage is unavailable" warning is printed once, not per call. */
  var _warnedNoStorage = false;

  /* ===========================================================================
   * SECTION 3 — tiny helpers
   * =========================================================================*/

  /** Never throw on null/undefined; always hand back a String. */
  function safeString(value) {
    if (value === null || value === undefined) {
      return '';
    }
    return String(value);
  }

  /** Cut a string to `max` characters. Returns '' for anything non-stringy. */
  function cap(text, max) {
    var s = safeString(text);
    if (s.length > max) {
      return s.slice(0, max);
    }
    return s;
  }

  /** Prefixed console logging, matching the rest of the extension. */
  function logWarning() {
    var args = ['[AF.knowledge]'];
    var i;
    for (i = 0; i < arguments.length; i++) {
      args.push(arguments[i]);
    }
    console.warn.apply(console, args);
  }

  /** True when chrome.storage.local is actually usable right now. */
  function hasStorage() {
    try {
      return !!(typeof chrome !== 'undefined' &&
        chrome.storage &&
        chrome.storage.local &&
        typeof chrome.storage.local.get === 'function');
    } catch (error) {
      /* Reading chrome.* can throw after the extension is reloaded while an
       * old content script is still alive on the page. */
      return false;
    }
  }

  /**
   * Promise wrapper around chrome.storage.local.get for our single key.
   * Resolves with the RAW stored value (whatever it is), or undefined.
   *
   * Note the callback style rather than the promise-returning chrome API: it
   * works on every Chrome version the extension supports, and it lets us read
   * chrome.runtime.lastError, which MUST be read inside the callback or Chrome
   * logs an "unchecked runtime.lastError" warning.
   */
  function storageGet() {
    return new Promise(function (resolve) {
      if (!hasStorage()) {
        if (!_warnedNoStorage) {
          _warnedNoStorage = true;
          logWarning('chrome.storage is unavailable here; learned answers will NOT persist.');
        }
        resolve(undefined);
        return;
      }

      try {
        chrome.storage.local.get([STORAGE_KEY], function (stored) {
          if (chrome.runtime.lastError) {
            logWarning('read failed:', chrome.runtime.lastError.message);
            resolve(undefined);
            return;
          }
          resolve(stored ? stored[STORAGE_KEY] : undefined);
        });
      } catch (error) {
        logWarning('read threw:', error);
        resolve(undefined);
      }
    });
  }

  /**
   * Promise wrapper around chrome.storage.local.set for our single key.
   * Resolves true on success, false when the write did not happen — the caller
   * decides what to tell the user, but we never throw and never lose the cache.
   */
  function storageSet(store) {
    return new Promise(function (resolve) {
      if (!hasStorage()) {
        resolve(false);
        return;
      }

      var payload = {};
      payload[STORAGE_KEY] = store;

      try {
        chrome.storage.local.set(payload, function () {
          if (chrome.runtime.lastError) {
            /* The usual cause is QUOTA_BYTES. The caps in this file exist to
             * make that impossible, but a corrupt oversized record could still
             * do it, so say so out loud rather than failing silently. */
            logWarning('write failed:', chrome.runtime.lastError.message);
            resolve(false);
            return;
          }
          resolve(true);
        });
      } catch (error) {
        logWarning('write threw:', error);
        resolve(false);
      }
    });
  }

  /** A brand-new, empty, valid store. */
  function makeEmptyStore() {
    return { version: STORE_VERSION, answers: [], facts: [] };
  }

  /**
   * A tiny string hash (djb2, xor variant) rendered in base36.
   * Used ONLY to keep truncated keys distinct — see makeKey(). Not security,
   * not stable across a rewrite of this function, so never store it alone.
   */
  function shortHash(text) {
    var hash = 5381;
    var i;
    for (i = 0; i < text.length; i++) {
      /* >>> 0 keeps the number an unsigned 32-bit int, exactly like Java's
       * int overflow behaviour but without the sign. */
      hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
    }
    return hash.toString(36);
  }

  /* ===========================================================================
   * SECTION 4 — the question key
   *
   * THIS IS THE CRITICAL PART OF THE WHOLE FILE.
   *
   * The key decides whether the extension recognises a question it has already
   * been taught. Two failure modes, both bad:
   *
   *   - key too STRICT  -> the same question on a different site misses, and the
   *                        user is asked over and over. The feature feels dead.
   *   - key too LOOSE   -> two different questions collide, and the extension
   *                        confidently types the wrong answer into a real job
   *                        application. Much worse than asking again.
   *
   * The pipeline, in order:
   *   1. lowercase, and spell out the two punctuation marks that are part of a
   *      language's NAME: "c++" -> "cplusplus", "c#" -> "csharp"
   *   2. underscores / hyphens / dots / slashes become spaces, then everything
   *      that is not a letter, digit or space is deleted  (this also removes a
   *      leading or trailing '*')
   *   3. drop the decoration words: required, optional, mandatory
   *   4. drop the company name, when the caller passed one, plus legal
   *      suffixes (inc, ltd, pvt, gmbh, ...)
   *   5. drop stopwords
   *   6. de-duplicate, sort alphabetically, join with '-'
   *   7. cap at 120 characters
   *
   * (There used to be a step between 4 and 5 that guessed at an employer name
   *  from sentence shape alone. It is gone — see the long comment above
   *  TAIL VERBS in SECTION 1 for why, and do not reinstate it.)
   *
   * Step 6 is what makes word order irrelevant: "Name (First)" and
   * "First Name" both become "first-name".
   *
   * ---------------------------------------------------------------------------
   * SIX WORKED EXAMPLES
   * ---------------------------------------------------------------------------
   *  1. "First Name *"
   *       -> tokens [first, name]                       -> "first-name"
   *
   *  2. "Name (First) (required)"
   *       -> 'required' dropped, tokens [name, first], sorted
   *       -> "first-name"
   *       *** MUST COLLIDE WITH 1. Same question, two markups. It does. ***
   *
   *  3. "Why do you want to work at Acme?"        (companyName: "Acme")
   *       -> 'acme' removed as the company
   *       -> stopwords 'do','you' dropped, tokens [why, want, to, work, at]
   *       -> "at-to-want-why-work"
   *
   *  4. "Why do you want to work at Globex Inc.?" (companyName: "Globex Inc.")
   *       -> 'globex' + 'inc' removed, same remaining tokens
   *       -> "at-to-want-why-work"
   *       *** MUST COLLIDE WITH 3. One stored cover-letter-ish answer now
   *           serves every employer, which is the entire point. It does —
   *           BUT ONLY BECAUSE THE CALLER PASSED THE COMPANY NAME. With no
   *           company name the two keys are "acme-at-to-want-why-work" and
   *           "at-globex-inc-to-want-why-work" and he is asked twice. That is
   *           the deliberate trade: asking twice is a nuisance, typing Acme's
   *           answer into Globex's box is a wrecked application.
   *           content.js derives the name from the page URL and passes it on
   *           EVERY call, and staples it onto the queued question so ask.js
   *           stores the answer under the identical key. If you add a new
   *           caller, pass the company name too. ***
   *
   *  4b. "Have you worked at Acme before?"  (companyName: "Acme")
   *       -> 'acme' removed -> "at-before-have-worked"
   *      "Have you worked at Globex before?" (companyName: "Globex")
   *       -> "at-before-have-worked"
   *       *** MUST COLLIDE. This is the single most repeated question on job
   *           forms and the old sentence-shape rule missed it completely
   *           (it only knew the present tense 'work'/'working'), so every
   *           employer he applied to added one more near-identical record.
   *           Step 4 handles every tense, because it does not look at verbs. ***
   *
   *  5. "How many years of experience do you have with Java?"
   *       -> "experience-have-how-java-many-of-with-years"
   *
   *  6. "How many years of experience do you have with Python?"
   *       -> "experience-have-how-many-of-python-with-years"
   *       (the tokens land in a different order than in 5 only because they are
   *        sorted alphabetically and 'java' sorts before 'many' while 'python'
   *        sorts after it — the KEYS are what matter, not the ordering)
   *       *** MUST NOT COLLIDE WITH 5. "3" is the right answer for one and the
   *           wrong answer for the other. The distinguishing word survives
   *           every step above, so they do not collide. ***
   *
   *  7. "Years of experience with C"    -> "c-experience-of-with-years"
   *  8. "Years of experience with C++"  -> "cplusplus-experience-of-with-years"
   *  9. "Years of experience with C#"   -> "csharp-experience-of-with-years"
   *       *** MUST NOT COLLIDE, all three of them. '+' and '#' are not
   *           punctuation here, they are letters of the language's name, and a
   *           skills grid listing C, C++ and C# on three consecutive rows is
   *           an ordinary sight on an engineering application. Step 1 spells
   *           them out BEFORE the punctuation strip so the rest of the file
   *           still only ever sees [a-z0-9 ]. ***
   *
   *  Bonus pair, same idea one step subtler:
   *       "First Name" -> "first-name"   vs   "Last Name" -> "last-name"
   *       *** MUST NOT COLLIDE. 'first'/'last' are not stopwords, so they
   *           cannot be. If you ever add 'first' or 'last' to STOPWORDS, this
   *           extension starts typing the surname into the given-name box. ***
   *
   * ---------------------------------------------------------------------------
   * WHAT COUNTS AS "THE QUESTION" (this decides the whole key)
   *   Only text a HUMAN READING THE FORM would see: field.label, then
   *   field.ariaLabel, then field.placeholder. See questionTextOf().
   *
   *   field.name and field.id are NOT question wording — they are per-site DOM
   *   plumbing ("question_1", "input-1", "job_application[answers][0][text]")
   *   and they repeat across employers and across postings. Keying on them
   *   made one employer's "Have you been convicted of a felony?" answer fill
   *   another employer's "Minimum salary you would accept" box. They are still
   *   usable as a LAST resort, but only through identifierKey() below, which
   *   scopes them to one employer so they can never travel.
   *
   * ---------------------------------------------------------------------------
   * KNOWN, ACCEPTED LIMITATIONS
   *   1. The key is built from the question WORDING only, not from the field
   *      kind. So a "Company" text box in employment-history row 1 and row 2
   *      share a key and therefore share an answer. That is intended — one
   *      answer, reused — but it does mean this store is the wrong place for
   *      per-row data.
   *   2. An identifier-derived key (see above) is scoped to the employer, not
   *      to the individual job posting. Two DIFFERENT unlabelled questions,
   *      at the SAME employer, sharing the same DOM name, would still share an
   *      answer. Every label strategy in lib/scrape.js has to have failed
   *      first, which is rare; and the alternative — refusing to store
   *      anything — would mean he could not even silence such a box.
   * =========================================================================*/

  /**
   * Steps 1 and 2: lowercase, spell out '++' and '#', punctuation out,
   * whitespace collapsed.
   *
   * The result contains only [a-z0-9] and single spaces, so from here on a
   * space is a reliable word boundary and no regex needs \b.
   *
   * WHY '++' AND '#' GET SPELLED OUT FIRST
   *   The strip on the line after them deletes every character outside
   *   [a-z0-9 ]. For ordinary punctuation that is exactly right. For these two
   *   it was a silent disaster, because they are letters of a language's NAME:
   *
   *       "Years of experience with C"    ]
   *       "Years of experience with C++"  ]-> all three became
   *       "Years of experience with C#"   ]   c-experience-of-with-years
   *
   *   ...so a "0" typed for C++ was filled into the C# box at confidence 0.95,
   *   and when two of those rows appeared on the SAME skills grid the second
   *   one was dropped from the ask queue as a duplicate and never asked.
   *
   *   The replacements are deliberately narrow — they only fire when the
   *   symbol is glued to a LETTER, which is how a language name is written:
   *     "c++"       -> "cplusplus"      "f#"        -> "fsharp"
   *     "3+ years"  -> unchanged ('+' follows a digit, so it is "3 or more")
   *     "Phone #"   -> unchanged ('#' follows a space, so it means "number")
   *     "#1"        -> unchanged ('#' is followed by a digit)
   *   Both produce a single glued token, so the output alphabet is still
   *   [a-z0-9 ] and every assumption further down this file still holds.
   */
  function normaliseText(raw) {
    var lowered = safeString(raw).toLowerCase();

    var spelled = lowered
      .replace(/([a-z])\+\+/g, '$1plusplus')
      .replace(/([a-z])#(?![0-9])/g, '$1sharp');

    var spaced = spelled.replace(/[_\-./\\]/g, ' ');
    var cleaned = spaced.replace(/[^a-z0-9 ]/g, ' ');
    return cleaned.replace(/\s+/g, ' ').trim();
  }

  /** Split a normalised string into words. '' gives [] rather than ['']. */
  function words(normalised) {
    if (normalised === '') {
      return [];
    }
    return normalised.split(' ');
  }

  /** True when `word` is somewhere in `list`. Plain loop, no clever tricks. */
  function listContains(list, word) {
    var i;
    for (i = 0; i < list.length; i++) {
      if (list[i] === word) {
        return true;
      }
    }
    return false;
  }

  /**
   * Step 4 — remove the employer's own name.
   *
   * Every word of the company name is removed, plus the legal suffixes, so
   * "Acme", "ACME Inc." and "Acme Corporation" all vanish equally. One-letter
   * fragments are ignored: a company called "A" or "I" would otherwise delete
   * meaningful words from unrelated questions.
   */
  function buildCompanyWordSet(companyName) {
    var set = Object.create(null);
    var i;

    for (i = 0; i < COMPANY_SUFFIXES.length; i++) {
      set[COMPANY_SUFFIXES[i]] = true;
    }

    var nameWords = words(normaliseText(companyName));
    for (i = 0; i < nameWords.length; i++) {
      if (nameWords[i].length >= 2) {
        set[nameWords[i]] = true;
      }
    }

    return set;
  }

  /**
   * Turn already-normalised question text into the final key.
   * Split out from qKey() so it can be reasoned about (and unit-tested) with a
   * plain string, without building a fake Field object.
   */
  function makeKey(normalisedText, companyName) {
    var list = words(normalisedText);
    var companyWords = buildCompanyWordSet(companyName);

    var kept = [];
    var seen = Object.create(null);
    var i;

    for (i = 0; i < list.length; i++) {
      var word = list[i];

      if (listContains(DECORATION_WORDS, word)) {
        continue;                 /* step 3: 'required' / 'optional'        */
      }
      if (companyWords[word] === true) {
        continue;                 /* step 4: the employer's name            */
      }
      if (listContains(STOPWORDS, word)) {
        continue;                 /* step 6: filler words                   */
      }
      if (seen[word] === true) {
        continue;                 /* step 7a: de-duplicate                  */
      }

      seen[word] = true;
      kept.push(word);
    }

    /* step 7b: alphabetical, so word order can never cause a false miss. */
    kept.sort();
    var key = kept.join('-');

    /* step 8: the length cap.
     *
     * A blunt slice() would make two DIFFERENT 300-character essay prompts
     * that share an opening collide — the exact failure this file must not
     * have. So when we truncate we append a short hash of the full key: the
     * result still fits in 120 characters, but two different long questions
     * keep two different keys. */
    if (key.length > MAX_KEY_LENGTH) {
      var suffix = shortHash(key);                     /* <= 7 chars in base36 */
      var room = MAX_KEY_LENGTH - suffix.length - 1;   /* -1 for the '-'       */
      var head = key.slice(0, room).replace(/-+$/, '');
      key = head + '-' + suffix;
    }

    return key;
  }

  /**
   * The best human wording available for a field.
   *
   * field.context is deliberately NOT used. It is the nearest heading and is
   * shared by every control in a section, so folding it in would make ten
   * different questions under "Voluntary Self-Identification" look similar and
   * would make the SAME question look different on a site that renders a
   * heading. lib/match.js keeps context out of its veto path for the same
   * reason; keep the two in step.
   */
  function questionTextOf(field) {
    /* Be forgiving: a plain string is accepted anywhere a Field is. That is
     * what lets the options page and the chat box build a key from typed
     * text without faking a DOM field. */
    if (typeof field === 'string') {
      return field;
    }
    if (!field || typeof field !== 'object') {
      return '';
    }

    var candidates = [field.label, field.ariaLabel, field.placeholder, field.name, field.id];
    var i;
    for (i = 0; i < candidates.length; i++) {
      var text = safeString(candidates[i]).trim();
      if (text !== '') {
        return text;
      }
    }
    return '';
  }

  /**
   * AF.knowledge.qKey(field, companyName) -> String
   *
   * @param {Object|String} field        a scraped Field, or raw question text
   * @param {String}        [companyName] the employer, when the caller knows it
   * @returns {String} the normalised key, or '' when the field says nothing at
   *          all (an unlabelled box). '' is never stored and never looked up.
   */
  function qKey(field, companyName) {
    var text = questionTextOf(field);
    var normalised = normaliseText(text);
    if (normalised === '') {
      return '';
    }
    return makeKey(normalised, companyName);
  }

  /* ===========================================================================
   * SECTION 5 — validating / repairing whatever came out of storage
   *
   * Storage can hold anything: a half-written object from a crashed write, a
   * store from a future version of the extension, or a value some other code
   * put under our key. The rule from the spec is "log and start fresh rather
   * than throwing" — a broken memory must degrade into an empty memory, never
   * into a broken extension that cannot fill a form at all.
   * =========================================================================*/

  /** Clamp an answer value to something small and storable. */
  function sanitiseAnswerValue(value) {
    if (typeof value === 'boolean' || typeof value === 'number') {
      return value;                       /* booleans/numbers are fine as-is */
    }
    if (Array.isArray(value)) {
      var out = [];
      var i;
      for (i = 0; i < value.length && out.length < MAX_OPTIONS; i++) {
        out.push(cap(value[i], MAX_OPTION_TEXT));
      }
      return out;
    }
    return cap(value, MAX_ANSWER_LENGTH);
  }

  /** Keep at most MAX_OPTIONS {value,text} pairs, each one short. */
  function sanitiseOptions(options) {
    var out = [];
    if (!Array.isArray(options)) {
      return out;
    }
    var i;
    for (i = 0; i < options.length && out.length < MAX_OPTIONS; i++) {
      var option = options[i];
      if (!option || typeof option !== 'object') {
        continue;
      }
      out.push({
        value: cap(option.value, MAX_OPTION_TEXT),
        text: cap(option.text, MAX_OPTION_TEXT)
      });
    }
    return out;
  }

  /** A finite, non-negative epoch-millis number, or `fallback`. */
  function sanitiseTime(value, fallback) {
    if (typeof value === 'number' && isFinite(value) && value > 0) {
      return value;
    }
    return fallback;
  }

  /**
   * Turn one stored entry into a valid answer record, or return null when it is
   * beyond saving (no qKey = unusable, because the key IS the identity).
   */
  function sanitiseAnswerRecord(raw) {
    if (!raw || typeof raw !== 'object') {
      return null;
    }

    var key = safeString(raw.qKey).trim();
    if (key === '') {
      return null;
    }

    var learnedAt = sanitiseTime(raw.learnedAt, Date.now());
    var count = (typeof raw.useCount === 'number' && isFinite(raw.useCount) && raw.useCount > 0)
      ? Math.floor(raw.useCount)
      : 1;

    return {
      qKey: cap(key, MAX_KEY_LENGTH),
      question: cap(raw.question, MAX_QUESTION_LENGTH),
      answer: sanitiseAnswerValue(raw.answer),
      kind: cap(raw.kind, 40),
      options: sanitiseOptions(raw.options),
      learnedAt: learnedAt,
      lastUsedAt: sanitiseTime(raw.lastUsedAt, learnedAt),
      useCount: count,
      sourceUrl: cap(raw.sourceUrl, MAX_URL_LENGTH)
    };
  }

  /** Same idea for one chat fact. */
  function sanitiseFactRecord(raw) {
    if (!raw || typeof raw !== 'object') {
      return null;
    }

    var text = cap(raw.text, MAX_FACT_LENGTH).trim();
    if (text === '') {
      return null;
    }

    /* appliedPatch is whatever the chat module chose to record about the change
     * it made (typically {path: value} pairs plus the previous values so it can
     * be undone). We do not interpret it; we only insist it is a plain object
     * or null so it survives structured cloning into storage. */
    var patch = null;
    if (raw.appliedPatch && typeof raw.appliedPatch === 'object') {
      patch = raw.appliedPatch;
    }

    return {
      text: text,
      appliedPatch: patch,
      at: sanitiseTime(raw.at, Date.now())
    };
  }

  /**
   * Take the raw value from storage and return a store we are willing to use.
   * Never throws. Anything unrecognisable becomes an empty store.
   */
  function sanitiseStore(raw) {
    if (raw === undefined || raw === null) {
      /* Fresh install. Not an error, and not worth a console line. */
      return makeEmptyStore();
    }

    /* Someone stored a JSON STRING instead of an object (an easy mistake from
     * a devtools session). Try once to parse it before giving up. */
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw);
      } catch (error) {
        logWarning('stored knowledge was an unparseable string; starting fresh.');
        return makeEmptyStore();
      }
    }

    if (typeof raw !== 'object' || Array.isArray(raw)) {
      logWarning('stored knowledge was not an object; starting fresh.');
      return makeEmptyStore();
    }

    if (raw.version !== STORE_VERSION) {
      /* There is only one version today, so anything else was written by a
       * newer build (downgrade) or by something that is not us. Starting fresh
       * is the honest option; guessing at an unknown shape is not.
       *
       * WHEN YOU ADD VERSION 2: put the migration here, before this check. */
      logWarning('stored knowledge has version', raw.version,
        '— expected', STORE_VERSION + '. Starting fresh.');
      return makeEmptyStore();
    }

    var store = makeEmptyStore();
    var i;

    if (Array.isArray(raw.answers)) {
      var seenKeys = Object.create(null);
      for (i = 0; i < raw.answers.length; i++) {
        var record = sanitiseAnswerRecord(raw.answers[i]);
        if (record === null) {
          continue;
        }
        /* Duplicate qKeys would make lookup() depend on array order. The later
         * entry is the more recently written one, so it wins. */
        if (seenKeys[record.qKey] === true) {
          var existingIndex = indexOfKey(store.answers, record.qKey);
          if (existingIndex !== -1) {
            store.answers[existingIndex] = record;
          }
          continue;
        }
        seenKeys[record.qKey] = true;
        store.answers.push(record);
      }
    }

    if (Array.isArray(raw.facts)) {
      for (i = 0; i < raw.facts.length; i++) {
        var fact = sanitiseFactRecord(raw.facts[i]);
        if (fact !== null) {
          store.facts.push(fact);
        }
      }
    }

    return store;
  }

  /** Position of a qKey inside an answers array, or -1. */
  function indexOfKey(answers, key) {
    var i;
    for (i = 0; i < answers.length; i++) {
      if (answers[i].qKey === key) {
        return i;
      }
    }
    return -1;
  }

  /* ===========================================================================
   * SECTION 6 — eviction
   * =========================================================================*/

  /** When was this record last useful? Newer = keep. */
  function recencyOf(record) {
    var used = record.lastUsedAt || 0;
    var learned = record.learnedAt || 0;
    return used > learned ? used : learned;
  }

  /**
   * Enforce the caps, dropping the LEAST RECENTLY USED entries first.
   *
   * The surviving records keep their original order in the array, so the store
   * on disk stays diff-friendly and the options page does not reshuffle itself
   * every time something is saved.
   */
  function pruneStore(store) {
    if (store.answers.length > MAX_ANSWERS) {
      /* Rank a COPY by recency, mark the newest MAX_ANSWERS as keepers, then
       * filter the original array so order is preserved. */
      var ranked = store.answers.slice();
      ranked.sort(function (a, b) {
        return recencyOf(b) - recencyOf(a);   /* most recent first */
      });

      var keep = Object.create(null);
      var i;
      for (i = 0; i < MAX_ANSWERS; i++) {
        keep[ranked[i].qKey] = true;
      }

      var survivors = [];
      for (i = 0; i < store.answers.length; i++) {
        if (keep[store.answers[i].qKey] === true) {
          survivors.push(store.answers[i]);
        }
      }
      store.answers = survivors;
    }

    /* Facts are a chronological log, so "least recently used" is simply
     * "oldest": drop from the front and keep the newest MAX_FACTS. */
    if (store.facts.length > MAX_FACTS) {
      store.facts = store.facts.slice(store.facts.length - MAX_FACTS);
    }

    return store;
  }

  /* ===========================================================================
   * SECTION 7 — read / mutate
   * =========================================================================*/

  /**
   * AF.knowledge.load() -> Promise<store>
   *
   * Reads chrome.storage.local, repairs whatever it finds, refreshes the cache
   * and hands back the store.
   *
   * It re-reads EVERY time rather than short-circuiting on the cache, exactly
   * like content.js re-reads the profile on every run: a storage read costs
   * well under a millisecond, and it removes a whole class of "the other tab
   * changed it and this one never noticed" bugs. Call it once when your page or
   * content script starts, then use the synchronous lookup() per field.
   *
   * The returned object is the live cache, not a copy. Do not mutate it — go
   * through remember()/forget()/addFact() so the change reaches disk.
   */
  function load() {
    return storageGet().then(function (raw) {
      _cache = sanitiseStore(raw);
      return _cache;
    });
  }

  /** The cached store, loading an empty one if load() has never run. */
  function cachedStore() {
    if (_cache === null) {
      /* Not an error: lookup() may legitimately be called before load()
       * finishes. Returning an empty store means "I know nothing yet", which
       * makes the caller ask the user — annoying at worst, never wrong. */
      return makeEmptyStore();
    }
    return _cache;
  }

  /**
   * Run one read-modify-write against storage, serialised behind every other
   * mutation from this context.
   *
   * @param {Function} mutate  receives the fresh store; mutates it in place and
   *                           returns whatever the caller should get back.
   * @returns {Promise<*>} whatever `mutate` returned
   */
  function mutateStore(mutate) {
    var run = function () {
      return storageGet().then(function (raw) {
        var store = sanitiseStore(raw);   /* rule 1: read from DISK, not cache */
        var result = mutate(store);
        pruneStore(store);

        return storageSet(store).then(function (written) {
          /* Update the cache only after the write has been attempted. When the
           * write failed we STILL cache it: the user's answer is at least
           * usable for the rest of this session, and the warning has already
           * been logged so nobody is being told a lie. */
          _cache = store;
          if (!written) {
            logWarning('the change was kept in memory but could NOT be saved; ' +
              'it will be lost when this page or worker goes away.');
          }
          return result;
        });
      });
    };

    /* Chain onto the queue. The `.then(run, run)` pair means a failed earlier
     * mutation does not stall every later one. */
    var next = _writeChain.then(run, run);
    /* The queue itself must never hold a rejected promise, or every later
     * mutation would inherit it. The caller still sees the real rejection. */
    _writeChain = next.then(function () { }, function () { });
    return next;
  }

  /* ===========================================================================
   * SECTION 8 — the public operations
   * =========================================================================*/

  /**
   * Where are we? Stored with each answer purely so the options page can say
   * "learned on greenhouse.io". The query string and hash are dropped: they
   * routinely carry session tokens and application ids, which have no business
   * being written to disk.
   */
  function currentUrl() {
    try {
      var href = (typeof location !== 'undefined' && location && location.href) ? location.href : '';
      if (href === '') {
        return '';
      }
      var parsed = new URL(href);
      return cap(parsed.origin + parsed.pathname, MAX_URL_LENGTH);
    } catch (error) {
      return '';
    }
  }

  /**
   * AF.knowledge.lookupByKey(qKey) -> record | null
   * SYNCHRONOUS. Reads the cache; call load() once first.
   */
  function lookupByKey(key) {
    var wanted = safeString(key).trim();
    if (wanted === '') {
      return null;
    }
    var answers = cachedStore().answers;
    var i;
    for (i = 0; i < answers.length; i++) {
      if (answers[i].qKey === wanted) {
        return answers[i];
      }
    }
    return null;
  }

  /**
   * AF.knowledge.lookup(field, companyName) -> record | null
   *
   * "Have I been taught the answer to this question?"
   *
   * SYNCHRONOUS and side-effect free — it neither writes nor bumps any counter,
   * so it is safe to call in a tight loop over every field on the page. Call
   * touch(qKey) if you want to record that the answer was actually used.
   */
  function lookup(field, companyName) {
    return lookupByKey(qKey(field, companyName));
  }

  /**
   * AF.knowledge.remember(field, answer, extra) -> Promise<void>
   *
   * Teach the extension one answer. Upserts by qKey:
   *   - new question  -> a new record, useCount 1
   *   - known question -> the answer is REPLACED (the newest instruction wins)
   *                       and useCount is bumped, learnedAt is preserved.
   *
   * @param {Object|String} field   the scraped Field, or the raw question text
   * @param {*}             answer  String | Boolean | Number | String[]
   * @param {Object} [extra]        { companyName, sourceUrl } — both optional
   */
  function remember(field, answer, extra) {
    var options = extra || {};
    var key = qKey(field, options.companyName);

    if (key === '') {
      /* An unlabelled box gives us nothing to key on, so there is nothing we
       * could ever match it against later. Storing it would be dead weight. */
      logWarning('refusing to remember an answer for a field with no question text.');
      return Promise.resolve();
    }

    var isFieldObject = field && typeof field === 'object';
    var question = cap(questionTextOf(field), MAX_QUESTION_LENGTH);
    var kind = isFieldObject ? cap(field.kind, 40) : '';
    var opts = isFieldObject ? sanitiseOptions(field.options) : [];
    var url = cap(options.sourceUrl !== undefined ? options.sourceUrl : currentUrl(), MAX_URL_LENGTH);
    var value = sanitiseAnswerValue(answer);
    var now = Date.now();

    return mutateStore(function (store) {
      var at = indexOfKey(store.answers, key);

      if (at === -1) {
        store.answers.push({
          qKey: key,
          question: question,
          answer: value,
          kind: kind,
          options: opts,
          learnedAt: now,
          lastUsedAt: now,
          useCount: 1,
          sourceUrl: url
        });
        return undefined;
      }

      var existing = store.answers[at];
      existing.answer = value;
      existing.lastUsedAt = now;
      existing.useCount = existing.useCount + 1;

      /* Keep the richest description we have ever seen. A second site may show
       * the same question with better wording or with the option list we were
       * missing, and throwing that away would make the options page worse. */
      if (question !== '') {
        existing.question = question;
      }
      if (kind !== '') {
        existing.kind = kind;
      }
      if (opts.length > 0) {
        existing.options = opts;
      }
      if (existing.sourceUrl === '' && url !== '') {
        existing.sourceUrl = url;
      }

      return undefined;
    }).then(function () {
      /* Resolve with nothing, as the contract says Promise<void>. */
      return undefined;
    });
  }

  /**
   * AF.knowledge.touch(qKey) -> Promise<Boolean>
   *
   * "This stored answer was actually used to fill a box just now."
   * Bumps useCount and lastUsedAt, which is what keeps LRU eviction meaningful.
   * Optional: skipping it costs accuracy in the stats, nothing else.
   *
   * Call it ONCE per fill, not once per lookup.
   */
  function touch(key) {
    var wanted = safeString(key).trim();
    if (wanted === '') {
      return Promise.resolve(false);
    }

    return mutateStore(function (store) {
      var at = indexOfKey(store.answers, wanted);
      if (at === -1) {
        return false;
      }
      store.answers[at].useCount = store.answers[at].useCount + 1;
      store.answers[at].lastUsedAt = Date.now();
      return true;
    });
  }

  /**
   * AF.knowledge.forget(qKey) -> Promise<Boolean>
   * true when a record was removed, false when there was nothing to remove.
   */
  function forget(key) {
    var wanted = safeString(key).trim();
    if (wanted === '') {
      return Promise.resolve(false);
    }

    return mutateStore(function (store) {
      var at = indexOfKey(store.answers, wanted);
      if (at === -1) {
        return false;
      }
      store.answers.splice(at, 1);
      return true;
    });
  }

  /**
   * AF.knowledge.all() -> Promise<Array>
   *
   * Every learned answer, most recently used first, for the options page to
   * render as a "things I have taught the extension" table.
   *
   * Returns COPIES. The options page can sort or annotate them freely without
   * corrupting the cache; changes only take effect through remember()/forget().
   */
  function all() {
    return load().then(function (store) {
      var copies = [];
      var i;
      for (i = 0; i < store.answers.length; i++) {
        var record = store.answers[i];
        copies.push({
          qKey: record.qKey,
          question: record.question,
          answer: record.answer,
          kind: record.kind,
          options: record.options.slice(),
          learnedAt: record.learnedAt,
          lastUsedAt: record.lastUsedAt,
          useCount: record.useCount,
          sourceUrl: record.sourceUrl
        });
      }
      copies.sort(function (a, b) {
        return recencyOf(b) - recencyOf(a);
      });
      return copies;
    });
  }

  /**
   * AF.knowledge.addFact(text, patch) -> Promise<void>
   *
   * Append one line to the chatbot's audit log: what the user said, and what
   * the extension actually changed in response.
   *
   * @param {String} text    exactly what he typed ("my address is now Pune")
   * @param {Object} [patch] what was applied, in whatever shape the chat module
   *                         finds useful for showing and undoing the change —
   *                         e.g. { 'personal.city': {from: '', to: 'Pune'} }.
   *                         Must be a plain, cloneable object: no DOM nodes, no
   *                         functions, or chrome.storage will refuse the write.
   */
  function addFact(text, patch) {
    var entry = sanitiseFactRecord({
      text: text,
      appliedPatch: patch,
      at: Date.now()
    });

    if (entry === null) {
      /* Empty message: nothing worth logging. */
      return Promise.resolve();
    }

    return mutateStore(function (store) {
      store.facts.push(entry);
      return undefined;
    }).then(function () {
      return undefined;
    });
  }

  /**
   * AF.knowledge.allFacts() -> Promise<Array>
   * The chat audit log, NEWEST FIRST, as copies. The chat UI needs this to show
   * "here is what I changed" and to offer an undo built from appliedPatch.
   */
  function allFacts() {
    return load().then(function (store) {
      var copies = store.facts.slice();
      copies.reverse();               /* stored oldest-first, shown newest-first */
      return copies;
    });
  }

  /**
   * AF.knowledge.removeFact(at) -> Promise<Boolean>
   *
   * Drop one audit-log line, identified by its `at` timestamp (which is what
   * allFacts() hands the UI). Removing the log line does NOT undo the profile
   * change — reverting the profile is the chat module's job, using
   * appliedPatch. This just tidies the list afterwards.
   */
  function removeFact(at) {
    if (typeof at !== 'number' || !isFinite(at)) {
      return Promise.resolve(false);
    }

    return mutateStore(function (store) {
      var i;
      for (i = 0; i < store.facts.length; i++) {
        if (store.facts[i].at === at) {
          store.facts.splice(i, 1);
          return true;
        }
      }
      return false;
    });
  }

  /**
   * AF.knowledge.stats() -> Promise<{answers, facts, totalUses}>
   * For the popup badge / options header: "42 answers learned, used 137 times".
   */
  function stats() {
    return load().then(function (store) {
      var totalUses = 0;
      var i;
      for (i = 0; i < store.answers.length; i++) {
        totalUses = totalUses + store.answers[i].useCount;
      }
      return {
        answers: store.answers.length,
        facts: store.facts.length,
        totalUses: totalUses
      };
    });
  }

  /* ===========================================================================
   * SECTION 9 — slotting into the existing match pipeline
   * =========================================================================*/

  /**
   * True when a learned answer is worth filling with.
   *
   * Mirrors lib/match.js's isUsableValue on purpose: boolean FALSE is a real
   * answer (an unticked box, "No" on a yes/no question), while '' means the
   * user deliberately left it blank and we must not type anything.
   */
  function isUsableAnswer(value) {
    if (value === null || value === undefined) {
      return false;
    }
    if (typeof value === 'boolean' || typeof value === 'number') {
      return true;
    }
    if (Array.isArray(value)) {
      var i;
      for (i = 0; i < value.length; i++) {
        if (safeString(value[i]).trim() !== '') {
          return true;
        }
      }
      return false;
    }
    return safeString(value).trim() !== '';
  }

  /**
   * AF.knowledge.matchFromKnowledge(field, companyName)
   *   -> { key: 'knowledge', value, confidence: 0.95 } | null
   *
   * The whole point of this function is that the caller does NOT have to
   * special-case learned answers. The returned object has the same three
   * properties as AF.matchField's result, so it drops straight into the
   * existing pipeline:
   *
   *   var match = AF.knowledge.matchFromKnowledge(field)   // learned answer
   *            || AF.matchField(field, profile);           // profile answer
   *   if (match) { AF.setValue(field.el, match.value, field); }
   *
   * ORDER MATTERS, and knowledge deliberately goes FIRST: the user typed these
   * answers himself for questions the profile could not cover. Note that
   * `key` is the literal string 'knowledge' rather than a profile path,
   * because there is no profile path — that is also how a caller can tell
   * where a value came from when colouring the highlight.
   *
   * SYNCHRONOUS, so load() must have run. Returns null when nothing is known,
   * which leaves the field exactly where it was: on to the profile matcher,
   * then the AI, then the "ask the user" list.
   *
   * ONE SUBTLETY FOR THE "ASK THE USER" UI: this also returns null when the
   * user answered the question with a deliberate BLANK. That is right for
   * filling — we must not type an empty string over whatever is there — but it
   * is wrong for asking. Use lookup() there instead: a non-null record means
   * "he has already dealt with this question", whatever the answer was, so do
   * not put it back on the list and pester him again.
   */
  function matchFromKnowledge(field, companyName) {
    var record = lookup(field, companyName);
    if (record === null) {
      return null;
    }
    if (!isUsableAnswer(record.answer)) {
      return null;
    }
    return {
      key: 'knowledge',
      value: record.answer,
      confidence: KNOWLEDGE_CONFIDENCE
    };
  }

  /* ===========================================================================
   * SECTION 10 — cross-context cache refresh
   *
   * Without this listener: the user teaches an answer in the popup, the content
   * script on the open job page keeps its stale cache, fills the old value, and
   * the next remember() from that page writes a store built on... well, no,
   * mutateStore always re-reads from disk, so nothing is LOST. What breaks is
   * lookup(): the tab would go on believing it knows nothing until the page is
   * reloaded. This listener is what makes "teach it once, it works everywhere,
   * immediately" true.
   * =========================================================================*/

  function installChangeListener() {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.onChanged) {
        return;
      }

      chrome.storage.onChanged.addListener(function (changes, areaName) {
        if (areaName !== 'local') {
          return;                       /* we only ever use storage.local */
        }
        if (!changes || !changes[STORAGE_KEY]) {
          return;                       /* somebody else's key changed    */
        }

        /* This also fires for OUR OWN writes, which is harmless: it just
         * re-sanitises a value we already have. */
        _cache = sanitiseStore(changes[STORAGE_KEY].newValue);
      });
    } catch (error) {
      logWarning('could not listen for storage changes:', error);
    }
  }

  installChangeListener();

  /* ===========================================================================
   * SECTION 11 — publish the API
   * =========================================================================*/

  AF.knowledge = {
    /* --- the contract --------------------------------------------------- */
    load: load,
    qKey: qKey,
    lookup: lookup,
    remember: remember,
    forget: forget,
    all: all,
    addFact: addFact,
    stats: stats,
    matchFromKnowledge: matchFromKnowledge,

    /* --- extras the UI needs -------------------------------------------- */
    lookupByKey: lookupByKey,
    touch: touch,
    allFacts: allFacts,
    removeFact: removeFact,

    /* --- constants, exported so nobody has to hardcode them -------------- */
    STORAGE_KEY: STORAGE_KEY,
    VERSION: STORE_VERSION,
    MAX_ANSWERS: MAX_ANSWERS,
    MAX_FACTS: MAX_FACTS,
    CONFIDENCE: KNOWLEDGE_CONFIDENCE
  };
})();
