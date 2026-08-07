/* =============================================================================
 * background.js — the MV3 service worker.
 * -----------------------------------------------------------------------------
 * WHAT IT IS
 *   The extension's only piece of code that is allowed to talk to the network
 *   on the extension's own behalf. It is NOT a page: it has no DOM, no window,
 *   no document. It is closest to a tiny stateless @Service that Spring starts
 *   on demand and shuts down when idle.
 *
 * IT HANDLES EXACTLY THREE MESSAGES
 *   { type: 'BRIDGE_PING' }                     -> { online: Boolean, detail: String }
 *   { type: 'AI_FILL', fields, profile, ... }   -> { ok: true, values: {...} }
 *                                               or { ok: false, error: String }
 *   { type: 'CHAT_UPDATE_PROFILE', text }       -> { ok: true, patch: {...}, summary: String }
 *                                               or { ok: false, error: String }
 *
 * CHAT_UPDATE_PROFILE in one paragraph
 *   chat.html is a little chat box where the user types a plain sentence —
 *   "my address is now Pune", "I have 3 years of experience now". This worker
 *   sends that sentence and the CURRENT profile to the model, and asks for the
 *   minimal set of changes. Nothing is written to storage here: the reply is a
 *   PROPOSAL, chat.js shows it as a diff, and only the user's Apply click
 *   commits it. See handleChatUpdateProfile() in SECTION 6b.
 *
 * ----------------------------------------------------------------------------
 * WHY THE FETCH LIVES HERE AND NOT IN content.js  (do not "simplify" this)
 * ----------------------------------------------------------------------------
 *   A content script shares the HOST PAGE's Content-Security-Policy. Greenhouse,
 *   Lever, Ashby and Workday all ship a strict `connect-src` directive that
 *   lists their own API hosts and nothing else. A fetch('http://localhost:3111')
 *   issued from inside such a page is blocked by the browser before it ever
 *   reaches the network, with a CSP violation in the console that reads like
 *   the extension is broken.
 *
 *   The service worker runs under the EXTENSION's own CSP and the extension's
 *   host permissions, not the page's. From here the same request goes straight
 *   out. This is the standard MV3 pattern: content script scrapes and writes,
 *   service worker performs privileged I/O, they talk over runtime messaging.
 *
 * ----------------------------------------------------------------------------
 * WHY THERE IS NO MODULE-LEVEL MUTABLE STATE
 * ----------------------------------------------------------------------------
 *   Chrome TERMINATES an MV3 service worker after roughly 30 seconds of
 *   inactivity and starts a brand-new one when the next message arrives. Any
 *   `var cache = {}` at the top of this file is therefore silently emptied
 *   between two clicks of the popup. It is not a long-lived singleton bean; it
 *   is closer to a @Scope("prototype") bean recreated per request.
 *
 *   Consequence, and the rule this file follows: EVERY value that must survive
 *   between messages is read from chrome.storage.local at the moment it is
 *   needed. The only top-level declarations below are `const`-like constants
 *   and function definitions, which are rebuilt identically on every restart.
 * ========================================================================== */

/* Same defensive namespace line as every other file, purely for consistency —
 * the service worker does not share globals with the content scripts, so this
 * AF is a different, empty object. Nothing is attached to it here. */
var AF = (globalThis.AF = globalThis.AF || {});

/* ---------------------------------------------------------------------------
 * Load the bundled default profile into the worker.
 *
 * WHY: the chat handler needs a profile to diff the user's sentence against.
 * Normally it reads chrome.storage.local['profile'], but on a fresh install —
 * before the user has ever pressed Save on the options page — that key does not
 * exist, and an empty {} would make the model invent a whole profile from
 * nothing. lib/profile.js gives us the same bundled default every other part of
 * the extension falls back to.
 *
 * HOW: importScripts is the service worker's synchronous "include this classic
 * script here". It works because the manifest declares a plain service_worker
 * (no "type": "module"); an ES module worker would have to use import instead.
 *
 * The try/catch is not decoration. importScripts throws if the file is missing
 * or fails to parse, and an uncaught throw at the top level of a service worker
 * kills the WHOLE worker — meaning BRIDGE_PING and AI_FILL would stop answering
 * too, and the popup would report the extension as broken. A missing default
 * profile is a much smaller problem than that, so it is caught and logged.
 * ------------------------------------------------------------------------ */
try {
  importScripts('lib/profile.js');
} catch (profileLoadError) {
  console.warn('[AF worker] could not load lib/profile.js:', profileLoadError);
}

/* ---------------------------------------------------------------------------
 * SECTION 1 — constants (immutable, so a worker restart cannot lose anything)
 * ------------------------------------------------------------------------ */

/* Used when the user has never opened the options page. Must match the default
 * in options.js and the `host_permissions` entry in manifest.json. */
var DEFAULT_BRIDGE_URL = 'http://localhost:3111';

/* The health check must fail FAST. If the Spring app is not running, the TCP
 * connection to localhost is refused almost instantly, but a machine with a
 * stalled process could hang, and the popup would sit there with a grey dot. */
var PING_TIMEOUT_MS = 3000;

/* The AI call is slow by nature: the Claude CLI has to start, think, and
 * print. The bridge kills its child process at 120s and answers 504, so we
 * wait a little longer than that and let the server's own error win. */
var FILL_TIMEOUT_MS = 150000;

/* Guard rails on prompt size. A form with 200 controls is almost certainly a
 * mis-scrape, and shipping all of it would make the CLI crawl. */
var MAX_FIELDS_IN_PROMPT = 80;
var MAX_OPTIONS_PER_FIELD = 60;
var MAX_EXTRA_INSTRUCTION_CHARS = 2000;

/* ---- CHAT_UPDATE_PROFILE guard rails ------------------------------------ */

/* One typed sentence. Anything longer is a paste accident, not a fact about
 * himself, and it would push the profile out of the prompt. */
