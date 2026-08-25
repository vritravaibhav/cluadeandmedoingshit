/* =============================================================================
 * lib/match.js — deterministic profile-to-field matcher
 * -----------------------------------------------------------------------------
 * WHAT THIS FILE DOES
 *   Given one scraped Field object (see the shared data contract) and the user's
 *   profile, decide — WITHOUT any AI, without touching the DOM — which profile
 *   value belongs in that field.
 *
 *   Think of it as the "obvious cases" stage:  a box labelled "First Name" gets
 *   the first name, a box labelled "Email" gets the email.  Anything that is not
 *   obvious returns null and is handed to the AI stage later in the pipeline.
 *
 * HOW IT DECIDES
 *   1. It flattens everything we know about the field (label, aria-label, name,
 *      id, placeholder, surrounding heading text) into one lowercase string that
 *      we call the "haystack".
 *   2. profile.aliases maps a dotted profile path ("personal.firstName") to a
 *      list of human phrases that usually appear on forms ("first name",
 *      "given name", "fname", ...).  Every alias is scored against the haystack.
 *   3. The best-scoring path wins, provided it clears AF.MIN_CONFIDENCE.
 *
 * PURITY RULE
 *   Nothing in this file reads or writes the DOM.  It only inspects the plain
 *   string/boolean/array properties of the Field object.  That makes it easy to
 *   unit test: build a fake field literal and call AF.matchField.
 *
 * PUBLIC API (exact names required by the project contract)
 *   AF.matchField(field, profile)   -> {key, value, confidence} | null
 *   AF.matchAll(fields, profile)    -> [{field, match}]
 *   AF.explainMatch(field, profile) -> top 3 candidates, for debugging
 *   AF.MIN_CONFIDENCE               -> tunable rejection threshold
 *
 * ...plus one addition the content script needs:
 *   AF.recognisedButBlank(field, profile) -> {key, confidence, reason} | null
 *      "I know what this box is, and the profile leaves it empty on purpose."
 *      Salary and the EEO questions must be SKIPPED, not passed to the AI, and
 *      a null from matchField alone cannot say which of the two it was.
 * ===========================================================================*/

/* Defensive namespace creation. Every file in this extension starts this way,
 * so load order never matters: whichever file loads first creates the object. */
var AF = (globalThis.AF = globalThis.AF || {});

/* -----------------------------------------------------------------------------
 * TUNABLES
 * ---------------------------------------------------------------------------*/

/* Any match scoring below this is thrown away (treated as "no match").
 * 0.55 is exactly the score of the weakest positive rule (all-tokens-present),
 * so by default that rule is the last one that still counts as a match.
 * Raise it to 0.6 to also drop bare-substring matches, or to 0.85 to demand a
 * whole-word hit. It is exported so the popup/devtools can experiment. */
AF.MIN_CONFIDENCE = 0.55;

/* The four scoring tiers, named so the code below reads like prose.
 * They are deliberately spread out so ties are rare and meaningful. */
var SCORE_EXACT = 1.0;   /* the whole field text IS the alias                 */
var SCORE_WORD = 0.85;   /* the alias appears as whole word(s) in the text    */
var SCORE_SUBSTRING = 0.6;  /* the alias appears glued inside a longer word   */
var SCORE_TOKENS = 0.55; /* every word of the alias appears, in any order     */
var SCORE_NONE = 0;      /* no relationship at all                            */

/* -----------------------------------------------------------------------------
 * SMALL STRING HELPERS
 * These are intentionally boring. No regex golf, no clever chaining.
 * ---------------------------------------------------------------------------*/

/**
 * Turn any value into a safe string. Scraped fields promise '' instead of null,
 * but we never trust that — a half-broken scrape must not throw here.
 */
