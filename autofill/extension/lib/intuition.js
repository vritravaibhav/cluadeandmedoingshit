/* =====================================================================
 * intuition.js — the answer of last resort. Never returns blank.
 *
 * WHY THIS FILE EXISTS
 *
 * The chain is knowledge -> match -> screening -> AI. When the AI step
 * fails — the bridge is down, the CLI exits non-zero, the daily quota is
 * gone — content.js used to mark every remaining field "skipped" and
 * leave it empty, and the popup said "AI step skipped: The AI bridge
 * returned 502". A form with thirty empty boxes is the worst possible
 * outcome: worse than a wrong guess, because a wrong guess takes two
 * seconds to correct and a blank takes reading, thinking and typing.
 *
 * So this file answers EVERYTHING the other layers left alone, using
 * ordinary judgement about what a working software engineer would put.
 * It runs with no network and no model.
 *
 * ORDER OF PRECEDENCE (see content.js)
 *   1. knowledge.js  — an answer HE typed himself. Always wins.
 *   2. match.js      — a real value from the profile.
 *   3. screening.js  — the standard answer to a standard question.
 *   4. AI            — anything genuinely novel.
 *   5. intuition.js  — THIS FILE. Only reached when 1-4 all declined.
 *
 * Everything here is tagged review:true so it is outlined amber and
 * listed in the popup afterwards. And because knowledge.js sits at the
 * top of the chain, any answer here that he corrects ONCE is remembered
 * and never guessed again — which is the intended way to fix a guess
 * that keeps showing up.
 *
 * THE ONE HARD LIMIT
 *
 * Never invent a verifiable fact — an employer, a title, a degree, a
 * licence or document number, a date, a reference. Those are checkable
 * and a wrong one is a lie on a job application. For those this file
 * returns null and the field stays on the ask list, which is the honest
 * outcome. Salary is treated the same way: an invented low number costs
 * real money, so it is left for him.
 * ===================================================================== */

var AF = (globalThis.AF = globalThis.AF || {});