var MAX_CHAT_TEXT_CHARS = 2000;

/* The most paths one sentence may change. "My address changed" touches three
 * or four; forty means the model has decided to rewrite the whole profile,
 * which is exactly what the "minimal patch" rule exists to prevent. */
var MAX_PATCH_PATHS = 40;

/* How deep a dotted path may go, e.g. 'experience.0.company' is depth 3.
 * A deeper one is not addressing anything that exists in the profile. */
var MAX_PATCH_DEPTH = 6;

/* Longest single value a patch may set. Cover letters are legitimately long;
 * anything past this is the model pasting the job description back at us. */
var MAX_PATCH_VALUE_CHARS = 6000;

/* Longest array a patch may set (skills, preferredLocations). */
var MAX_PATCH_ARRAY_LENGTH = 100;

/* Key names that must never be written into an object. Assigning to
 * '__proto__' does not create a property — it changes the object's prototype,
 * which in JavaScript can quietly rewrite behaviour everywhere. chat.js
 * refuses these too (its FORBIDDEN_KEYS); refusing them HERE as well means a
 * bad model answer never even reaches the page. */
var FORBIDDEN_PATCH_KEYS = ['__proto__', 'prototype', 'constructor'];

/* How many profile paths to list in the chat prompt, so it cannot balloon on a
 * profile with a hundred skills. */
var MAX_PATHS_IN_PROMPT = 120;

var LOG_PREFIX = '[AF worker]';

/* ---------------------------------------------------------------------------
 * SECTION 2 — small helpers
 * ------------------------------------------------------------------------ */

function log() {
  var parts = [LOG_PREFIX];
  var i;
  for (i = 0; i < arguments.length; i++) {
    parts.push(arguments[i]);
  }
  console.log.apply(console, parts);
}

function logWarning() {
  var parts = [LOG_PREFIX];
  var i;
  for (i = 0; i < arguments.length; i++) {
    parts.push(arguments[i]);
  }
  console.warn.apply(console, parts);
}

/** Trim a string and cut it to `maxChars`. Never throws, never returns null. */
function capText(value, maxChars) {
  if (value === null || value === undefined) {
    return '';
  }
  var text = String(value).trim();
  if (text.length > maxChars) {
    return text.substring(0, maxChars) + '\n[...truncated]';
  }
  return text;
}

/**
 * Remove a trailing slash so `bridgeUrl + '/health'` never becomes '//health'.
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

/**
 * Read the two settings this worker needs.
 *
 * Deliberately re-read on every single message — see the header note about the
 * worker being killed when idle. Written as a Promise because MV3's chrome.*
 * APIs return one when you omit the callback, which lets the callers below use
 * plain `await` instead of nested callbacks.
 *
 * @returns {Promise<{bridgeUrl: String, extraInstructions: String}>}
 */
async function readSettings() {
  var stored = {};
  try {
    stored = await chrome.storage.local.get(['bridgeUrl', 'extraInstructions']);
  } catch (error) {
    logWarning('could not read settings, using defaults:', error);
    stored = {};
  }

  return {
    bridgeUrl: normaliseBridgeUrl(stored.bridgeUrl),
    extraInstructions: (typeof stored.extraInstructions === 'string')
      ? capText(stored.extraInstructions, MAX_EXTRA_INSTRUCTION_CHARS)
      : ''
  };
}

/**
 * fetch() with a hard deadline.
 *
 * fetch has no timeout of its own. AbortController is the browser's
 * cancellation token: we hand its `signal` to fetch and trip it from a timer.
 * Java analogy: a Future you cancel(true) after N milliseconds.
 *
 * @param {String} url
 * @param {Object} options     standard fetch options (method, headers, body)
 * @param {Number} timeoutMs
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options, timeoutMs) {
  var controller = new AbortController();
  var timer = setTimeout(function () {
    controller.abort();
  }, timeoutMs);

  try {
    var withSignal = Object.assign({}, options, { signal: controller.signal });
    return await fetch(url, withSignal);
  } finally {
    /* Always clear the timer, success or failure, so a finished request does
     * not leave a pending task keeping the worker alive. */
    clearTimeout(timer);
  }
}

/* ---------------------------------------------------------------------------
 * SECTION 3 — BRIDGE_PING
 * -------------------------------------------------------------------------
 * GET {bridgeUrl}/health. The Spring side answers:
 *   { "status": "UP" | "DEGRADED", "claudeBinary": "...", "binaryExists": true }
 *
 * "DEGRADED" means the Spring app is running but the configured claude binary
 * does not exist on disk — the AI path would fail on the first real call, so we
 * report that as OFFLINE with an explanatory detail rather than a green dot
 * that lies.
 * ------------------------------------------------------------------------ */
async function handleBridgePing() {
  var settings = await readSettings();
  var url = settings.bridgeUrl + '/health';

  try {
    var response = await fetchWithTimeout(url, { method: 'GET' }, PING_TIMEOUT_MS);

    if (!response.ok) {
      return {
        online: false,
        detail: 'The bridge answered ' + response.status + ' ' + response.statusText + '.'
      };
    }

    var body = await response.json();

    if (body && body.status === 'UP') {
      return { online: true, detail: 'Bridge up, claude at ' + body.claudeBinary };
    }

    if (body && body.status === 'DEGRADED') {
      return {
        online: false,
        detail: 'The bridge is running but the Claude CLI was not found at "' +
          body.claudeBinary + '". Run `which claude` and fix claude.binary-path ' +
          'in application.properties.'
      };
    }

    return { online: false, detail: 'The bridge answered something unexpected.' };

  } catch (error) {
    /* AbortError = our own timeout. TypeError "Failed to fetch" = nothing is
     * listening on that port, which is the everyday case (bridge not started). */
    var reason = (error && error.name === 'AbortError')
      ? 'The bridge did not answer within ' + (PING_TIMEOUT_MS / 1000) + 's.'
      : 'Could not reach ' + url + ' (is `mvn spring-boot:run` running?).';

    return { online: false, detail: reason };
  }
}