function safeString(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

/**
 * Normalise a piece of form text so that "First_Name", "first-name" and
 * "  FIRST   NAME " all end up as the single canonical string "first name".
 *
 * Steps, in order:
 *   1. lowercase
 *   2. underscores, hyphens and dots become spaces (form field names love those)
 *   3. everything that is not a letter, a digit or a space is deleted
 *   4. runs of whitespace collapse to one space, and the ends are trimmed
 *
 * Because step 4 guarantees single spaces, later code can treat " " as a real
 * word boundary and does not need \b (which behaves oddly around digits).
 */
function normalise(text) {
  var lowered = safeString(text).toLowerCase();
  var spaced = lowered.replace(/[_\-.]/g, ' ');
  var cleaned = spaced.replace(/[^a-z0-9 ]/g, ' ');
  var collapsed = cleaned.replace(/\s+/g, ' ');
  return collapsed.trim();
}

/**
 * Escape a string so it can be dropped into a RegExp literally.
 * Aliases come from the profile, which the user can edit, so a stray "(" must
 * not blow up the matcher.
 */
function escapeForRegExp(text) {
  return safeString(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when `needle` appears in `haystack` as a complete word or phrase.
 *
 *   haystack "username"       +  alias "name"  -> FALSE (glued inside a word)
 *   haystack "your name here" +  alias "name"  -> TRUE
 *   haystack "company name"   +  alias "name"  -> TRUE
 *
 * READ THAT LAST LINE AGAIN. Word boundaries alone do NOT stop the classic
 * autofill disaster of typing a human name into a "Company Name" box: 'name'
 * really is a whole word there. Two other things stop it, and if you add a
 * new profile path you have to keep both working:
 *
 *   1. GENERIC_ALIASES below — one-word aliases such as 'name' are so vague
 *      that they only count when the label is EXACTLY that word.
 *   2. The ORGANISATION_WORDS guard in matchField — a haystack mentioning a
 *      company/school refuses any personal-name path (see isPersonalNamePath).
 *
 * Both arguments must already be normalised, so word boundaries are just
 * "start of string or a space" and "end of string or a space".
 */
function containsWholeWord(haystack, needle) {
  if (haystack === '' || needle === '') {
    return false;
  }
  var pattern = new RegExp('(^| )' + escapeForRegExp(needle) + '( |$)');
  return pattern.test(haystack);
}

/**
 * Split a normalised string into its words. '' yields an empty array rather
 * than [''], which would break the all-tokens check below.
 */
function tokenise(text) {
  if (text === '') {
    return [];
  }
  return text.split(' ');
}

/**
 * True when every word of the alias appears somewhere in the haystack, in any
 * order. This catches label wording we did not anticipate, e.g.
 *   alias "first name"  vs  label "name (first)"  -> TRUE
 * Each token still has to be a whole word, so "name" will not be satisfied by
 * "username".
 */
function containsAllTokens(haystack, alias) {
  var tokens = tokenise(alias);
  if (tokens.length === 0) {
    return false;
  }
  var i;
  for (i = 0; i < tokens.length; i++) {
    if (!containsWholeWord(haystack, tokens[i])) {
      return false;
    }
  }
  return true;
}

/**
 * True when ANY of the given words appears as a whole word in the haystack.
 * Used by the negative guards. Whole-word matching matters a lot here:
 * "research assistant" must not trip the 'search' guard.
 */
function containsAnyWholeWord(haystack, words) {
  var i;
  for (i = 0; i < words.length; i++) {
    if (containsWholeWord(haystack, words[i])) {
      return true;
    }
  }
  return false;
}

/* -----------------------------------------------------------------------------
 * PROFILE ACCESS
 * ---------------------------------------------------------------------------*/

/**
 * Read "personal.address.city" out of the profile object without exploding when
 * an intermediate object is missing. Returns undefined if any hop is absent.
 *
 * Java analogy: this is Optional-chaining done by hand, because the extension
 * has to run as a plain classic script with no transpiler.
 */
function getByPath(rootObject, dottedPath) {
  if (!rootObject || typeof rootObject !== 'object') {
    return undefined;
  }
  var parts = safeString(dottedPath).split('.');
  var current = rootObject;
  var i;
  for (i = 0; i < parts.length; i++) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof current !== 'object') {
      return undefined;
    }
    current = current[parts[i]];
  }
  return current;
}

/**
 * A profile value only counts as a real answer when it actually holds something.
 * Blank strings, nulls and empty arrays are treated as "the user never filled
 * this in", so we must not report a confident match for them.
 *
 * NOTE: boolean false IS a usable value (an unchecked checkbox, "No" on a
 * yes/no question), so it is deliberately NOT treated as empty.
 */
function isUsableValue(value) {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return true;
  }
  if (Array.isArray(value)) {
    /* An array of only blank strings is still effectively empty. */
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

/* -----------------------------------------------------------------------------
 * NEGATIVE GUARDS
 * Each of these encodes a wrong-fill bug that really happens on real ATS forms.
 * ---------------------------------------------------------------------------*/

/* Words that mean "this box wants the name of an ORGANISATION, not of a human".
 * Greenhouse and Workday both put "Company Name" and "School Name" right next
 * to the personal details, and a naive matcher happily types the applicant's
 * name into them. */
var ORGANISATION_WORDS = [
  'company',
  'employer',
  'organization',
  'organisation',
  'university',
  'college',
  'school',
  'institution'
];

/* Credential boxes. type=password is already refused below, but sign-in forms
 * on Upwork/Freelancer also expose plain-text "Username" and "Login" boxes, and
 * the 0.6 substring tier would happily see the alias "name" inside "username".
 * There is nothing in a resume profile that belongs in a credential box, so the
 * whole field is refused up front. */
var CREDENTIAL_WORDS = [
  'password',
  'passcode',
  'username',
  'user name',
  'userid',
  'user id',
  'login',
  'otp',
  'captcha'
];

/* Boxes that are part of the page UI, never part of the application. Filling a
 * site's search box with an email address is embarrassing and can navigate the
 * page away mid-fill. */
var UI_CONTROL_WORDS = ['search', 'filter', 'query'];

/* Words that mean "this box wants SOMEBODY ELSE'S name" — an emergency
 * contact, a referrer, a next of kin. Exactly the same idea as
 * ORGANISATION_WORDS: whatever belongs in the box, the applicant's OWN name
 * is certainly the wrong answer, and personal.fullName carries generic
 * aliases such as 'contact name' that would otherwise win these labels. */
var OTHER_PERSON_WORDS = [
  'emergency',
  'next of kin',
  'kin',
  'guardian',
  'spouse',
  'referrer',
  'referee'
];

/* Words that mean "this box wants a POSTAL code, not a telephone anything".
 * This profile has no postal-code path at all, so nothing legitimately
 * competes for a "Zip / Postal Code" label — which is precisely why a stray
 * phone alias used to win it uncontested and type "+91" into a zip box.
 * Same idea as ORGANISATION_WORDS: a whole family of wrong fills, blocked in
 * one place. */
var POSTAL_CODE_WORDS = [
  'postal',
  'postcode',
  'post code',
  'zip',
  'zipcode',
  'pincode',
  'pin code',
  'eircode'
];

/* True when a profile path holds a telephone number or its country code. */
function isPhoneNumberPath(path) {
  return safeString(path).toLowerCase().indexOf('phone') !== -1;
}

/* Free-text essay prompts. These have no deterministic answer — they must fall
 * through to the AI stage, which can write prose. Multi-word entries are
 * checked as phrases, single words as whole words; containsWholeWord handles
 * both because the haystack is space-normalised. */
var ESSAY_PHRASES = [
  'cover letter',
  'tell us',
  'why',
  'describe',
  'explain',
  'motivation'
];

/* Words that mark a duplicate-entry box: "Confirm Email", "Re-enter Password",
 * "Repeat email address". The correct behaviour is to fill them with the SAME
 * value as the original field, so we simply delete these words from the
 * haystack and let normal matching proceed on what is left.
 * Note: 're-enter' normalises to 're enter', hence the two separate entries. */
var CONFIRMATION_WORDS = [
  'confirm',
  'confirmation',
  'confirmed',
  're enter',
  'reenter',
  're type',
  'retype',
  'repeat',
  'verify',
  'again'
];

/**
 * Remove confirmation wording from a haystack so that "confirm email address"
 * behaves exactly like "email address".
 */
function stripConfirmationWords(haystack) {
  var result = haystack;
  var i;
  for (i = 0; i < CONFIRMATION_WORDS.length; i++) {
    var pattern = new RegExp('(^| )' + escapeForRegExp(CONFIRMATION_WORDS[i]) + '( |$)', 'g');
    /* Replace with a single space so surrounding words stay separated, then
     * loop again because overlapping matches can leave a word behind. */
    result = result.replace(pattern, ' ');
    result = result.replace(pattern, ' ');
  }
  return result.replace(/\s+/g, ' ').trim();
}

/**
 * True when this profile path holds a HUMAN's name
 * (personal.fullName, personal.firstName, personal.lastName, ...).
 * Used together with ORGANISATION_WORDS to block company/school name boxes.
 *
 * The test is deliberately loose — "does the path mention a name, and is it
 * not itself an organisation path?" — rather than demanding the exact prefix
 * 'personal.' and the exact suffix 'name'. A future path such as
 * 'personal.legalNameFull' or 'applicant.fullName' must not silently slip
 * past the guard just because it is spelled differently.
 */
function isPersonalNamePath(path) {
  var lowered = safeString(path).toLowerCase();

  if (lowered.indexOf('name') === -1) {
    return false; /* nothing about a name at all */
  }

  /* An organisation path is ALLOWED to hold a name — that is its whole job —
   * so those are not "personal name" paths. e.g. experience.0.companyName. */
  var i;
  for (i = 0; i < ORGANISATION_WORDS.length; i++) {
    if (lowered.indexOf(ORGANISATION_WORDS[i]) !== -1) {
      return false;
    }
  }

  return true;
}

/**
 * Hard rejections that apply to the whole field, before any scoring happens.
 * Returns a short reason string when the field must be skipped, or '' when the
 * field is allowed to continue into scoring.
 *
 * The reason string is not shown to the user by this module — it exists so that
 * AF.explainMatch can tell you WHY a field never matched.
 */

/* ---------------------------------------------------------------------------
 * SPECIFIC-TECHNOLOGY EXPERIENCE GUARD
 *
 * Real bug this fixes, found against a live Keka application form:
 *
 *   "Experience with Vert.x."                  -> yearsOfExperience = 2
 *   "Experience with Claude code or any AI tool" -> yearsOfExperience = 2
 *
 * The alias 'experience' word-matches at 0.85 and wins, so the form gets
 * "2 years" for a technology the applicant has never touched. On a job
 * application that is not a cosmetic mistake — it is a false claim that a
 * technical interviewer will find in about one question.
 *
 * The rule: when a question asks about experience AND names a specific
 * technology, only answer it when that technology is actually in the profile's
 * skills. Otherwise return no match and let the AI stage answer it honestly
 * (it can say "No" or "0", which is the truthful answer).
 *
 * Generic questions — "How many years of working experience do you have?" —
 * name no technology, so they are unaffected and still match.
 * ------------------------------------------------------------------------ */

/* Words that appear around the technology name and are not themselves a
 * technology. Anything left over after removing these is treated as a
 * candidate technology name. */
var EXPERIENCE_FILLER_WORDS = [
  'experience', 'experiance', 'years', 'year', 'yrs', 'yr', 'months', 'month',
  'do', 'you', 'have', 'has', 'your', 'the', 'a', 'an', 'of', 'in', 'on',
  'with', 'using', 'used', 'work', 'working', 'worked', 'hands', 'total',
  'relevant', 'professional', 'overall', 'how', 'many', 'much', 'any', 'and',
  'or', 'to', 'for', 'is', 'are', 'what', 'please', 'specify', 'mention',
  'state', 'enter', 'number', 'level', 'rate', 'yourself', 'been', 'ever',
  'currently', 'current', 'previous', 'past', 'field', 'domain', 'area',
  'technology', 'technologies', 'tool', 'tools', 'stack', 'skill', 'skills',
  'development', 'developer', 'engineer', 'engineering', 'software', 'it'
];

/* Build a lowercase token set of everything the applicant actually knows:
 * the flat skills array, the per-skill years map, and the stack labels used
 * across their experience entries. */
function buildKnownSkillTokens(profile) {
  var tokens = {};
  function add(value) {
    var text = safeString(value).toLowerCase();
    if (!text) { return; }
    tokens[text] = true;
    /* Index the individual words too, so "Spring Boot" answers a question
     * that only says "Spring". */
    var parts = text.split(/[^a-z0-9+#.]+/);
    var i;
    for (i = 0; i < parts.length; i++) {
      if (parts[i] && parts[i].length > 1) { tokens[parts[i]] = true; }
    }
  }
  try {
    var list = (profile && profile.skills) || [];
    var i;
    for (i = 0; i < list.length; i++) { add(list[i]); }

    var byCat = (profile && profile.skillsByCategory) || {};
    var key;
    for (key in byCat) {
      if (Object.prototype.hasOwnProperty.call(byCat, key)) {
        var cat = byCat[key] || [];
        var j;
        for (j = 0; j < cat.length; j++) { add(cat[j]); }
      }
    }

    var years = (profile && profile.yearsBySkill) || {};
    for (key in years) {
      if (Object.prototype.hasOwnProperty.call(years, key)) { add(key); }
    }
  } catch (error) {
    /* A malformed profile must not break matching. */
  }
  return tokens;
}

/**
 * Returns true when the question names a technology the applicant does NOT
 * have, and therefore must not be answered with their total years.
 */
function namesUnknownTechnology(haystack, profile) {
  if (!/\bexperi/.test(haystack)) { return false; }

  var filler = {};
  var i;
  for (i = 0; i < EXPERIENCE_FILLER_WORDS.length; i++) {
    filler[EXPERIENCE_FILLER_WORDS[i]] = true;
  }

  /* Keep dots and plus signs: 'vert.x', 'node.js', 'c++' are single tokens. */
  var words = haystack.split(/[^a-z0-9+#.]+/);
  var candidates = [];
  for (i = 0; i < words.length; i++) {
    var w = words[i];
    if (!w || w.length < 2) { continue; }
    if (filler[w]) { continue; }
    if (/^[0-9.]+$/.test(w)) { continue; }

    /* An id/name attribute contributes tokens like 'workexperience' or
     * 'totalyears'. The haystack is already lowercased, so the camelCase
     * boundary is gone and they cannot be split back apart — they would then
     * read as an unknown technology and wrongly block a perfectly generic
     * "Experience" field (real regression, caught on a live Keka form).
     *
     * A token that merely CONTAINS an experience/duration word is never a
     * technology name, so drop those too. */
    if (/experi|year|month|work|total|relevant|overall|duration/.test(w)) { continue; }

    candidates.push(w);
  }

  /* No technology named -> a generic experience question. Let it match. */
  if (!candidates.length) { return false; }

  var known = buildKnownSkillTokens(profile);
  for (i = 0; i < candidates.length; i++) {
    var c = candidates[i];
    if (known[c]) { return false; }              /* exact skill hit */
    if (known[c.replace(/[.]+$/, '')]) { return false; }  /* trailing dot: 'vert.x.' */
  }

  /* Something specific was named and none of it is in the profile. */
  return true;
}

function findBlockingReason(field, haystack, profile) {
  /* 1. Password boxes. We never autofill credentials, full stop. */
  var rawType = safeString(field && field.type).toLowerCase();
  if (rawType === 'password') {
    return 'field type is password';
  }

  /* 2. Credential boxes that are not typed as password ("Username", "Login"). */
  if (containsAnyWholeWord(haystack, CREDENTIAL_WORDS)) {
    return 'looks like a credential box (username/login/password)';
  }

  /* 3. Site chrome: search / filter / query boxes. */
  if (containsAnyWholeWord(haystack, UI_CONTROL_WORDS)) {
    return 'looks like a search/filter/query control';
  }

  /* 4. Essay prompts belong to the AI stage, not to us. */
  if (containsAnyWholeWord(haystack, ESSAY_PHRASES)) {
    return 'free-text prompt, deferred to the AI stage';
  }

  /* 5. "Experience with <technology he does not have>" — see the long comment
   *    on namesUnknownTechnology above. Answering these with his total years
   *    puts a false claim on a job application. */
  if (namesUnknownTechnology(haystack, profile)) {
    return 'asks about a specific technology that is not in your skills';
  }

  /* 6. Very long textareas with no useful labelling are also essay-ish, but we
   *    do NOT guess here — a labelled textarea such as "Address" is legitimate.
   *    So nothing to do; this comment exists so the next reader does not add a
   *    blanket "textarea => null" rule by mistake. */

  return '';
}

/* -----------------------------------------------------------------------------
 * HAYSTACK CONSTRUCTION
 * ---------------------------------------------------------------------------*/

/**
 * Build the single searchable string for a field, in the exact order fixed by
 * the project contract:
 *   label, ariaLabel, name, id, placeholder, context
 *
 * Order only matters for readability while debugging — scoring is
 * order-insensitive — but keeping it stable makes explainMatch output
 * comparable between runs.
 */
function buildHaystack(field) {
  if (!field) {
    return '';
  }
  var parts = [
    safeString(field.label),
    safeString(field.ariaLabel),
    safeString(field.name),
    safeString(field.id),
    safeString(field.placeholder),
    safeString(field.context)
  ];
  return normalise(parts.join(' '));
}

/**
 * The same string WITHOUT field.context — only the control's own wording.
 *
 * WHY TWO HAYSTACKS
 *   field.context is the nearest heading or <legend>, which is shared by every
 *   control in that section. It is good EVIDENCE for scoring ("this box sits
 *   under 'Work Authorization'"), but it must never be allowed to VETO a
 *   field, because one section heading would then disable deterministic
 *   matching for everything underneath it:
 *
 *     {label: 'LinkedIn Profile', context: 'Why do you want to join us?'}
 *         -> the word 'why' in the CONTEXT used to trip the essay guard, so a
 *            URL we know perfectly well was sent to the AI instead.
 *     {label: 'Country', context: 'Search'}   -> same, via the search guard.
 *
 *   content.js does exactly the same thing for its own noise filter, and for
 *   exactly the same reason. Keep the two in step.
 */
function buildControlHaystack(field) {
  if (!field) {
    return '';
  }
  var parts = [
    safeString(field.label),
    safeString(field.ariaLabel),
    safeString(field.name),
    safeString(field.id),
    safeString(field.placeholder)
  ];
  return normalise(parts.join(' '));
}

/* -----------------------------------------------------------------------------
 * SCORING
 * ---------------------------------------------------------------------------*/

/* THE SPECIFICITY FLOOR.
 *
 * Some aliases in the profile are single words so generic that finding them
 * inside a longer label tells us nothing at all. The alias table lists 'name'
 * (personal.fullName), 'number' (personal.phone) and 'code'
 * (personal.phoneCountryCode) because a box labelled exactly "Name" or
 * "Number" really is that field. But at the 0.85 whole-word tier those same
 * three aliases used to win, uncontested and above the confidence threshold,
 * on labels that mean something completely different:
 *
 *   "Postal Code"      -> 'code'   -> phone country code "+91"   (!!)
 *   "Reference Number" -> 'number' -> the applicant's phone number
 *   "Middle Name"      -> 'name'   -> the applicant's full name
 *
 * So these aliases are allowed to score ONLY at the exact tier: the whole
 * label must be that one word. "Name" still matches; "Middle Name" no longer
 * does, and falls through to the AI stage where a wrong guess is at least
 * marked as a guess.
 *
 * Add an entry here whenever a one-word alias could plausibly appear as a
 * modifier inside an unrelated question. */
var GENERIC_ALIASES = [
  'name',
  'number',
  'code',
  'no',
  'id'
];

/** True when `alias` (already normalised) is on the generic list above. */
function isGenericAlias(alias) {
  var i;
  for (i = 0; i < GENERIC_ALIASES.length; i++) {
    if (GENERIC_ALIASES[i] === alias) {
      return true;
    }
  }
  return false;
}

/**
 * Score one alias against one haystack. Returns a plain object so the caller
 * can also report HOW the match happened, which is the whole point of
 * explainMatch.
 *
 * The four tiers, strongest first:
 *   exact     1.00  haystack === alias                ("email" vs "email")
 *   word      0.85  alias appears as whole word(s)    ("email" in "work email")
 *   substring 0.60  alias is glued inside a word      ("email" in "emailaddr")
 *   tokens    0.55  all alias words appear, any order ("first name" in
 *                                                      "name first")
 *
 * ...except for GENERIC_ALIASES, which may only ever reach the exact tier.
 */
function scoreAlias(haystack, rawAlias) {
  var alias = normalise(rawAlias);

  var result = {
    alias: alias,
    score: SCORE_NONE,
    how: 'none',
    length: alias.length
  };

  if (haystack === '' || alias === '') {
    return result;
  }

  if (haystack === alias) {
    result.score = SCORE_EXACT;
    result.how = 'exact';
    return result;
  }

  /* Not an exact hit, and too generic to trust any of the looser tiers.
   * Returning here leaves the score at SCORE_NONE, i.e. "no relationship". */
  if (isGenericAlias(alias)) {
    return result;
  }

  if (containsWholeWord(haystack, alias)) {
    result.score = SCORE_WORD;
    result.how = 'word';
    return result;
  }

  if (haystack.indexOf(alias) !== -1) {
    result.score = SCORE_SUBSTRING;
    result.how = 'substring';
    return result;
  }

  if (containsAllTokens(haystack, alias)) {
    result.score = SCORE_TOKENS;
    result.how = 'tokens';
    return result;
  }

  return result;
}

/**
 * Normalise profile.aliases into a list of {path, aliases[]} entries.
 * Accepts the documented shape (an object of path -> array of strings) and is
 * forgiving about a lone string being used instead of a one-element array.
 */
function listAliasEntries(profile) {
  var entries = [];
  var aliasMap = profile && profile.aliases;
  if (!aliasMap || typeof aliasMap !== 'object') {
    return entries;
  }

  var paths = Object.keys(aliasMap);
  var i;
  for (i = 0; i < paths.length; i++) {
    var path = paths[i];
    var value = aliasMap[path];
    var aliases;

    if (Array.isArray(value)) {
      aliases = value;
    } else if (typeof value === 'string') {
      aliases = [value];
    } else {
      /* Unknown shape — skip it rather than crashing the whole fill. */
      continue;
    }

    entries.push({ path: path, aliases: aliases });
  }
  return entries;
}

/**
 * Score every alias of every profile path against the haystack and return the
 * candidate list, best first.
 *
 * Ranking rules (in order):
 *   1. higher score wins
 *   2. on a tie, the LONGER alias wins — this is what makes "first name" beat
 *      "name" on a label that contains both concepts
 *   3. on a further tie, alphabetical path order, purely so results are stable
 *      between runs and easy to diff while debugging
 */
function rankCandidates(haystack, profile) {
  var entries = listAliasEntries(profile);
  var candidates = [];
  var i;
  var j;

  for (i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var best = null;

    /* Pick the best alias WITHIN this path first, using the same tie-break. */
    for (j = 0; j < entry.aliases.length; j++) {
      var scored = scoreAlias(haystack, entry.aliases[j]);
      if (scored.score <= SCORE_NONE) {
        continue;
      }
      if (best === null) {
        best = scored;
        continue;
      }
      if (scored.score > best.score) {
        best = scored;
      } else if (scored.score === best.score && scored.length > best.length) {
        best = scored;
      }
    }

    if (best !== null) {
      candidates.push({
        path: entry.path,
        alias: best.alias,
        score: best.score,
        how: best.how,
        aliasLength: best.length
      });
    }
  }

  /* Now sort the per-path winners against each other. */
  candidates.sort(function (a, b) {
    if (b.score !== a.score) {
      return b.score - a.score;          /* rule 1: higher score first        */
    }
    if (b.aliasLength !== a.aliasLength) {
      return b.aliasLength - a.aliasLength; /* rule 2: longer alias first     */
    }
    if (a.path < b.path) {
      return -1;                          /* rule 3: stable, alphabetical     */
    }
    if (a.path > b.path) {
      return 1;
    }
    return 0;
  });

  return candidates;
}

/* -----------------------------------------------------------------------------
 * VALUE COERCION
 * ---------------------------------------------------------------------------*/

/* Strings that mean "false" when they arrive from a profile stored as text. */
var FALSY_WORDS = ['false', 'no', 'n', '0', 'off', 'none', 'unchecked'];

/**
 * Interpret a profile value as a yes/no answer.
 */
function toBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  var text = normalise(value);
  if (text === '') {
    return false;
  }
  var i;
  for (i = 0; i < FALSY_WORDS.length; i++) {
    if (text === FALSY_WORDS[i]) {
      return false;
    }
  }
  return true;
}

/**
 * True when a <select> / radio group is really a yes/no question, so that a
 * boolean profile value can be turned into the literal option text.
 * We require at least one yes-ish option AND at least one no-ish option; a
 * dropdown of countries obviously fails that test.
 */
function optionsLookLikeYesNo(options) {
  if (!Array.isArray(options) || options.length === 0) {
    return false;
  }
  var sawYes = false;
  var sawNo = false;
  var i;
  for (i = 0; i < options.length; i++) {
    var option = options[i] || {};
    var text = normalise(option.text);
    var value = normalise(option.value);
    if (text === 'yes' || value === 'yes' || text === 'y' || value === 'true') {
      sawYes = true;
    }
    if (text === 'no' || value === 'no' || text === 'n' || value === 'false') {
      sawNo = true;
    }
  }
  return sawYes && sawNo;
}

/**
 * Flatten a profile value into the shape the FILLER expects for this kind of
 * control. The filler owns option-text matching for select/radio, so here we
 * only guarantee it receives a sensible string (or a boolean for checkboxes).
 */
function coerceValue(rawValue, field) {
  var kind = safeString(field && field.kind).toLowerCase();

  /* Checkboxes are a pure on/off decision. */
  if (kind === 'checkbox') {
    return toBoolean(rawValue);
  }

  /* Selects and radios: the filler will compare our string against
   * field.options, so pass the raw text through untouched — EXCEPT when the
   * profile stored a boolean and the control is a yes/no question, in which
   * case the filler has nothing to compare a boolean to. Hand it 'Yes'/'No'. */
  if (kind === 'select' || kind === 'radio') {
    if (typeof rawValue === 'boolean') {
      var options = (field && field.options) || [];
      if (optionsLookLikeYesNo(options) || options.length === 0) {
        return rawValue ? 'Yes' : 'No';
      }
      return String(rawValue);
    }
    if (Array.isArray(rawValue)) {
      return rawValue.join(', ');
    }
    return String(rawValue);
  }

  /* Everything else (text, textarea, contenteditable, file, ...) is text.
   * Arrays become a comma-separated list, which is how skills/languages read
   * naturally in a single-line box. */
  if (Array.isArray(rawValue)) {
    var pieces = [];
    var i;
    for (i = 0; i < rawValue.length; i++) {
      var piece = safeString(rawValue[i]).trim();
      if (piece !== '') {
        pieces.push(piece);
      }
    }
    return pieces.join(', ');
  }

  return String(rawValue);
}

/* -----------------------------------------------------------------------------
 * PUBLIC API
 * ---------------------------------------------------------------------------*/

/* The four things that can happen to a field. decide() returns one of them and
 * every public function in this file is a thin wrapper over it, so they can
 * never drift apart in what they report.
 *
 *   'blocked'  a hard rejection (password box, search box, essay prompt)
 *   'match'    we know the answer -> {key, value, confidence}
 *   'blank'    we RECOGNISED the field, but the profile leaves it blank on
 *              purpose (salary, EEO self-identification, referral). This is
 *              NOT the same as "no idea": the field must be skipped, not
 *              handed to the AI to invent an answer for.
 *   'none'     nothing scored — genuinely unknown, the AI may try.
 */
var OUTCOME_BLOCKED = 'blocked';
var OUTCOME_MATCH = 'match';
var OUTCOME_BLANK = 'blank';
var OUTCOME_NONE = 'none';

/**
 * The whole decision, in one place. Everything below is a wrapper.
 *
 * @returns {{outcome:String, key:String, value:*, confidence:Number, reason:String}}
 */
function decide(field, profile) {
  var nothing = { outcome: OUTCOME_NONE, key: '', value: null, confidence: 0, reason: '' };

  if (!field || !profile) {
    return nothing;
  }

  /* --- step 1: flatten the field into searchable strings ------------------ */
  /* Two of them: see buildControlHaystack for why the section heading may
   * score a field but must never veto it. */
  var controlHaystack = buildControlHaystack(field);
  var rawHaystack = buildHaystack(field);

  /* --- step 2: hard rejections (password, search box, essay prompt) ------- */
  var blocked = findBlockingReason(field, controlHaystack, profile);
  if (blocked !== '') {
    return { outcome: OUTCOME_BLOCKED, key: '', value: null, confidence: 0, reason: blocked };
  }

  /* --- step 3: "confirm email" is just "email" ---------------------------- */
  var haystack = stripConfirmationWords(rawHaystack);
  if (haystack === '') {
    return nothing;
  }

  /* --- step 4: score every profile path and walk the ranking -------------- */
  var candidates = rankCandidates(haystack, profile);
  var mentionsOrganisation = containsAnyWholeWord(haystack, ORGANISATION_WORDS);
  var mentionsOtherPerson = containsAnyWholeWord(haystack, OTHER_PERSON_WORDS);
  var mentionsPostalCode = containsAnyWholeWord(haystack, POSTAL_CODE_WORDS);

  var i;
  for (i = 0; i < candidates.length; i++) {
    var candidate = candidates[i];

    /* Confidence floor. Candidates are sorted, so once we drop below the
     * threshold nothing further down can pass either — stop looking. */
    if (candidate.score < AF.MIN_CONFIDENCE) {
      break;
    }

    /* Guard: never type a human name into "Company Name" / "School Name". */
    if (mentionsOrganisation && isPersonalNamePath(candidate.path)) {
      continue;
    }

    /* Guard: "Emergency Contact Name" is not the applicant's own name. */
    if (mentionsOtherPerson && isPersonalNamePath(candidate.path)) {
      continue;
    }

    /* Guard: "Zip / Postal Code" is an address, never a telephone. */
    if (mentionsPostalCode && isPhoneNumberPath(candidate.path)) {
      continue;
    }

    var rawValue = getByPath(profile, candidate.path);

    /* The top candidate is blank ON PURPOSE (see profile.js: currentCTC,
     * expectedCTC, gender, ethnicity, veteranStatus, disabilityStatus,
     * referredBy). Report that and STOP.
     *
     * Why stop instead of trying the next candidate: the next candidate is
     * almost never a weaker reading of the same concept, it is a DIFFERENT
     * concept that happens to share a word. "Name of referrer" ranked
     * referredBy first (blank) and personal.fullName second — and used to
     * submit the applicant's own name as the person who referred them. */
    if (!isUsableValue(rawValue)) {
      return {
        outcome: OUTCOME_BLANK,
        key: candidate.path,
        value: null,
        confidence: candidate.score,
        reason: 'the profile leaves this blank on purpose'
      };
    }

    return {
      outcome: OUTCOME_MATCH,
      key: candidate.path,
      value: coerceValue(rawValue, field),
      confidence: candidate.score,
      reason: ''
    };
  }

  /* Nothing survived — let the AI stage try. */
  return nothing;
}

/**
 * AF.matchField(field, profile) -> {key, value, confidence} | null
 *
 * The single entry point used by the content script for the deterministic pass.
 * Returns null whenever we are not confident, which is the signal to hand the
 * field to the AI bridge instead.
 *
 * NOTE for the caller: null covers TWO different situations — "no idea" and
 * "recognised, but deliberately left blank". Before sending a null-matched
 * field to the AI, ask AF.recognisedButBlank() which of the two it was.
 */
AF.matchField = function matchField(field, profile) {
  var decision = decide(field, profile);

  if (decision.outcome !== OUTCOME_MATCH) {
    return null;
  }

  return {
    key: decision.key,
    value: decision.value,
    confidence: decision.confidence
  };
};

/**
 * AF.recognisedButBlank(field, profile) -> {key, confidence, reason} | null
 *
 * "I know exactly what this box is, and the profile intentionally has no
 * answer for it."
 *
 * profile.js keeps currentCTC, expectedCTC, gender, ethnicity, veteranStatus,
 * disabilityStatus and referredBy as empty strings ON PURPOSE, and says so in
 * its own comments: the extension must not answer them for the user. Those
 * fields still carry a full alias list precisely so they can be IDENTIFIED
 * and skipped.
 *
 * Without this function the content script cannot tell them apart from
 * "unrecognised" and hands them to the language model, which then invents a
 * salary figure and picks a protected-class answer. Returns null for every
 * other outcome.
 */
AF.recognisedButBlank = function recognisedButBlank(field, profile) {
  var decision = decide(field, profile);

  if (decision.outcome !== OUTCOME_BLANK) {
    return null;
  }

  return {
    key: decision.key,
    confidence: decision.confidence,
    reason: decision.reason
  };
};

/**
 * AF.matchAll(fields, profile) -> [{field, match}]
 *
 * Runs matchField over a whole scrape in one pass and keeps the field objects
 * paired with their results. `match` is null where nothing was confident, so
 * the caller can partition in a single loop:
 *
 *   var results = AF.matchAll(fields, profile);
 *   results.forEach(function (row) {
 *     if (row.match) { deterministicBucket.push(row); }
 *     else           { aiBucket.push(row.field);      }
 *   });
 *
 * The array is returned in the same order as the input, so `index` on each
 * field still lines up with document order.
 */
AF.matchAll = function matchAll(fields, profile) {
  var results = [];
  if (!Array.isArray(fields)) {
    return results;
  }

  var i;
  for (i = 0; i < fields.length; i++) {
    var field = fields[i];
    results.push({
      field: field,
      match: AF.matchField(field, profile)
    });
  }
  return results;
};

/**
 * AF.explainMatch(field, profile) -> array of up to 3 debug rows
 *
 * Debugging aid. Answers "why did this box get the wrong value?" and "why did
 * this box get nothing?". Run it from the devtools console on a live scrape:
 *
 *   console.table(AF.explainMatch(AF.scrapeFields(document)[7], profile));
 *
 * Each row contains:
 *   rank        1..3, best first
 *   path        the profile path that was considered
 *   alias       which alias of that path scored best
 *   score       0..1
 *   how         'exact' | 'word' | 'substring' | 'tokens'
 *   value       what the profile currently holds at that path
 *   accepted    true only for the row matchField would actually have used
 *   reason      why the row was rejected ('' when accepted)
 *   haystack    the normalised field text every score was computed against
 *
 * When the field was rejected outright (password, search box, essay prompt) the
 * function returns a single row with rank 0 explaining that.
 */
AF.explainMatch = function explainMatch(field, profile) {
  var controlHaystack = buildControlHaystack(field);
  var rawHaystack = buildHaystack(field);

  /* Whole-field rejection: report it as one row and stop. Note this is judged
   * on the CONTROL's own wording only, exactly as decide() does. */
  var blocked = findBlockingReason(field, controlHaystack, profile);
  if (blocked !== '') {
    return [{
      rank: 0,
      path: '',
      alias: '',
      score: 0,
      how: 'none',
      value: undefined,
      accepted: false,
      reason: blocked,
      haystack: controlHaystack
    }];
  }

  var haystack = stripConfirmationWords(rawHaystack);
  var candidates = rankCandidates(haystack, profile);
  var mentionsOrganisation = containsAnyWholeWord(haystack, ORGANISATION_WORDS);
  var mentionsOtherPerson = containsAnyWholeWord(haystack, OTHER_PERSON_WORDS);
  var mentionsPostalCode = containsAnyWholeWord(haystack, POSTAL_CODE_WORDS);

  /* Recompute acceptance exactly the way decide() does, so the two can never
   * drift apart in what they report. `stopReason` is set as soon as the walk
   * would have ended, either with a winner or with a blank-by-design hit. */
  var stopReason = '';
  var rows = [];
  var limit = Math.min(3, candidates.length);
  var i;

  for (i = 0; i < limit; i++) {
    var candidate = candidates[i];
    var rawValue = getByPath(profile, candidate.path);
    var reason = '';

    if (candidate.score < AF.MIN_CONFIDENCE) {
      reason = 'below MIN_CONFIDENCE (' + AF.MIN_CONFIDENCE + ')';
    } else if (stopReason !== '') {
      reason = stopReason;
    } else if (mentionsOrganisation && isPersonalNamePath(candidate.path)) {
      reason = 'organisation wording blocks a personal name';
    } else if (mentionsOtherPerson && isPersonalNamePath(candidate.path)) {
      reason = 'this box wants another person\'s name, not the applicant\'s';
    } else if (mentionsPostalCode && isPhoneNumberPath(candidate.path)) {
      reason = 'postal/zip wording blocks a phone number';
    } else if (!isUsableValue(rawValue)) {
      reason = 'profile value is empty — recognised, skipped on purpose';
      stopReason = 'the walk stopped at a blank-by-design candidate above';
    }

    var accepted = reason === '';
    if (accepted) {
      stopReason = 'a higher-ranked candidate already won';
    }

    rows.push({
      rank: i + 1,
      path: candidate.path,
      alias: candidate.alias,
      score: candidate.score,
      how: candidate.how,
      value: rawValue,
      accepted: accepted,
      reason: reason,
      haystack: haystack
    });
  }

  /* No candidate scored at all — still say something useful. */
  if (rows.length === 0) {
    rows.push({
      rank: 0,
      path: '',
      alias: '',
      score: 0,
      how: 'none',
      value: undefined,
      accepted: false,
      reason: 'no alias in the profile scored above zero',
      haystack: haystack
    });
  }

  return rows;
};