(function () {
  'use strict';

  /* Below screening (0.7) and far below a profile match: this is the floor
   * of the whole system and must never outrank anything that actually knows. */
  var INTUITION_CONFIDENCE = 0.3;

  function s(v) {
    return v === null || v === undefined ? '' : String(v);
  }

  function norm(text) {
    return s(text)
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .replace(/[_\-.]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* Everything visible about the field, as one lowercase haystack. */
  function haystack(field) {
    return norm([field && field.label, field && field.context,
      field && field.placeholder, field && field.name].join(' '));
  }

  function has(hay, re) {
    return re.test(hay);
  }

  /* Read a profile value by trying several key spellings. */
  function pick(profile, keys) {
    var i;
    for (i = 0; i < keys.length; i++) {
      var v = profile ? profile[keys[i]] : null;
      if (v !== null && v !== undefined && String(v).trim() !== '') {
        return String(v).trim();
      }
    }
    return '';
  }

  /* ------------------------------------------------------------------
   * Option-list helpers, for <select> and radio groups.
   * The value written MUST be one of the real options, so every branch
   * below chooses from the list rather than inventing text.
   * ---------------------------------------------------------------- */

  function optionTexts(field) {
    var out = [];
    var opts = (field && field.options) || [];
    var i;
    for (i = 0; i < opts.length; i++) {
      var o = opts[i];
      var t = (o && (o.text || o.value)) || '';
      if (s(t).trim() !== '') out.push(String(t));
    }
    return out;
  }

  /* A leading "Select...", "-- choose --", "None" is a prompt, not an answer. */
  function isPlaceholderOption(text) {
    var t = norm(text);
    return t === '' || t.length < 2 ||
      /^(please\s+)?(select|choose|pick)\b/.test(t) ||
      /^-+$/.test(t) ||
      /^(none|n\/a|na)$/.test(t);
  }

  /** First option whose text matches `re`, or '' when there is none. */
  function optionMatching(field, re) {
    var texts = optionTexts(field);
    var i;
    for (i = 0; i < texts.length; i++) {
      if (re.test(norm(texts[i]))) return texts[i];
    }
    return '';
  }

  /**
   * Pick the option whose numeric range contains `n`.
   * Understands "0-1", "2 to 4", "5+", "More than 10", "Less than 2".
   * Returns '' when the options are not numeric ranges at all.
   */
  function optionForNumber(field, n) {
    if (!isFinite(n)) return '';
    var texts = optionTexts(field);
    var fallback = '';
    var i;
    for (i = 0; i < texts.length; i++) {
      /* NOT norm(): it strips hyphens, so "2-4" arrives as "2 4" and the range
       * regex below stops matching — which silently handed a 2.4-year
       * candidate the "0-1" bucket. Lowercase and collapse spaces only. */
      var t = String(texts[i]).toLowerCase().replace(/\s+/g, ' ').trim();
      if (isPlaceholderOption(t)) continue;

      var range = t.match(/(\d+)\s*(?:-|–|to)\s*(\d+)/);
      if (range && n >= Number(range[1]) && n <= Number(range[2])) return texts[i];

      var plus = t.match(/(\d+)\s*\+/) || t.match(/(?:more than|over|at least|above)\s*(\d+)/);
      if (plus && n >= Number(plus[1])) fallback = fallback || texts[i];

      var under = t.match(/(?:less than|under|below|fewer than)\s*(\d+)/);
      if (under && n < Number(under[1])) return texts[i];

      var exact = t.match(/^(\d+)$/);
      if (exact && Number(exact[1]) === Math.round(n)) return texts[i];
    }
    return fallback;
  }

  function firstRealOption(field) {
    var texts = optionTexts(field);
    var i;
    for (i = 0; i < texts.length; i++) {
      if (!isPlaceholderOption(texts[i])) return texts[i];
    }
    return '';
  }

  var YES_RE = /^(yes|y|true|i (do|am|have|will|can)|agree|accept|confirm)\b/;
  var NO_RE = /^(no|n|false|i (do not|don't|am not|have not|haven't)|disagree|decline)\b/;
  var DECLINE_RE = /(prefer not|decline|do not wish|dont wish|not to (say|answer|disclose)|choose not)/;

  /* ------------------------------------------------------------------
   * Question polarity: for a yes/no question, which way does an ordinary
   * honest applicant answer? These mirror screening.js but are broader,
   * because this file is reached only when screening.js already declined.
   * ---------------------------------------------------------------- */

  /* Things where the common-case honest answer is NO.
   *
   * Sponsorship is first for a reason: it is the single most damaging wrong
   * guess on this list. Answering "Yes, I need sponsorship" to a domestic role
   * filters the application out before a human reads it, and he is an Indian
   * citizen applying to Indian roles. screening.js answers this from the
   * profile when it can; this is only the floor beneath it, and it is amber. */
  var NEGATIVE = [
    /\b(require|need|will you need)\b.{0,24}\bsponsorship\b/,
    /\bsponsorship\b.{0,24}\b(required|needed)\b/,
    /\bvisa sponsorship\b/, /\bh1\s?b\b/,
    /\b(convicted|felony|criminal|offence|offense|misdemeanou?r)\b/,
    /\b(terminated|dismissed|fired)\b.{0,25}\b(cause|misconduct)\b/,
    /\bnon[\s-]?compete\b/, /\brestrictive covenant\b/,
    /\bdisciplinary (action|proceeding)\b/,
    /\b(debarred|disqualified|struck off|banned)\b/,
    /\bpending (litigation|investigation)\b/,
    /\brelated to\b.{0,30}\bemployee\b/,
    /\bapplied\b.{0,20}\bbefore\b/,
    /\bcurrently (studying|enrolled)\b/
  ];

  /* Things where the common-case honest answer is YES. */
  var POSITIVE = [
    /\b(authoris|authoriz)ed to work\b/, /\blegally (able|entitled) to work\b/,
    /\beligible to work\b/, /\bright to work\b/,
    /\b18 (years )?(or older|and above)\b/, /\bat least 18\b/,
    /\bbackground (check|screening|verification)\b/,
    /\bdrug (test|screen)/,
    /\b(agree|consent|accept)\b.{0,40}\b(terms|privacy|policy|processing|storage|conditions)\b/,
    /\bwilling to (travel|relocate|learn|work)\b/,
    /\bable to (start|join|commit|attend)\b/,
    /\bcomfortable (with|working)\b/,
    /\b(own|have) (a )?(laptop|computer|internet)\b/,
    /\breferences?\b.{0,20}\b(available|request)\b/,
    /\bread and understood\b/,
    /\bcertify\b.{0,30}\b(true|accurate)\b/,
    /\bfull[\s-]?time\b/, /\bnotice period\b.{0,20}\bserve\b/
  ];

  function polarity(hay) {
    var i;
    for (i = 0; i < NEGATIVE.length; i++) if (has(hay, NEGATIVE[i])) return 'no';
    for (i = 0; i < POSITIVE.length; i++) if (has(hay, POSITIVE[i])) return 'yes';
    return '';
  }

  /* Self-identification questions must never be invented — decline is the
   * only respectful default, and it is also what most applicants pick. */
  function isSelfId(hay) {
    return has(hay, /\b(gender|sex|race|ethnic|veteran|disabilit|lgbt|sexual orientation|marital|religion|caste|pronoun)\b/);
  }

  /* Fields whose answer is a checkable credential HE must supply. Guessing
   * one is worse than leaving it blank, so these are refused outright. */
  function isCredential(hay) {
    return has(hay, /\b(passport|aadhaar|aadhar|pan\b|ssn|social security|licence number|license number|visa number|national id|account number|ifsc|routing|tax id|employee id|registration number|certificate number)\b/);
  }

  /* Salary is refused for the same reason the AI prompt refuses it: an
   * accidental low anchor costs him real money. */
  function isSalary(hay) {
    return has(hay, /\b(salary|ctc|compensation|remuneration|pay|rate|wage|package)\b/);
  }

  /* ------------------------------------------------------------------
   * Free-text answers
   * ---------------------------------------------------------------- */

  function yearsOfExperience(profile) {
    var explicit = pick(profile, ['yearsOfExperience', 'totalExperience', 'experienceYears']);
    if (explicit !== '') return explicit.replace(/[^0-9.]/g, '') || explicit;
    var since = pick(profile, ['startedWorking', 'careerStart', 'firstJobDate']);
    var m = since.match(/(\d{4})-(\d{1,2})/);
    if (m) {
      var months = (new Date().getFullYear() - Number(m[1])) * 12 +
        (new Date().getMonth() + 1 - Number(m[2]));
      return String(Math.max(0, Math.round((months / 12) * 10) / 10));
    }
    return '2';
  }

  /* A short, honest, first-person paragraph. Deliberately generic: it is a
   * starting point he edits, not a finished cover letter. Anything specific
   * enough to be wrong (company name, product, team) is left out. */
  function paragraph(field, profile, hay) {
    var role = pick(profile, ['currentTitle', 'title']) || 'software engineer';
    var yrs = yearsOfExperience(profile);
    var stack = pick(profile, ['primaryStack', 'headlineSkills']) ||
      'Java, Spring Boot, Flutter and Firebase';

    if (has(hay, /\bwhy\b.{0,30}\b(work|join|interested|company|role|us|here|apply)\b/)) {
      return 'I have spent about ' + yrs + ' years building production systems with ' + stack +
        ', across backend services and the mobile clients that consume them. This role lines up ' +
        'with the work I already do day to day, and I am looking for a team where I can keep ' +
        'owning features end to end rather than a narrow slice of one.';
    }
    if (has(hay, /\b(strength|good at|best at|superpower)\b/)) {
      return 'Owning a feature end to end — the API, the data model and the client — and then ' +
        'staying with it long enough to fix what production actually shows.';
    }
    if (has(hay, /\b(weakness|improve|development area)\b/)) {
      return 'I tend to go deep on a problem before asking for input. I have been deliberately ' +
        'sharing work earlier so decisions get reviewed while they are still cheap to change.';
    }
    if (has(hay, /\b(describe|tell us about|summar)\b.{0,40}\b(experience|background|yourself)\b/)) {
      return 'I am a ' + role + ' with roughly ' + yrs + ' years of experience working in ' +
        stack + '. Most of my work has been building REST services and the mobile apps on top ' +
        'of them, including the release, monitoring and stability side once they are live.';
    }
    if (has(hay, /\b(project|built|portfolio|proud)\b/)) {
      return 'The work I would point to first is a production system I built and then owned in ' +
        'the wild — backend services plus the client — where most of what I learned came from ' +
        'the crash reports and latency numbers after launch rather than the original design.';
    }
    if (has(hay, /\b(notice period|when can you (start|join)|availability|available from)\b/)) {
      return pick(profile, ['noticePeriod']) || '30 days';
    }
    /* Genuinely unknown open question: answer the question that was asked as
     * plainly as possible rather than leaving a required box empty. */
    return 'Happy to go into detail on this — my background is about ' + yrs + ' years of ' +
      'hands-on work with ' + stack + ', and I am glad to expand on any part of it.';
  }

  function shortText(field, profile, hay) {
    if (has(hay, /\b(years?|experience)\b/) && has(hay, /\b(how many|number of|total|yrs?)\b/)) {
      return yearsOfExperience(profile);
    }
    if (has(hay, /\bnotice period\b/)) return pick(profile, ['noticePeriod']) || '30 days';
    if (has(hay, /\b(city|town|located|location|residence)\b/)) {
      return pick(profile, ['city', 'location', 'basedIn']) || 'India';
    }
    if (has(hay, /\bcountry\b/)) return pick(profile, ['country']) || 'India';
    if (has(hay, /\blinked\s?in\b/)) return pick(profile, ['linkedin', 'linkedIn']);
    if (has(hay, /\bgithub\b/)) return pick(profile, ['github']);
    if (has(hay, /\b(portfolio|website|personal site)\b/)) return pick(profile, ['portfolio', 'website']);
    if (has(hay, /\b(how did you hear|source|referr)\b/)) return 'Company website';
    if (has(hay, /\b(current|present)\b.{0,15}\b(company|employer)\b/)) {
      return pick(profile, ['currentCompany', 'company']);
    }
    if (has(hay, /\b(current|present|desired)\b.{0,15}\b(title|role|designation)\b/)) {
      return pick(profile, ['currentTitle', 'title']);
    }
    return '';
  }

  /* ------------------------------------------------------------------
   * The entry point
   * ---------------------------------------------------------------- */

  /**
   * Produce an answer for a field nothing else could answer.
   *
   * @param {Object} field    a scraped field ({kind, label, context, options, ...})
   * @param {Object} profile  the resume profile
   * @returns {Object|null}   {value, confidence, review, why} or null when the
   *                          field genuinely must not be guessed
   */
  function answer(field, profile) {
    if (!field) return null;
    var kind = s(field.kind);
    var hay = haystack(field);

    /* Never touched: an upload is his file to attach. */
    if (kind === 'file') return null;

    /* Refuse the two categories where a guess is actively harmful. */
    if (isCredential(hay)) {
      return null;
    }
    if (isSalary(hay) && pick(profile, ['expectedCtc', 'expectedSalary']) === '') {
      return null;
    }

    var why = 'Best guess — no profile value and the AI did not answer. Check it.';

    if (kind === 'checkbox') {
      /* Marketing opt-ins default off; everything else on a job form is a
       * consent or confirmation the applicant does tick. */
      if (has(hay, /\b(newsletter|marketing|promotional|subscribe|updates about)\b/)) {
        return { value: false, confidence: INTUITION_CONFIDENCE, review: true, why: why };
      }
      return { value: true, confidence: INTUITION_CONFIDENCE, review: true, why: why };
    }

    if (kind === 'select' || kind === 'radio') {
      var chosen = '';

      if (isSelfId(hay)) {
        chosen = optionMatching(field, DECLINE_RE);
      }
      if (chosen === '') {
        var pol = polarity(hay);
        if (pol === 'no') chosen = optionMatching(field, NO_RE);
        else if (pol === 'yes') chosen = optionMatching(field, YES_RE);
      }
      /* A bare yes/no list with no polarity signal: Yes is the answer that
       * keeps an application moving, and he reviews it anyway. */
      if (chosen === '') {
        var yes = optionMatching(field, YES_RE);
        var no = optionMatching(field, NO_RE);
        if (yes !== '' && no !== '') chosen = yes;
      }
      /* Options like "0-1", "2-4", "5+" are a numeric range question. Picking
       * the first real option got "0-1" for someone with 2.4 years, which is
       * both wrong and the kind of wrong that reads as sloppy. Match the range
       * that actually contains the number instead. */
      if (chosen === '' && has(hay, /\b(year|experience|exp\b)/)) {
        chosen = optionForNumber(field, Number(yearsOfExperience(profile)));
      }
      if (chosen === '') chosen = firstRealOption(field);
      if (chosen === '') return null; // an empty option list is unanswerable
      return { value: chosen, confidence: INTUITION_CONFIDENCE, review: true, why: why };
    }

    if (kind === 'textarea' || kind === 'contenteditable') {
      return { value: paragraph(field, profile, hay), confidence: INTUITION_CONFIDENCE, review: true, why: why };
    }

    /* text, number, tel, url, date and friends */
    var short = shortText(field, profile, hay);
    if (short !== '') {
      return { value: short, confidence: INTUITION_CONFIDENCE, review: true, why: why };
    }

    /* A date we cannot derive is a verifiable fact — do not invent one. */
    if (kind === 'date' || has(hay, /\b(date of birth|dob|joining date|graduation)\b/)) {
      return null;
    }

    /* A number box with no other signal: years of experience is by far the
     * most common numeric question on an application form. */
    if (kind === 'number' || has(hay, /\b(how many|number of|count)\b/)) {
      return { value: yearsOfExperience(profile), confidence: INTUITION_CONFIDENCE, review: true, why: why };
    }

    /* Last resort for a required single-line box: a short sentence beats a
     * blank, and he can retype it in seconds. */
    if (field.required === true) {
      return { value: paragraph(field, profile, hay), confidence: INTUITION_CONFIDENCE, review: true, why: why };
    }

    return null;
  }

  AF.intuition = {
    answer: answer,
    CONFIDENCE: INTUITION_CONFIDENCE
  };
})();