/* ---------------------------------------------------------------------------
 * SECTION 4 — building the prompt
 * ------------------------------------------------------------------------ */

/**
 * Shrink one scraped field down to what the model actually needs.
 * Dropping `filled`, `groupName` and the raw `type` keeps the prompt small and
 * stops the model from reasoning about implementation details.
 */
function fieldForPrompt(field) {
  var options = Array.isArray(field.options) ? field.options : [];

  /* A country dropdown has 250 options. Keeping all of them for every field
   * would dominate the prompt, so long lists are cut. */
  var trimmedOptions = [];
  var i;
  for (i = 0; i < options.length && i < MAX_OPTIONS_PER_FIELD; i++) {
    trimmedOptions.push(options[i].text);
  }
  if (options.length > MAX_OPTIONS_PER_FIELD) {
    trimmedOptions.push('[...' + (options.length - MAX_OPTIONS_PER_FIELD) + ' more options omitted]');
  }

  var compact = {
    index: field.index,
    kind: field.kind,
    label: field.label || '',
    context: field.context || '',
    placeholder: field.placeholder || '',
    required: field.required === true
  };

  /* Only include the identifying attributes when there is no visible label —
   * a raw `name="q_47821"` is noise when we already have "Why do you want to
   * work here?". */
  if (compact.label === '') {
    compact.name = field.name || '';
    compact.ariaLabel = field.ariaLabel || '';
  }

  if (trimmedOptions.length > 0) {
    compact.options = trimmedOptions;
  }

  return compact;
}

/**
 * Build the single string that is POSTed to the bridge and handed to
 * `claude -p`.
 *
 * The output contract is the part that matters. Everything else is context.
 *
 * @param {Object} request            the AI_FILL message from content.js
 * @param {String} extraInstructions  free text from the options page
 * @returns {String}
 */
function buildPrompt(request, extraInstructions) {
  var fields = Array.isArray(request.fields) ? request.fields : [];

  /* Hard cap; the deterministic pass has already handled the easy fields, so
   * anything beyond 80 leftovers is almost certainly a mis-scrape. */
  var usedFields = fields.slice(0, MAX_FIELDS_IN_PROMPT);

  var compactFields = [];
  var i;
  for (i = 0; i < usedFields.length; i++) {
    compactFields.push(fieldForPrompt(usedFields[i]));
  }

  var lines = [];

  lines.push('You are helping a real person fill in a job application form in their browser.');
  lines.push('Everything you write goes straight into a live form that a human will read before submitting.');
  lines.push('');

  lines.push('=== THE APPLICANT (JSON, this is the ONLY source of facts about them) ===');
  lines.push(JSON.stringify(request.profile || {}, null, 2));
  lines.push('');

  lines.push('=== THE JOB ===');
  lines.push('Page title: ' + (request.pageTitle || '(unknown)'));
  lines.push('Page URL: ' + (request.pageUrl || '(unknown)'));
  if (request.referrer) {
    lines.push('Opened from: ' + request.referrer);
  }
  lines.push('');
  lines.push('Job description text scraped from the page (may be truncated or noisy):');
  lines.push(request.jobDescription || '(none found on this page)');
  lines.push('');

  if (extraInstructions && extraInstructions !== '') {
    lines.push('=== STANDING INSTRUCTIONS FROM THE APPLICANT (these win over your own judgement) ===');
    lines.push(extraInstructions);
    lines.push('');
  }

  lines.push('=== THE FIELDS THAT STILL NEED AN ANSWER (JSON array) ===');
  lines.push('Each entry has: index (the key you must answer with), kind, label, context,');
  lines.push('placeholder, required, and options when the control is a dropdown or a radio group.');
  lines.push(JSON.stringify(compactFields, null, 2));
  lines.push('');

  lines.push('=== HOW TO ANSWER ===');
  lines.push('1. Reply with ONE JSON object and nothing else. No explanation before it, no');
  lines.push('   summary after it, and no markdown code fence around it.');
  lines.push('2. Every key is a field "index" as a STRING. Every value is either a string');
  lines.push('   (the text to type / the option to pick) or a boolean (for a checkbox).');
  lines.push('   Example of the exact shape expected:  {"3":"Yes","7":"I have two years of...","11":true}');
  lines.push('3. ANSWER EVERY FIELD. Do not leave a field out because you are unsure. The');
  lines.push('   applicant reviews and edits every answer before submitting, so a reasonable');
  lines.push('   default he can correct in two seconds is far more useful than a blank he has');
  lines.push('   to notice, think about and type from scratch. An empty form is the failure');
  lines.push('   case here, not a wrong guess.');
  lines.push('   Use the ordinary answer a working software engineer would give:');
  lines.push('     - eligibility/screening questions -> the common-case answer');
  lines.push('       ("convicted of a crime" -> No, "authorised to work" -> Yes)');
  lines.push('     - self-identification (gender, race, veteran, disability) -> the');
  lines.push('       decline-to-answer option, never an invented value');
  lines.push('     - anything numeric you can derive from the profile -> derive it');
  lines.push('   The ONLY things you may still omit are: a field asking for a credential,');
  lines.push('   document number or account he must supply himself, and a field whose answer');
  lines.push('   would be a fabricated verifiable fact (see rule 6).');
  lines.push('4. For kind "select" or "radio", the value MUST be copied character for character');
  lines.push('   from that field\'s options list. Pick the closest fitting option; only omit');
  lines.push('   the field when no option could plausibly apply.');
  lines.push('5. For kind "checkbox", answer true or false.');
  lines.push('6. The one hard limit on rule 3: never invent a VERIFIABLE FACT. An employer he');
  lines.push('   did not work for, a job title he did not hold, a degree or certification he');
  lines.push('   does not have, a date, a licence or document number, a reference\'s name, or a');
  lines.push('   performance metric. Those are checkable and a wrong one is a lie on a job');
  lines.push('   application. Omit the field instead.');
  lines.push('   This is NOT the same as a policy answer. "Do you require sponsorship",');
  lines.push('   "will you consent to a background check", "are you willing to relocate" are');
  lines.push('   statements of intent, not facts about his history — answer those per rule 3,');
  lines.push('   using the profile value when one exists.');
  lines.push('   Salary: if the profile\'s expected CTC is blank, omit the field rather than');
  lines.push('   inventing a number — an accidental low anchor costs him real money.');
  lines.push('7. Write screening answers in the applicant\'s own voice: first person, plain,');
  lines.push('   concrete, no marketing language, no "I am passionate about". Reuse the real');
  lines.push('   projects and numbers from their profile.');
  lines.push('8. Match the length the form is asking for. A one-line box gets one line. A large');
  lines.push('   textarea asking "why do you want to work here" gets roughly 80-150 words.');
  lines.push('9. The coverLetters in the profile contain {{COMPANY}} and {{ROLE}} placeholders.');
  lines.push('   If you use one, substitute the real company and role from the job description');
  lines.push('   above and leave no placeholder text behind.');
  lines.push('10. Answer in the language the form is written in.');
  lines.push('');
  lines.push('Output the JSON object now, and nothing else.');

  return lines.join('\n');
}

