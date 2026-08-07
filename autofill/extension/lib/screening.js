/* =====================================================================
 * screening.js — standard answers to the screening questions that appear
 * on almost every application.
 *
 * WHY THIS FILE EXISTS
 *
 * match.js only answers a field when it can map it to a real value in the
 * profile. That is correct for "what is your phone number" and useless for
 * "have you ever been convicted of a crime" — the answer is not a fact
 * stored in a resume, it is a standard answer that is the same on almost
 * every form.
 *
 * Without this file those questions fall through to the AI, cost a round
 * trip, and often come back blank because the model was told not to guess.
 * With it they are answered instantly, offline, and consistently.
 *
 * ORDER OF PRECEDENCE (see content.js)
 *   1. knowledge.js  — an answer HE typed himself. Always wins.
 *   2. match.js      — a real value from the profile.
 *   3. screening.js  — THIS FILE: the standard answer.
 *   4. AI            — anything genuinely novel.
 *
 * So anything he corrects once via the ask panel permanently overrides
 * whatever is written here. This file is the floor, not the ceiling.
 *
 * ── A NOTE ON THE LEGAL ONES ────────────────────────────────────────
 * Criminal history, work authorisation and sponsorship answers carry
 * legal weight on a real application. They are answered here with the
 * common-case value, tagged review:true, highlighted amber in the page,
 * and listed in the popup afterwards. Nothing here is ever submitted
 * automatically — the extension does not click submit buttons. Check the
 * amber fields before you send a form, especially for a role in a
 * country you would actually need sponsorship for.
 * ===================================================================== */

var AF = (globalThis.AF = globalThis.AF || {});