/* ---------------------------------------------------------------------------
 * SECTION 5 — parsing what came back
 * -------------------------------------------------------------------------
 * The CLI is asked for bare JSON, and it usually obliges. "Usually" is not
 * "always", so every step below assumes the worst and returns a plain error
 * object instead of throwing. A parse failure must downgrade the run to
 * "deterministic only"; it must never break the page.
 * ------------------------------------------------------------------------ */

/**
 * Steps 1 to 4 of parsing a model answer: strip the fence, find the object,
 * parse it, check it really is a plain object.
 *
 * SHARED ON PURPOSE. Both AI_FILL and CHAT_UPDATE_PROFILE talk to the same CLI
 * through the same bridge and get the same three kinds of rubbish back — a
 * markdown fence, a chatty preamble, a trailing sign-off. Having one function
 * do the unwrapping means a fix for one message type is automatically a fix for
 * the other. What differs between them is what a VALID object looks like, and
 * that stays in the two callers.
 *
 * @param {String} rawText
 * @returns {{ok: true, object: Object} | {ok: false, error: String}}
 */
function extractJsonObject(rawText) {
  if (typeof rawText !== 'string' || rawText.trim() === '') {
    return { ok: false, error: 'The AI returned an empty answer.' };
  }

  var text = rawText.trim();

  /* --- step 1: strip a markdown fence ---------------------------------- *
   * Turns  ```json\n{...}\n```  into  {...}
   * The language tag after the backticks is optional, hence the \w* part. */
  text = text.replace(/^```[a-zA-Z]*\s*/, '');
  text = text.replace(/\s*```$/, '');
  text = text.trim();

  /* --- step 2: take everything between the first { and the last } ------- *
   * This survives a chatty preamble ("Here is the JSON you asked for:") and a
   * trailing sign-off, which are the two ways a model usually breaks the
   * "no prose" rule. */
  var first = text.indexOf('{');
  var last = text.lastIndexOf('}');

  if (first === -1 || last === -1 || last <= first) {
    return { ok: false, error: 'The AI answer contained no JSON object.' };
  }

  var candidate = text.substring(first, last + 1);

  /* --- step 3: parse ---------------------------------------------------- */
  var parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    return { ok: false, error: 'The AI answer was not valid JSON: ' + error.message };
  }

  /* --- step 4: it must be a plain object, not an array or a bare value --- */
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'The AI answered with something other than a JSON object.' };
  }

  return { ok: true, object: parsed };
}

/**
 * Pull the FORM ANSWERS out of a model response (the AI_FILL contract).
 *
 * @param {String} rawText
 * @returns {{ok: true, values: Object} | {ok: false, error: String}}
 */
function parseModelJson(rawText) {
  var extracted = extractJsonObject(rawText);
  if (!extracted.ok) {
    return extracted;
  }
  var parsed = extracted.object;

  /* --- step 5: keep only the entries we can actually type into a form ---- */
  var clean = {};
  var keys = Object.keys(parsed);
  var kept = 0;
  var i;

  for (i = 0; i < keys.length; i++) {
    var key = keys[i];
    var value = parsed[key];

    if (typeof value === 'string' || typeof value === 'boolean') {
      clean[key] = value;
      kept++;
      continue;
    }

    /* A number is a perfectly sensible answer to "years of experience" even
     * though the contract asks for strings, so it is accepted and converted
     * rather than thrown away. Anything else (object, array, null) is dropped:
     * lib/fill.js would stringify it into garbage like "[object Object]". */
    if (typeof value === 'number' && isFinite(value)) {
      clean[key] = String(value);
      kept++;
      continue;
    }

    logWarning('dropped field "' + key + '": the AI answered with a ' + typeof value + '.');
  }

  /* An EMPTY ANSWER IS A VALID ANSWER, not a failure.
   *
   * buildPrompt tells the model, in so many words: "OMIT any field you cannot
   * answer confidently — a missing key is a good answer". When the leftovers
   * are a salary box and a self-identification dropdown, `{}` is the model
   * obeying that rule perfectly. Reporting it as ok:false made the content
   * script log "AI stage unavailable" and the popup announce a broken AI step
   * after a run that behaved exactly as designed — and it skipped the amber
   * highlighting of required unanswered fields, which is the one visual cue
   * pointing the user at what is left to do.
   *
   * ok:false is now reserved for genuine parse / transport failures, which
   * are all handled above. */
  if (kept === 0 && keys.length > 0) {
    logWarning('the AI answered, but none of its ' + keys.length +
      ' entries were usable values.');
  }

  return { ok: true, values: clean };
}

/* ---------------------------------------------------------------------------
 * SECTION 6 — AI_FILL
 * ------------------------------------------------------------------------ */

/**
 * Build the prompt, POST it to the bridge, parse the answer.
 *
 * ALWAYS resolves — never rejects. The caller turns whatever comes back
 * straight into the sendResponse payload, and the content script is written to
 * carry on with the deterministic values when `ok` is false.
 *
 * @param {Object} request  the AI_FILL message
 * @returns {Promise<{ok: true, values: Object, elapsedMs: Number} | {ok: false, error: String}>}
 */
async function handleAiFill(request) {
  /* Nothing to do — answer immediately rather than starting the CLI for zero
   * fields (a cold `claude -p` costs several seconds). */
  if (!Array.isArray(request.fields) || request.fields.length === 0) {
    return { ok: true, values: {} };
  }

  var settings = await readSettings();
  var url = settings.bridgeUrl + '/fill';
  var prompt = buildPrompt(request, settings.extraInstructions);

  log('POST ' + url + ' — ' + request.fields.length + ' field(s), ' +
    prompt.length + ' prompt chars.');

  var response;
  try {
    response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      /* The Spring side is `record FillRequest(@NotBlank String prompt)`. */
      body: JSON.stringify({ prompt: prompt })
    }, FILL_TIMEOUT_MS);
  } catch (error) {
    if (error && error.name === 'AbortError') {
      return {
        ok: false,
        error: 'The AI bridge did not answer within ' + (FILL_TIMEOUT_MS / 1000) + ' seconds.'
      };
    }
    return {
      ok: false,
      error: 'Could not reach the AI bridge at ' + settings.bridgeUrl +
        '. Start it with `mvn spring-boot:run` in the bridge folder.'
    };
  }

  /* --- HTTP-level failure: the bridge answered, but with an error --------- */
  if (!response.ok) {
    var detail = '';
    try {
      /* The Spring side is `record ErrorResponse(String error, String detail)`
       * and GlobalExceptionHandler builds EVERY failure body from it, so the
       * two keys on the wire are exactly `error` (a machine code such as
       * CLAUDE_FAILED) and `detail` (the sentence, with the CLI's stderr
       * appended). Reading `.message` — which no Java type in this project has
       * — silently threw away the only diagnostic the user ever sees, so a
       * wrong claude.binary-path showed up as a bare "502". */
      var errorBody = await response.json();
      if (errorBody && typeof errorBody.detail === 'string' && errorBody.detail !== '') {
        detail = ' ' + errorBody.detail;
      } else if (errorBody && typeof errorBody.error === 'string' && errorBody.error !== '') {
        /* No sentence, but the machine code is still better than nothing. */
        detail = ' ' + errorBody.error;
      }
    } catch (ignored) {
      /* The body was not JSON. The status code alone will have to do. */
    }
    return {
      ok: false,
      error: 'The AI bridge returned ' + response.status + '.' + detail
    };
  }

  /* --- read the success body -------------------------------------------- */
  var body;
  try {
    /* FillResponse is { text: String, elapsedMs: long }. */
    body = await response.json();
  } catch (error) {
    return { ok: false, error: 'The AI bridge sent a body that was not JSON.' };
  }

  var parsed = parseModelJson(body ? body.text : '');

  if (!parsed.ok) {
    /* Log the raw text so the user can see what the model actually said when
     * they open the service worker console from chrome://extensions. */
    logWarning('unparseable model output was:', body ? body.text : '(nothing)');
    return { ok: false, error: parsed.error };
  }

  log('the AI answered ' + Object.keys(parsed.values).length + ' field(s) in ' +
    (body.elapsedMs || 0) + 'ms.');

  return { ok: true, values: parsed.values, elapsedMs: body.elapsedMs || 0 };
}

/* ---------------------------------------------------------------------------
 * SECTION 6b — CHAT_UPDATE_PROFILE
 * -------------------------------------------------------------------------
 * "my address is now Pune"  ->  { patch: { 'personal.city': 'Pune' },
 *                                 summary: 'Your city changes to Pune.' }
 *
 * THE ONE THING TO UNDERSTAND HERE
 *   This handler NEVER writes to chrome.storage. It answers with a PROPOSAL.
 *   chat.js renders it as a before/after diff and the user presses Apply. That
 *   separation is the whole safety story: a model that misreads a sentence
 *   costs him one click of "Discard", not a silently corrupted profile that
 *   then goes into forty job applications.
 *
 * THE SHAPE ON THE WIRE, AND WHY IT CHANGES ONCE ON THE WAY THROUGH
 *   The MODEL is asked for dot-notation, because that is what a language model
 *   gets right:  {"personal.city": "Pune"}. One flat string per change, no
 *   nesting to lose track of, and every key can be checked against the paths
 *   that actually exist in the profile.
 *
 *   chat.js, on the other hand, deep-merges the patch into the profile, so it
 *   needs the NESTED shape:  {"personal": {"city": "Pune"}}. Handing it the
 *   flat form would create a literal top-level key called "personal.city" and
 *   quietly corrupt the profile.
 *
 *   So this file converts: flatten whatever came back (dotted keys, nested
 *   objects, or a mixture of both), validate every leaf, then rebuild it as
 *   nested objects before replying. See nestPaths().
 * ------------------------------------------------------------------------ */

/**
 * The profile to diff against: whatever the user has saved, or the bundled
 * default when he has never pressed Save.
 *
 * @returns {Promise<Object>}
 */
async function readStoredProfile() {
  var stored = {};
  try {
    stored = await chrome.storage.local.get(['profile']);
  } catch (error) {
    logWarning('could not read the saved profile:', error);
    stored = {};
  }

  var saved = stored ? stored.profile : undefined;
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
    return saved;
  }

  /* Fresh install. AF.DEFAULT_PROFILE comes from the importScripts at the top
   * of this file; if that failed we are left with an empty object, which is
   * still workable — the model just has no existing values to compare against. */
  if (AF.DEFAULT_PROFILE && typeof AF.DEFAULT_PROFILE === 'object') {
    return AF.DEFAULT_PROFILE;
  }
  return {};
}