(function () {
  'use strict';

  /* Confidence assigned to a screening answer. Deliberately below a real
   * profile match (which scores 0.85-1.0) and below a learned answer
   * (0.95), so this never overrides something we actually know. */
  var SCREENING_CONFIDENCE = 0.7;

  /* -------------------------------------------------------------------
   * Helpers
   * ---------------------------------------------------------------- */

  function s(v) {
    return v === null || v === undefined ? '' : String(v);
  }

  /* Normalise a question to lowercase words separated by single spaces.
   * camelCase is split so 'workAuthorization' becomes 'work authorization'. */
  function normalise(text) {
    return s(text)
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .replace(/[_\-.]+/g, ' ')
      .replace(/[^a-z0-9 ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* Read a dot-notation path out of the profile, tolerating gaps. */
  function pick(profile, path) {
    var parts = s(path).split('.');
    var node = profile;
    var i;
    for (i = 0; i < parts.length; i++) {
      if (!node || typeof node !== 'object') return undefined;
      node = node[parts[i]];
    }
    return node;
  }

  /* -------------------------------------------------------------------
   * THE ANSWER BANK
   *
   * Each rule:
   *   id       stable name, used for logging and for the review list
   *   any      question matches if ANY of these regexes hit
   *   not      ...unless one of these hits (kills false positives)
   *   answer   a literal, or a function(profile) returning one
   *   review   true  -> highlighted amber and listed for manual review
   *   why      one line shown in the review list so he knows what it did
   *
   * Rules are evaluated top to bottom; the FIRST match wins. More
   * specific rules therefore come first.
   * ---------------------------------------------------------------- */

  var RULES = [
    /* ---- eligibility & legal ------------------------------------- */
    {
      id: 'criminal-history',
      any: [
        /\bconvicted\b/,
        /\bcriminal (record|history|conviction|offence|offense|background)\b/,
        /\bfelony\b/,
        /\bmisdemean/,
        /\bever been (arrested|charged)\b/,
        /\bpled (guilty|no contest)\b/,
      ],
      answer: 'No',
      review: true,
      why: 'Standard answer. Verify before submitting.',
    },
    {
      id: 'work-authorisation',
      any: [
        /\b(authorized|authorised|eligible|legally (able|entitled|permitted))\b.*\bwork\b/,
        /\bwork\b.*\b(authorization|authorisation|eligibility)\b/,
        /\bright to work\b/,
        /\blegally allowed to work\b/,
      ],
      not: [/\bsponsor/, /\bvisa\b.*\brequire/],
      answer: 'Yes',
      review: true,
      why: 'Assumed yes. Wrong for a role in a country you cannot work in.',
    },
    {
      id: 'sponsorship',
      any: [
        /\b(require|need|will you need).{0,24}\bsponsorship\b/,
        /\bsponsorship\b.{0,24}\b(required|needed)\b/,
        /\bvisa sponsorship\b/,
        /\bh1b\b/,
      ],
      answer: function (p) {
        var v = pick(p, 'personal.requiresSponsorship');
        if (v === undefined) v = pick(p, 'requiresSponsorship');
        return v === true ? 'Yes' : 'No';
      },
      review: true,
      why: 'From your profile. For a US/UK/EU role this is very likely Yes.',
    },
    { id: 'age-18', any: [/\b(18|eighteen) years or older\b/, /\bat least 18\b/, /\bover 18\b/], answer: 'Yes' },
    { id: 'background-check', any: [/\bbackground check\b/, /\bbackground screening\b/, /\bconsent to.{0,20}verification\b/], answer: 'Yes' },
    { id: 'drug-test', any: [/\bdrug (test|screen)/, /\bsubstance (test|screen)/], answer: 'Yes' },
    { id: 'non-compete', any: [/\bnon[\s-]?compete\b/, /\brestrictive covenant\b/, /\bnon[\s-]?solicit/], answer: 'No', review: true, why: 'Standard answer. Check your current contract.' },
    { id: 'previously-employed', any: [/\b(previously|ever) (been )?(employed|worked) (by|at|for)\b/, /\bformer employee\b/, /\bworked here before\b/], answer: 'No' },
    { id: 'related-to-employee', any: [/\brelated to\b.{0,30}\b(employee|anyone)\b/, /\bfamily member.{0,20}(work|employ)/, /\brelative.{0,20}(work|employ)/], answer: 'No' },
    { id: 'terminated-for-cause', any: [/\bterminated for cause\b/, /\bdismissed\b.{0,20}\bmisconduct\b/, /\bever been fired\b/], answer: 'No', review: true, why: 'Standard answer.' },

    /* ---- logistics ----------------------------------------------- */
    {
      id: 'notice-period',
      any: [/\bnotice period\b/, /\bhow (soon|quickly).{0,20}(start|join)\b/, /\bavailability to (start|join)\b/, /\bwhen can you (start|join)\b/, /\bearliest.{0,15}(start|joining) date\b/],
      answer: function (p) {
        return s(pick(p, 'noticePeriod')) || s(pick(p, 'earliestStartDate')) || '30 days';
      },
    },
    {
      id: 'relocate',
      any: [/\bwilling to relocate\b/, /\bopen to relocat/, /\brelocation\b/],
      answer: function (p) {
        return pick(p, 'willingToRelocate') === false ? 'No' : 'Yes';
      },
    },
    { id: 'travel', any: [/\bwilling to travel\b/, /\bable to travel\b/, /\btravel requirement/], answer: 'Yes' },
    { id: 'remote-onsite', any: [/\bwilling to work (remotely|on[\s-]?site|from office|hybrid)\b/, /\bcomfortable working (remotely|on[\s-]?site|hybrid)\b/, /\bwork from office\b/], answer: 'Yes' },
    { id: 'overtime-weekends', any: [/\bovertime\b/, /\bweekends\b/, /\bflexible (hours|shift)/, /\bshift work\b/], answer: 'Yes' },
    { id: 'full-time', any: [/\bavailable (for )?full[\s-]?time\b/, /\bfull[\s-]?time (availability|basis)\b/, /\b40 hours\b/], answer: 'Yes' },
    { id: 'own-equipment', any: [/\bown (laptop|computer|equipment|device)\b/, /\breliable internet\b/, /\bstable internet\b/, /\bhome office\b/], answer: 'Yes' },

    /* ---- references & process ------------------------------------ */
    { id: 'references-available', any: [/\breferences? (available|upon request|on request)\b/, /\bcan you provide references\b/, /\bwilling to provide references\b/], answer: 'Yes' },
    { id: 'referred-by', any: [/\breferred by\b/, /\breferral (name|source)\b/, /\bwho referred you\b/, /\bemployee referral\b/], answer: function (p) { return s(pick(p, 'referredBy')); } },
    { id: 'how-did-you-hear', any: [/\bhow did you (hear|find|learn)\b/, /\bwhere did you (hear|find)\b/, /\bsource of (application|referral)\b/], answer: function (p) { return s(pick(p, 'howDidYouHear')) || 'Company website'; } },
    { id: 'currently-employed', any: [/\bcurrently employed\b/, /\bpresently employed\b/, /\bare you working\b/], answer: 'Yes' },
    { id: 'applied-before', any: [/\bapplied (to|for|here) before\b/, /\bprevious application\b/, /\bapplied previously\b/], answer: 'No' },
    { id: 'other-offers', any: [/\bother (offers|interviews|applications) (in progress|pending)\b/, /\binterviewing elsewhere\b/], answer: 'No' },

    /* ---- self-identification (EEO) -------------------------------
     * "Prefer not to say" is a real, always-valid option on these — it
     * is not a guess and not a false statement, which is why it is the
     * default rather than inventing a value. Overridden by anything he
     * sets in the profile. */
    {
      id: 'eeo-gender',
      any: [/\bgender\b/, /\bsex\b(?!ual orientation)/],
      answer: function (p) { return s(pick(p, 'gender')) || 'Prefer not to say'; },
    },
    {
      id: 'eeo-ethnicity',
      any: [/\b(ethnicity|ethnic|race|racial)\b/, /\bhispanic or latino\b/],
      answer: function (p) { return s(pick(p, 'ethnicity')) || 'Prefer not to say'; },
    },
    {
      id: 'eeo-veteran',
      any: [/\bveteran\b/, /\bmilitary service\b/, /\barmed forces\b/],
      answer: function (p) { return s(pick(p, 'veteranStatus')) || 'I do not wish to answer'; },
    },
    {
      id: 'eeo-disability',
      any: [/\bdisabilit/, /\bdisabled\b/, /\bimpairment\b/],
      answer: function (p) { return s(pick(p, 'disabilityStatus')) || 'I do not wish to answer'; },
    },

    /* ---- consent / acknowledgement checkboxes --------------------
     * Ticking these is required to submit almost every form. */
    {
      id: 'consent',
      any: [
        /\b(i )?(agree|consent|accept|acknowledge)\b/,
        /\bterms (and|&) conditions\b/,
        /\bprivacy (policy|notice)\b/,
        /\bgdpr\b/,
        /\bdata processing\b/,
        /\bcertify that\b/,
        /\bconfirm that the (information|above)\b/,
      ],
      answer: true,
      review: true,
      why: 'Consent box ticked. Read it before submitting.',
    },
    {
      id: 'marketing-optin',
      any: [/\b(marketing|promotional|newsletter)\b/, /\bkeep me (informed|updated)\b/, /\bsend me\b.{0,20}\b(jobs|opportunities|updates)\b/, /\bsubscribe\b/],
      answer: false,
      why: 'Marketing opt-in left unticked.',
    },
  ];

  /* -------------------------------------------------------------------
   * Matching
   * ---------------------------------------------------------------- */

  /* Build the text we test the rules against. Deliberately EXCLUDES
   * field.context: a "Have you been convicted..." heading above a whole
   * section would otherwise make every field in that section match the
   * criminal-history rule. */
  function haystackFor(field) {
    if (!field || typeof field !== 'object') return '';
    return normalise([field.label, field.ariaLabel, field.name, field.id, field.placeholder].map(s).join(' '));
  }

  function ruleMatches(rule, hay) {
    var i;
    if (rule.not) {
      for (i = 0; i < rule.not.length; i++) {
        if (rule.not[i].test(hay)) return false;
      }
    }
    for (i = 0; i < rule.any.length; i++) {
      if (rule.any[i].test(hay)) return true;
    }
    return false;
  }

  /* Coerce the rule's answer to something appropriate for the control.
   * A rule answering 'Yes' against a checkbox must become boolean true;
   * a rule answering true against a radio must become the option whose
   * text reads like yes. */
  function coerceForField(field, value) {
    var kind = s(field && field.kind);
    var isBool = typeof value === 'boolean';
    var yes = isBool ? value : /^(yes|true|y)$/i.test(s(value));

    if (kind === 'checkbox') return isBool ? value : yes;

    if (kind === 'select' || kind === 'radio') {
      var options = (field && field.options) || [];
      if (!options.length) return isBool ? (value ? 'Yes' : 'No') : s(value);

      var wanted = isBool ? (value ? 'yes' : 'no') : normalise(value);
      var i, text;

      /* exact, then startsWith, then contains — on normalised text */
      for (i = 0; i < options.length; i++) {
        text = normalise(options[i] && options[i].text);
        if (text === wanted) return options[i].text;
      }
      for (i = 0; i < options.length; i++) {
        text = normalise(options[i] && options[i].text);
        if (text.indexOf(wanted) === 0) return options[i].text;
      }
      for (i = 0; i < options.length; i++) {
        text = normalise(options[i] && options[i].text);
        if (text.indexOf(wanted) !== -1) return options[i].text;
      }

      /* Nothing matched. For a decline-to-answer default, try the
       * options that mean the same thing before giving up. */
      if (/prefer not|do not wish|decline/.test(wanted)) {
        for (i = 0; i < options.length; i++) {
          text = normalise(options[i] && options[i].text);
          if (/prefer not|do not wish|decline|not (to )?(say|answer|disclose)|unspecified/.test(text)) {
            return options[i].text;
          }
        }
      }
      return null; /* let the AI try rather than pick a wrong option */
    }

    return isBool ? (value ? 'Yes' : 'No') : s(value);
  }

  /* -------------------------------------------------------------------
   * PUBLIC API
   * ---------------------------------------------------------------- */

  /**
   * AF.screening.answer(field, profile)
   *   -> { key, value, confidence, screeningId, review, why }  or null
   *
   * Shaped like a match.js result so content.js can slot it into the
   * existing pipeline without special-casing.
   */
  function answer(field, profile) {
    try {
      var hay = haystackFor(field);
      if (!hay) return null;

      /* Never answer a free-text essay from this file. Those are the
       * AI's job — a canned 'Yes' in a "why do you want to work here"
       * box is worse than leaving it empty. */
      if (/\bwhy\b|\bdescribe\b|\btell us\b|\bexplain\b|\bmotivat/.test(hay) && s(field.kind) === 'textarea') {
        return null;
      }

      var i;
      for (i = 0; i < RULES.length; i++) {
        var rule = RULES[i];
        if (!ruleMatches(rule, hay)) continue;

        var raw = typeof rule.answer === 'function' ? rule.answer(profile || {}) : rule.answer;
        if (raw === undefined || raw === null || raw === '') return null;

        var value = coerceForField(field, raw);
        if (value === null || value === '') return null;

        return {
          key: 'screening:' + rule.id,
          value: value,
          confidence: SCREENING_CONFIDENCE,
          screeningId: rule.id,
          review: rule.review === true,
          why: rule.why || '',
        };
      }
      return null;
    } catch (err) {
      if (globalThis.console) console.warn('[AF.screening] failed:', err);
      return null;
    }
  }

  /** Debug helper: which rule would fire for this question string? */
  function explain(text) {
    var hay = normalise(text);
    var out = [];
    var i;
    for (i = 0; i < RULES.length; i++) {
      if (ruleMatches(RULES[i], hay)) out.push(RULES[i].id);
    }
    return { normalised: hay, matched: out, firstWins: out[0] || null };
  }

  AF.screening = {
    answer: answer,
    explain: explain,
    RULES: RULES,
    CONFIDENCE: SCREENING_CONFIDENCE,
  };
})();