/**
 * A copy of the profile without `aliases`.
 *
 * aliases is a 500-entry synonym dictionary that exists purely so lib/match.js
 * can score form labels. It roughly doubles the prompt and there is no sentence
 * a human would type that should ever edit it.
 */
function profileForChatPrompt(profile) {
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

/** True for a plain object — not null, not an array. */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Every dotted path that already exists in the profile, so the prompt can show
 * the model where things live instead of letting it invent a layout.
 *
 * Arrays contribute their index, e.g. 'experience.0.company', because that is
 * how chat.js's getByPath addresses them.
 *
 * @param {*}      value   the node being walked
 * @param {String} prefix  the path built up so far
 * @param {Array}  out     accumulator
 */
function collectProfilePaths(value, prefix, out) {
  if (out.length >= MAX_PATHS_IN_PROMPT) {
    return out;
  }

  if (isPlainObject(value)) {
    var keys = Object.keys(value);
    var i;
    for (i = 0; i < keys.length; i++) {
      if (keys[i] === 'aliases') {
        continue;
      }
      var path = (prefix === '') ? keys[i] : (prefix + '.' + keys[i]);
      collectProfilePaths(value[keys[i]], path, out);
    }
    return out;
  }

  if (Array.isArray(value)) {
    /* A list of plain values — skills, preferredLocations, a bullet list — is
     * shown as ONE path, because rule 7 of the prompt says an array is replaced
     * wholesale. Advertising 'preferredLocations.0' would invite the model to
     * patch a single slot, which chat.js's merge does not support. */
    if (value.length === 0 || !isPlainObject(value[0])) {
      if (prefix !== '') {
        out.push(prefix);
      }
      return out;
    }

    /* A list of OBJECTS — experience, projects — genuinely needs an index, and
     * only the FIRST is described: listing experience.0 .. experience.9 teaches
     * the model nothing extra and would eat the whole path budget. */
    collectProfilePaths(value[0], prefix + '.0', out);
    return out;
  }

  if (prefix !== '') {
    out.push(prefix);
  }
  return out;
}

/**
 * Build the prompt for one chat sentence.
 *
 * @param {String} text     exactly what he typed
 * @param {Object} profile  the current profile
 * @returns {String}
 */
function buildChatPrompt(text, profile) {
  var trimmedProfile = profileForChatPrompt(profile);
  var paths = collectProfilePaths(trimmedProfile, '', []);

  var lines = [];

  lines.push('You maintain one person\'s job-application profile. They have just typed one');
  lines.push('sentence telling you something about themselves. Your only job is to work out');
  lines.push('which stored fields that sentence changes, and to propose the SMALLEST edit.');
  lines.push('');

  lines.push('=== THEIR PROFILE RIGHT NOW (JSON) ===');
  lines.push(JSON.stringify(trimmedProfile, null, 2));
  lines.push('');

  lines.push('=== THE PATHS THAT ALREADY EXIST (use these, do not invent new ones) ===');
  lines.push(paths.join('\n'));
  lines.push('');

  lines.push('=== WHAT THEY JUST TYPED ===');
  lines.push(text);
  lines.push('');

  lines.push('=== HOW TO ANSWER ===');
  lines.push('1. Reply with ONE JSON object and nothing else. No explanation before it, no');
  lines.push('   summary after it, and no markdown code fence around it.');
  lines.push('2. It has exactly two keys:');
  lines.push('     "patch"   — an object mapping DOT-NOTATION paths to their new values');
  lines.push('     "summary" — one plain sentence, addressed to them, saying what changes');
  lines.push('   Example of the exact shape expected:');
  lines.push('     {"patch":{"personal.city":"Pune","yearsOfExperience":3},');
  lines.push('      "summary":"Your city becomes Pune and your experience becomes 3 years."}');
  lines.push('3. IF THE SENTENCE CONTAINS NO FACT ABOUT THEM, ANSWER WITH AN EMPTY PATCH:');
  lines.push('     {"patch":{},"summary":"<say what you understood and that nothing changes>"}');
  lines.push('   A greeting, a question, a joke, or an instruction about how to fill forms is');
  lines.push('   NOT a profile fact. An empty patch is a correct and welcome answer. Never');
  lines.push('   invent a change just to have something to say.');
  lines.push('4. Change ONLY what the sentence actually states. If they mention their city,');
  lines.push('   do not also "tidy up" their phone number, their summary, or their skills.');
  lines.push('5. Prefer a path from the list above. Only use a new path when the fact has');
  lines.push('   genuinely nowhere to live, and keep it short and lower-camelCase.');
  lines.push('6. Values must be a string, a number, a boolean, null, or an array of strings.');
  lines.push('   Never an object — express nesting with dots in the path instead.');
  lines.push('7. AN ARRAY REPLACES THE WHOLE LIST, it is never appended to. If they say "add');
  lines.push('   Kotlin to my skills", write out the complete new list, existing entries');
  lines.push('   included.');
  lines.push('8. null means "clear this field". Use it only when they say something is no');
  lines.push('   longer true.');
  lines.push('9. Keep the existing type of a field. A path holding a number stays a number.');
  lines.push('10. Never touch "aliases".');
  lines.push('');
  lines.push('Output the JSON object now, and nothing else.');

  return lines.join('\n');
}

/**
 * Flatten a patch into leaves, accepting BOTH shapes the model might send:
 * dotted keys, nested objects, or a mixture.
 *
 *   { "personal.city": "Pune" }            -> [{path:'personal.city', value:'Pune'}]
 *   { personal: { city: 'Pune' } }         -> [{path:'personal.city', value:'Pune'}]
 *   { personal: { "city.x": 1 } }          -> [{path:'personal.city.x', value:1}]
 *
 * @param {Object} node    the object being walked
 * @param {String} prefix  the dotted path so far
 * @param {Array}  out     accumulator of {path, value}
 */
function flattenPatch(node, prefix, out) {
  var keys = Object.keys(node);
  var i;

  for (i = 0; i < keys.length; i++) {
    var key = keys[i];
    var value = node[key];
    var path = (prefix === '') ? key : (prefix + '.' + key);

    if (isPlainObject(value)) {
      if (Object.keys(value).length === 0) {
        /* An empty object sets nothing. Dropping it is better than writing {}
         * over whatever is already there. */
        continue;
      }
      flattenPatch(value, path, out);
      continue;
    }

    out.push({ path: path, value: value });
  }

  return out;
}

/**
 * Is this a value we are willing to write into the profile?
 * Strings, finite numbers, booleans, null, and arrays of those.
 */
function isAllowedPatchValue(value) {
  if (value === null || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return isFinite(value);
  }
  if (typeof value === 'string') {
    return value.length <= MAX_PATCH_VALUE_CHARS;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_PATCH_ARRAY_LENGTH) {
      return false;
    }
    var i;
    for (i = 0; i < value.length; i++) {
      var item = value[i];
      var itemIsSimple =
        (typeof item === 'string' && item.length <= MAX_PATCH_VALUE_CHARS) ||
        (typeof item === 'number' && isFinite(item)) ||
        (typeof item === 'boolean');
      if (!itemIsSimple) {
        return false;
      }
    }
    return true;
  }
  return false;
}

/**
 * Is this dotted path safe to write?
 *
 * @param {String} path
 * @returns {Boolean}
 */
function isAllowedPatchPath(path) {
  if (typeof path !== 'string' || path.trim() === '') {
    return false;
  }

  var parts = path.split('.');
  if (parts.length > MAX_PATCH_DEPTH) {
    return false;
  }

  var i;
  for (i = 0; i < parts.length; i++) {
    var part = parts[i];

    /* '' happens with 'personal..city' or a leading/trailing dot. */
    if (part.trim() === '' || part.length > 80) {
      return false;
    }
    /* The prototype-pollution guard. See FORBIDDEN_PATCH_KEYS. */
    if (FORBIDDEN_PATCH_KEYS.indexOf(part) !== -1) {
      return false;
    }
    /* 'aliases' is the matcher's private dictionary; the chat never edits it. */
    if (part === 'aliases') {
      return false;
    }
  }

  return true;
}

/**
 * Rebuild validated leaves into the NESTED object chat.js deep-merges.
 *
 *   [{path:'personal.city', value:'Pune'}]  ->  {personal: {city: 'Pune'}}
 *
 * A conflict — 'personal' set to a string AND 'personal.city' set as well —
 * resolves in favour of whichever came last, because the second write replaces
 * the first. That is the same "last one wins" rule an ordinary object literal
 * follows, and both orderings are nonsense the model should not have produced.
 */
function nestPaths(leaves) {
  var root = {};
  var i;
  var j;

  for (i = 0; i < leaves.length; i++) {
    var parts = leaves[i].path.split('.');
    var node = root;

    /* Walk (and create) every level except the last. */
    for (j = 0; j < parts.length - 1; j++) {
      if (!isPlainObject(node[parts[j]])) {
        node[parts[j]] = {};
      }
      node = node[parts[j]];
    }

    node[parts[parts.length - 1]] = leaves[i].value;
  }

  return root;
}

/**
 * Turn the model's raw `patch` into the nested, validated patch chat.js wants.
 *
 * @param {*} rawPatch
 * @returns {{ok: true, patch: Object, dropped: Number} | {ok: false, error: String}}
 */
function validateChatPatch(rawPatch) {
  /* A missing patch is not an error: the model may have answered a greeting.
   * chat.js renders an empty patch as "nothing to change". */
  if (rawPatch === undefined || rawPatch === null) {
    return { ok: true, patch: {}, dropped: 0 };
  }

  if (!isPlainObject(rawPatch)) {
    return { ok: false, error: 'The AI answered with a "patch" that was not an object.' };
  }

  var leaves = flattenPatch(rawPatch, '', []);

  if (leaves.length === 0) {
    return { ok: true, patch: {}, dropped: 0 };
  }

  if (leaves.length > MAX_PATCH_PATHS) {
    return {
      ok: false,
      error: 'The AI wanted to change ' + leaves.length + ' things at once, which is ' +
        'far more than one sentence can mean. Nothing was changed — try saying it ' +
        'again, more specifically.'
    };
  }

  var kept = [];
  var dropped = 0;
  var i;

  for (i = 0; i < leaves.length; i++) {
    var leaf = leaves[i];

    if (!isAllowedPatchPath(leaf.path)) {
      logWarning('dropped patch path "' + leaf.path + '": not a path we will write to.');
      dropped++;
      continue;
    }
    if (!isAllowedPatchValue(leaf.value)) {
      logWarning('dropped patch path "' + leaf.path + '": the value was a ' +
        typeof leaf.value + ' we will not store.');
      dropped++;
      continue;
    }

    kept.push(leaf);
  }

  /* The model proposed changes and every single one was refused. Saying
   * "nothing to change" here would be a lie — something WAS proposed and we
   * threw it away, and he deserves to know rather than wonder why his sentence
   * did nothing. */
  if (kept.length === 0) {
    return {
      ok: false,
      error: 'The AI proposed a change I was not willing to make to your profile, ' +
        'so nothing was touched. Check the service worker console for the details.'
    };
  }

  return { ok: true, patch: nestPaths(kept), dropped: dropped };
}

/**
 * The CHAT_UPDATE_PROFILE handler.
 *
 * ALWAYS resolves — never rejects, exactly like handleAiFill.
 *
 * @param {Object} request  { type, text }
 * @returns {Promise<{ok: true, patch: Object, summary: String} | {ok: false, error: String}>}
 */
async function handleChatUpdateProfile(request) {
  var text = (request && typeof request.text === 'string') ? request.text.trim() : '';

  if (text === '') {
    return { ok: false, error: 'You did not type anything.' };
  }
  if (text.length > MAX_CHAT_TEXT_CHARS) {
    return {
      ok: false,
      error: 'That message is ' + text.length + ' characters long. Tell me one thing at ' +
        'a time — a sentence or two — or edit the profile directly in Settings.'
    };
  }

  var settings = await readSettings();
  var profile = await readStoredProfile();
  var url = settings.bridgeUrl + '/fill';
  var prompt = buildChatPrompt(text, profile);

  log('POST ' + url + ' — chat update, ' + prompt.length + ' prompt chars.');

  /* --- the call. Same endpoint, same request record, same timeout as AI_FILL,
   * because the bridge has exactly one endpoint: it runs the prompt through the
   * Claude CLI and hands back the text. ------------------------------------ */
  var response;
  try {
    response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: prompt })
    }, FILL_TIMEOUT_MS);
  } catch (error) {
    if (error && error.name === 'AbortError') {
      return {
        ok: false,
        error: 'The AI bridge did not answer within ' + (FILL_TIMEOUT_MS / 1000) + ' seconds.'
      };
    }
    return {
      ok: false,
      error: 'Could not reach the AI bridge at ' + settings.bridgeUrl +
        '. Start it with `mvn spring-boot:run` in the bridge folder.'
    };
  }

  if (!response.ok) {
    var detail = '';
    try {
      /* Spring's ErrorResponse is (String error, String detail) — the same two
       * keys the AI_FILL path reads. */
      var errorBody = await response.json();
      if (errorBody && typeof errorBody.detail === 'string' && errorBody.detail !== '') {
        detail = ' ' + errorBody.detail;
      } else if (errorBody && typeof errorBody.error === 'string' && errorBody.error !== '') {
        detail = ' ' + errorBody.error;
      }
    } catch (ignored) {
      /* Not JSON. The status code alone will have to do. */
    }
    return { ok: false, error: 'The AI bridge returned ' + response.status + '.' + detail };
  }

  var body;
  try {
    body = await response.json();
  } catch (error) {
    return { ok: false, error: 'The AI bridge sent a body that was not JSON.' };
  }

  /* --- unwrap, then check the shape THIS handler needs ------------------- */
  var extracted = extractJsonObject(body ? body.text : '');

  if (!extracted.ok) {
    logWarning('unparseable chat output was:', body ? body.text : '(nothing)');
    return { ok: false, error: extracted.error };
  }

  var answer = extracted.object;

  var validated = validateChatPatch(answer.patch);
  if (!validated.ok) {
    logWarning('rejected chat patch:', JSON.stringify(answer.patch));
    return { ok: false, error: validated.error };
  }

  var summary = (typeof answer.summary === 'string') ? capText(answer.summary, 500) : '';

  log('chat update: ' + Object.keys(validated.patch).length +
    ' top-level key(s) proposed, ' + validated.dropped + ' dropped.');

  return { ok: true, patch: validated.patch, summary: summary };
}

/* ---------------------------------------------------------------------------
 * SECTION 7 — the message listener
 * -------------------------------------------------------------------------
 * Both handlers are async, so this listener MUST return true. Returning true
 * tells Chrome "I will call sendResponse later, keep the channel open". Without
 * it the channel closes the instant this function returns and the caller's
 * callback fires with `undefined` and no error at all.
 *
 * Note that an async listener function cannot be used directly for this: an
 * `async function` returns a Promise, and a Promise is not the literal `true`
 * Chrome is looking for. Hence the pattern below — call the async work, ignore
 * its promise, return true synchronously.
 * ------------------------------------------------------------------------ */
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {

  if (!message || typeof message !== 'object') {
    return; /* Not for us. undefined closes the channel immediately. */
  }

  /* --- the popup asking "is the bridge up?" ---------------------------- */
  if (message.type === 'BRIDGE_PING') {
    handleBridgePing()
      .then(function (result) {
        sendResponse(result);
      })
      .catch(function (error) {
        /* Belt and braces: handleBridgePing already catches everything, but a
         * thrown error here would leave the popup's dot grey forever. */
        logWarning('ping failed unexpectedly:', error);
        sendResponse({ online: false, detail: 'Unexpected error: ' + error });
      });
    return true;
  }

  /* --- the content script asking for AI answers ------------------------- */
  if (message.type === 'AI_FILL') {
    handleAiFill(message)
      .then(function (result) {
        sendResponse(result);
      })
      .catch(function (error) {
        logWarning('AI fill failed unexpectedly:', error);
        sendResponse({ ok: false, error: 'Unexpected error in the extension worker: ' + error });
      });
    return true;
  }

  /* --- the chat page asking what a sentence changes --------------------- */
  if (message.type === 'CHAT_UPDATE_PROFILE') {
    handleChatUpdateProfile(message)
      .then(function (result) {
        sendResponse(result);
      })
      .catch(function (error) {
        /* handleChatUpdateProfile already catches everything it can. Without
         * this, a bug that threw would leave chat.js waiting on a channel
         * nobody will ever write to, and its "Working out what that changes…"
         * bubble would sit there for ever. */
        logWarning('chat update failed unexpectedly:', error);
        sendResponse({ ok: false, error: 'Unexpected error in the extension worker: ' + error });
      });
    return true;
  }

  /* Anything else (FILL_ALL, UNDO, ... — those are for the content script)
   * is none of our business. Return undefined so the channel closes and the
   * content script's own listener is free to answer. */
  return;
});

/* One line in the service worker console (chrome://extensions -> this
 * extension -> "service worker") confirming a fresh worker has started. You
 * will see it again after every idle shutdown; that is normal MV3 behaviour,
 * not a crash. */
log('service worker started.');
