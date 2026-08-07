/* =====================================================================
 * fill.js  —  the value setter.
 *
 * This is the single most fragile module in the extension, so it is the
 * most heavily commented one. Read this header before changing anything.
 *
 * WHY IS SETTING A VALUE HARD?
 * ----------------------------
 * In a plain HTML page you would write:
 *
 *     input.value = "Nguyen Van A";
 *
 * ...and you would be done. Greenhouse, Lever, Ashby and Workday are all
 * built with React (or a React-like renderer). React does NOT read the DOM
 * when you submit a form. React keeps its own copy of every input's value
 * inside its component state, and it only updates that copy when it hears
 * a synthetic 'input' / 'change' event that it believes represents a real
 * user edit.
 *
 * Think of it like a Spring Boot @Entity that is managed by a JPA
 * persistence context. If you go behind Hibernate's back and run raw SQL
 * with a JDBC connection, the entity in the persistence context still holds
 * the OLD value, and the next flush() writes the old value back over yours.
 * React's virtual DOM is that persistence context. `input.value = x` is
 * the raw JDBC write. We need the equivalent of going through the managed
 * entity so the framework observes the change.
 *
 * There are two obstacles, and we defeat both:
 *
 *  OBSTACLE 1 — React overrides the `value` property on the element itself.
 *    React (in some versions) and many component libraries define their own
 *    `value` property directly on the DOM node instance, shadowing the one
 *    inherited from HTMLInputElement.prototype. Assigning to it hits their
 *    setter, not the browser's, and the browser never records a new value.
 *    FIX: reach into HTMLInputElement.prototype, pull out the *native*
 *    setter function with Object.getOwnPropertyDescriptor(...).set, and
 *    invoke it with our element as `this` (via .call). That writes the real
 *    underlying value the way the browser itself would.
 *    Java analogy: calling super.setValue() explicitly to skip an override.
 *
 *  OBSTACLE 2 — React's "value tracker".
 *    React 15/16+ attaches a hidden object to each input node called
 *    `_valueTracker`. Its job is de-duplication: when an 'input' event
 *    fires, React asks the tracker "what was the last value you saw?".
 *    If the tracker's remembered value equals the node's current value,
 *    React decides "nothing actually changed" and DROPS the event.
 *    Because we set the value BEFORE dispatching the event, the tracker
 *    would already have been updated by our native setter — so React would
 *    swallow our event and the form stays empty from React's point of view.
 *    FIX: before writing, force the tracker to forget by calling
 *    el._valueTracker.setValue(''). Now the tracker's remembered value ('')
 *    differs from the new value, React sees a genuine change, and the state
 *    updates. `_valueTracker` is a private React internal, so every access
 *    is guarded — if a future React removes it, we simply skip that step.
 *
 * The rest of the file (select / radio / checkbox / contenteditable) is
 * about matching human-readable option text to the profile value without
 * ever guessing wrong, plus a snapshot/undo facility and visual highlights.
 * ===================================================================== */

/* The one and only global namespace. Created defensively: whichever script
 * loads first creates the object, the rest reuse it. No ES modules here —
 * the manifest loads these as plain classic scripts, in order. */
var AF = (globalThis.AF = globalThis.AF || {});

(function () {
  'use strict';

  /* -------------------------------------------------------------------
   * Module-level state.
   *
   * _snapshot holds the "undo buffer": for every field we touched we
   * remember what was in it beforehand. It is null when there is nothing
   * to undo, and restore() sets it back to null once it has been used.
   *
   * WHY AN ARRAY AND NOT A MAP KEYED BY field.index
   *   field.index is only stable WITHIN one scrape. The content script
   *   re-scrapes the page on every run, so index 5 of the second scrape is
   *   not necessarily the same control as index 5 of the first. Keying by
   *   index would therefore mix two runs' records together. We key on the
   *   ELEMENT itself instead (see snapshotHasElement), which stays the same
   *   object for as long as the page does not re-render that control.
   *
   * Record shapes, one per kind:
   *   { field, el, kind: 'text',     value: 'old text' }
   *   { field, el, kind: 'select',   value: 'US', selectedIndex: 4, text: 'United States' }
   *   { field, el, kind: 'checkbox', checked: false, value: 'on' }
   *   { field, el, kind: 'radio',    members: [<input>, ...], checkedMember: <input>|null }
   * ----------------------------------------------------------------- */
  var _snapshot = null;

  /* What the last AF.restore() managed to do. Purely informational: the
   * content script reads it through AF.lastRestoreReport() so the popup can
   * admit "3 fields could not be put back" instead of claiming a perfect
   * undo. See AF.restore(). */
  var _lastRestoreReport = { restored: 0, failed: 0, failedLabels: [] };

  /* Colours used by highlight(). Kept in one place so the popup and the
   * content script can agree on what each colour means. */
  var HIGHLIGHT_COLOURS = {
    ok: '#22c55e', // green  — filled straight from the local profile
    ai: '#3b82f6', // blue   — filled from an AI suggestion
    skip: '#f59e0b' // amber — deliberately left alone / could not match
  };

  /* How long a highlight stays on screen before the original inline style
   * is put back, in milliseconds. */
  var HIGHLIGHT_MS = 2500;

  /* Delay used by setValueAsync between focusing and typing. Some widgets
   * (Workday's custom comboboxes especially) only attach their keyboard /
   * input handlers once the element receives focus, so writing instantly
   * after focus can land before anybody is listening. */
  var FOCUS_SETTLE_MS = 60;

  /* ===================================================================
   * SECTION 1 — small string helpers used by the option-matching cascade.
   * =================================================================== */

  /**
   * Turn anything into a trimmed string. Null and undefined become ''.
   * Booleans become 'true' / 'false'. Numbers become their digits.
   */
  function asText(anything) {
    if (anything === null || anything === undefined) {
      return '';
    }
    return String(anything).trim();
  }

  /**
   * Lower-cased, trimmed. Used for the case-insensitive comparisons.
   */
  function lower(anything) {
    return asText(anything).toLowerCase();
  }

  /**
   * Aggressive normalisation for the last resort comparison:
   *   - lower case
   *   - every character that is not a letter, digit or space becomes a space
   *     (this kills punctuation such as "-", "/", "(", ")", ".", ",")
   *   - runs of whitespace collapse into a single space
   *   - trimmed
   *
   * So "U.S. Citizen / Green-Card" and "us citizen green card" both become
   * "us citizen green card" and therefore compare equal.
   */
  function normalise(anything) {
    var text = lower(anything);
    var withoutPunctuation = text.replace(/[^a-z0-9 ]+/g, ' ');
    var collapsed = withoutPunctuation.replace(/\s+/g, ' ');
    return collapsed.trim();
  }

  /**
   * Log a failure without ever throwing. Every catch block routes here so
   * that one broken field can never abort a whole run.
   */
  function logFailure(what, field, error) {
    var label = '(unlabelled field)';
    if (field) {
      // Prefer the resolved visible label, then any other identifying text.
      label =
        asText(field.label) ||
        asText(field.ariaLabel) ||
        asText(field.name) ||
        asText(field.id) ||
        asText(field.placeholder) ||
        '(unlabelled field)';
    }
    // console.warn, not console.error: this is expected on exotic forms.
    console.warn('[autofill] ' + what + ' failed for field: ' + label, error);
  }

  /* ===================================================================
   * SECTION 2 — the native setter trick.
   * =================================================================== */

  /**
   * Look up the browser's own `value` setter on the right prototype.
   *
   * We cache nothing here on purpose: the lookup is cheap, and caching a
   * descriptor across frames (content scripts run with all_frames:true)
   * would risk using one document's prototype on another document's node.
   *
   * Returns the setter Function, or null when the descriptor is missing
   * (very old browsers, or an element type we do not know about).
   */
  function getNativeValueSetter(el) {
    try {
      var prototypeToUse = null;

      // Pick the prototype that actually declares `value` for this node.
      // We check the tag name rather than instanceof, because a node from
      // another frame is not an instanceof THIS window's HTMLInputElement.
      var tag = (el.tagName || '').toUpperCase();

      if (tag === 'TEXTAREA') {
        prototypeToUse = window.HTMLTextAreaElement.prototype;
      } else if (tag === 'SELECT') {
        prototypeToUse = window.HTMLSelectElement.prototype;
      } else {
        // INPUT and anything else that behaves like one.
        prototypeToUse = window.HTMLInputElement.prototype;
      }

      var descriptor = Object.getOwnPropertyDescriptor(prototypeToUse, 'value');
      if (descriptor && typeof descriptor.set === 'function') {
        return descriptor.set;
      }
      return null;
    } catch (error) {
      // Cross-origin prototype access, exotic environment, etc.
      return null;
    }
  }

  /**
   * Tell React's hidden value tracker to forget what it last saw, so that
   * the 'input' event we dispatch afterwards is treated as a real change
   * and not de-duplicated away. See OBSTACLE 2 in the file header.
   *
   * Everything is guarded because _valueTracker is a private internal.
   */
  function resetReactValueTracker(el) {
    try {
      var tracker = el._valueTracker;
      if (tracker && typeof tracker.setValue === 'function') {
        tracker.setValue('');
      }
    } catch (error) {
      // Not React, or React changed its internals. Harmless — carry on.
    }
  }

  /**
   * Write `value` into a text-like element (input / textarea) the way the
   * browser would, defeating any framework override.
   *
   * Order matters:
   *   1. reset the React tracker (BEFORE the write)
   *   2. write via the native setter
   *   3. fall back to plain assignment only if there is no native setter
   */
  function writeNativeValue(el, value) {
    var text = value === null || value === undefined ? '' : String(value);

    resetReactValueTracker(el);

    var nativeSetter = getNativeValueSetter(el);
    if (nativeSetter) {
      // .call(el, text) makes `el` the receiver — exactly as if the browser
      // itself had performed `el.value = text`.
      nativeSetter.call(el, text);
      return true;
    }

    // Last resort. On a React form this may not register, but on a plain
    // HTML form it works fine, and doing nothing would be worse.
    el.value = text;
    return true;
  }

  /* ===================================================================
   * SECTION 3 — event dispatch.
   * =================================================================== */

  /**
   * Build and dispatch an 'input' event. InputEvent is the correct type and
   * some libraries check `event instanceof InputEvent`, but it is not
   * constructible everywhere, so we fall back to a generic Event.
   */
  function dispatchInputEvent(el) {
    var event = null;
    try {
      // InputEvent carries inputType/data, which is what a real keystroke
      // would produce. 'insertReplacementText' is the honest description of
      // what we just did: we replaced the whole content programmatically.
      event = new InputEvent('input', {
        bubbles: true,
        cancelable: false,
        inputType: 'insertReplacementText'
      });
    } catch (error) {
      event = null;
    }

    if (!event) {
      event = new Event('input', { bubbles: true, cancelable: false });
    }

    el.dispatchEvent(event);
  }

  /**
   * Dispatch a bubbling 'change' event. React listens to 'input' for text
   * fields but 'change' for selects and checkboxes; Angular and plain
   * jQuery validators often listen to 'change' for everything. We always
   * send both so we do not have to know which framework we are on.
   */
  function dispatchChangeEvent(el) {
    el.dispatchEvent(new Event('change', { bubbles: true, cancelable: false }));
  }

  /**
   * Several ATSs (Workday in particular) only run their per-field
   * validation on blur — the "this field is required" message never clears
   * until the field has been focused and then blurred. So after writing we
   * explicitly focus, then blur, and fire the matching events.
   *
   * 'focus' and 'blur' themselves do not bubble; their bubbling twins are
   * 'focusin' and 'focusout'. We dispatch the bubbling variants too, since
   * React attaches its listeners at the root and relies on bubbling.
   */
  function focusElement(el) {
    try {
      if (typeof el.focus === 'function') {
        // preventScroll keeps the page from jumping around while we fill
        // dozens of fields; we do our own smooth scroll in scrollToFirst.
        el.focus({ preventScroll: true });
      }
      el.dispatchEvent(new Event('focus', { bubbles: false }));
      el.dispatchEvent(new Event('focusin', { bubbles: true }));
    } catch (error) {
      // Focusing can throw on detached or disabled nodes. Not fatal.
    }
  }

  function blurElement(el) {
    try {
      el.dispatchEvent(new Event('blur', { bubbles: false }));
      el.dispatchEvent(new Event('focusout', { bubbles: true }));
      if (typeof el.blur === 'function') {
        el.blur();
      }
    } catch (error) {
      // Not fatal.
    }
  }

  /* ===================================================================
   * SECTION 4 — option matching cascade (used by select and radio).
   * =================================================================== */

  /**
   * Given a list of candidate option descriptors and a wanted string, pick
   * the right one. We deliberately try the strictest rules first and only
   * loosen them step by step. If nothing matches we return -1 so the caller
   * can report failure — we NEVER fall back to "just pick the first one",
   * because putting the wrong answer on a work-authorisation or veteran
   * status question is far worse than leaving it blank.
   *
   * `candidates` is an array of { text: String, value: String }.
   * Returns the index into `candidates`, or -1.
   *
   * Cascade:
   *   1. exact text,   case-insensitive
   *   2. exact value,  case-insensitive
   *   3. trimmed "contains" either direction, case-insensitive
   *   4. normalised equality (punctuation stripped, whitespace collapsed)
   *   5. normalised "contains" either direction
   */
  function findMatchingOptionIndex(candidates, wanted) {
    var wantedRaw = lower(wanted);
    var wantedNorm = normalise(wanted);
    var i;

    if (!candidates || candidates.length === 0) {
      return -1;
    }
    if (wantedRaw === '') {
      return -1;
    }

    // --- 1. exact text -------------------------------------------------
    for (i = 0; i < candidates.length; i++) {
      if (lower(candidates[i].text) === wantedRaw) {
        return i;
      }
    }

    // --- 2. exact value ------------------------------------------------
    for (i = 0; i < candidates.length; i++) {
      if (lower(candidates[i].value) === wantedRaw) {
        return i;
      }
    }

    // --- 3. contains, either direction ---------------------------------
    // "Yes" wanted vs option "Yes, I am authorised" -> match.
    // "United States of America" wanted vs option "United States" -> match.
    for (i = 0; i < candidates.length; i++) {
      var text3 = lower(candidates[i].text);
      var value3 = lower(candidates[i].value);

      if (text3 !== '' && (text3.indexOf(wantedRaw) !== -1 || wantedRaw.indexOf(text3) !== -1)) {
        return i;
      }
      if (value3 !== '' && (value3.indexOf(wantedRaw) !== -1 || wantedRaw.indexOf(value3) !== -1)) {
        return i;
      }
    }

    // --- 4. normalised equality ----------------------------------------
    if (wantedNorm !== '') {
      for (i = 0; i < candidates.length; i++) {
        if (normalise(candidates[i].text) === wantedNorm) {
          return i;
        }
        if (normalise(candidates[i].value) === wantedNorm) {
          return i;
        }
      }

      // --- 5. normalised contains --------------------------------------
      for (i = 0; i < candidates.length; i++) {
        var text5 = normalise(candidates[i].text);
        var value5 = normalise(candidates[i].value);

        if (text5 !== '' && (text5.indexOf(wantedNorm) !== -1 || wantedNorm.indexOf(text5) !== -1)) {
          return i;
        }
        if (value5 !== '' && (value5.indexOf(wantedNorm) !== -1 || wantedNorm.indexOf(value5) !== -1)) {
          return i;
        }
      }
    }

    return -1;
  }

  /**
   * Placeholder options such as "-- Select --", "Please choose", "" must
   * never be chosen. We strip them out before matching.
   */
  function isPlaceholderOption(option) {
    var text = normalise(option.text);
    var value = asText(option.value);

    if (text === '' && value === '') {
      return true;
    }
    if (text === 'select' || text === 'select one' || text === 'select an option') {
      return true;
    }
    if (text === 'please select' || text === 'please choose' || text === 'choose') {
      return true;
    }
    if (text === 'none' && value === '') {
      return true;
    }
    return false;
  }

  /* ===================================================================
   * SECTION 5 — per-kind setters.
   * =================================================================== */

  /**
   * TEXT / TEXTAREA / anything with a plain value.
   *
   * The full sequence, in the exact order the file header describes:
   *   focus -> reset tracker -> native write -> 'input' -> 'change' -> blur
   */
  function setTextValue(el, value) {
    focusElement(el);

    writeNativeValue(el, value);

    dispatchInputEvent(el);
    dispatchChangeEvent(el);

    blurElement(el);

    // Report success only if the DOM really holds what we asked for.
    // A readonly or disabled input silently ignores the write.
    var wanted = value === null || value === undefined ? '' : String(value);
    return asText(el.value) === asText(wanted);
  }

  /**
   * SELECT (single or multiple — we only ever set one option).
   *
   * We build the candidate list from the live <option> nodes rather than
   * from field.options, because the page may have re-rendered its options
   * since the scrape (dependent dropdowns do this constantly).
   *
   * Returns false when no option matched. Never guesses.
   */
  function setSelectValue(el, value, field) {
    var liveOptions = el.options ? Array.prototype.slice.call(el.options) : [];

    // Build [{text, value, domIndex}] and drop the placeholders.
    var candidates = [];
    var i;
    for (i = 0; i < liveOptions.length; i++) {
      var option = liveOptions[i];
      var descriptor = {
        text: asText(option.textContent),
        value: asText(option.value),
        domIndex: i
      };
      if (!isPlaceholderOption(descriptor)) {
        candidates.push(descriptor);
      }
    }

    var hit = findMatchingOptionIndex(candidates, value);
    if (hit === -1) {
      // Nothing matched. Leave the select exactly as we found it.
      return false;
    }

    focusElement(el);

    var targetDomIndex = candidates[hit].domIndex;

    // Setting selectedIndex is the reliable way to change a <select>. We
    // also push the value through the native setter so that any framework
    // wrapper watching `value` observes the same thing.
    el.selectedIndex = targetDomIndex;
    writeNativeValue(el, candidates[hit].value);

    dispatchInputEvent(el);
    dispatchChangeEvent(el);

    blurElement(el);

    // Verify. If the framework re-rendered and reverted us, say so.
    var applied = el.selectedIndex === targetDomIndex;
    if (!applied) {
      logFailure('select reverted after set', field, null);
    }
    return applied;
  }

  /**
   * RADIO.
   *
   * A radio "field" in our data contract is one member of a group, and
   * field.options lists the whole group's labels. To set it we must find
   * the sibling radio whose label matches and CLICK it.
   *
   * Why click() and not `.checked = true`?
   *   Setting .checked mutates the DOM but fires no events at all, so React
   *   never learns about it and the group stays unset in component state.
   *   click() runs the browser's full activation behaviour: it flips
   *   .checked, fires 'input' and 'change', and React's delegated listener
   *   at the document root picks them up exactly as with a human click.
   */
  function setRadioValue(el, value, field) {
    // Collect the whole group. Prefer the group name; fall back to the
    // single element we were handed.
    var groupMembers = collectRadioGroup(el, field);

    // Describe each radio by its visible label text so the cascade can work
    // on human words like "Yes" / "No" / "Prefer not to say".
    var candidates = [];
    var i;
    for (i = 0; i < groupMembers.length; i++) {
      candidates.push({
        text: readRadioLabelText(groupMembers[i]),
        value: asText(groupMembers[i].value),
        domIndex: i
      });
    }

    var hit = findMatchingOptionIndex(candidates, value);
    if (hit === -1) {
      return false;
    }

    var target = groupMembers[candidates[hit].domIndex];

    focusElement(target);
    target.click(); // full activation behaviour — see comment above
    blurElement(target);

    // Requirement: verify .checked afterwards and return the result.
    return target.checked === true;
  }

  /**
   * Every radio that belongs to the same question as `el`.
   *
   * IMPORTANT BACKGROUND: scrape.js emits ONE Field per radio GROUP, and that
   * field's `el` is only the FIRST radio of the group (see
   * buildRadioGroupField in lib/scrape.js). So any code that wants to know
   * "what is this question's answer?" must look at the whole group, never at
   * field.el alone. Both setRadioValue and AF.snapshot use this helper so the
   * two can never disagree about what the group is.
   *
   * @returns {Element[]} always at least one element (the one we were given)
   */
  function collectRadioGroup(el, field) {
    try {
      var groupName = asText(field && field.groupName) || asText(el.name);
      var groupMembers = [];

      if (groupName !== '') {
        // Search within the element's own root (handles shadow DOM / iframes
        // correctly, since getRootNode returns the document or shadow root).
        var root = el.getRootNode ? el.getRootNode() : document;
        var selector = 'input[type="radio"][name="' + cssEscape(groupName) + '"]';
        var found = root.querySelectorAll ? root.querySelectorAll(selector) : [];
        groupMembers = Array.prototype.slice.call(found);
      }

      if (groupMembers.length === 0) {
        groupMembers = [el];
      }
      return groupMembers;
    } catch (error) {
      // A hostile page or an exotic name attribute. One element is still a
      // usable (if incomplete) group.
      return [el];
    }
  }

  /**
   * Which member of the group currently has the dot in it, or null when the
   * question is unanswered.
   */
  function findCheckedRadio(members) {
    var i;
    for (i = 0; i < members.length; i++) {
      if (members[i] && members[i].checked === true) {
        return members[i];
      }
    }
    return null;
  }

  /**
   * Put a radio group back to "nothing selected".
   *
   * There is no click() that unchecks a radio — clicking the checked one just
   * leaves it checked — so this is the one place where we DO assign .checked
   * directly. Assigning alone would be invisible to React, so we use exactly
   * the same trick as everywhere else in this file: reset the value tracker
   * first, then dispatch bubbling 'input' and 'change' events, which React's
   * delegated listener at the document root picks up.
   *
   * @returns {Boolean} true when every member ended up unchecked
   */
  function clearRadioGroup(members) {
    var cleared = true;
    var i;

    for (i = 0; i < members.length; i++) {
      var member = members[i];
      try {
        if (!member || member.checked !== true) {
          continue; // already off, nothing to do
        }

        focusElement(member);
        resetReactValueTracker(member);
        member.checked = false;
        dispatchInputEvent(member);
        dispatchChangeEvent(member);
        blurElement(member);

        if (member.checked === true) {
          // A strictly controlled React group re-rendered its own state back
          // over ours. Report the failure honestly instead of pretending.
          cleared = false;
        }
      } catch (error) {
        cleared = false;
      }
    }
    return cleared;
  }

  /**
   * Best-effort visible label for a single radio input. We do not have
   * access to scrape.js's label resolver from here (it works on the whole
   * document), so this is a compact local version.
   */
  function readRadioLabelText(radioEl) {
    try {
      // 1. <label for="thatId">
      var id = asText(radioEl.id);
      if (id !== '') {
        var root = radioEl.getRootNode ? radioEl.getRootNode() : document;
        var forLabel = root.querySelector
          ? root.querySelector('label[for="' + cssEscape(id) + '"]')
          : null;
        if (forLabel) {
          return asText(forLabel.textContent);
        }
      }

      // 2. an ancestor <label> wrapping the input
      var wrapping = radioEl.closest ? radioEl.closest('label') : null;
      if (wrapping) {
        return asText(wrapping.textContent);
      }

      // 3. aria-label
      var aria = asText(radioEl.getAttribute && radioEl.getAttribute('aria-label'));
      if (aria !== '') {
        return aria;
      }

      // 4. the text right after the input (Lever does this)
      var sibling = radioEl.nextElementSibling;
      if (sibling) {
        return asText(sibling.textContent);
      }
    } catch (error) {
      // fall through
    }
    return '';
  }

  /**
   * CSS.escape is available in Chrome, but we guard it anyway and provide a
   * conservative manual fallback, because a stray quote in a name attribute
   * would otherwise break our selector string.
   */
  function cssEscape(text) {
    var raw = asText(text);
    try {
      if (window.CSS && typeof window.CSS.escape === 'function') {
        return window.CSS.escape(raw);
      }
    } catch (error) {
      // fall through
    }
    return raw.replace(/["\\\]]/g, '\\$&');
  }

  /**
   * CHECKBOX.
   *
   * The desired state is a boolean. We only click when the current state
   * differs — clicking an already-checked box would UNCHECK it, which is
   * the classic autofill bug where re-running the extension toggles every
   * consent box back off.
   *
   * We accept loose truthiness from the profile: true, 'true', 'yes', '1',
   * 'on' all mean checked.
   */
  function setCheckboxValue(el, value) {
    var desired = coerceToBoolean(value);
    var current = el.checked === true;

    if (desired === current) {
      // Already correct. Nothing to do, and that counts as success.
      return true;
    }

    focusElement(el);
    el.click(); // same reasoning as radio: click drives framework handlers
    blurElement(el);

    return el.checked === desired;
  }

  /**
   * Interpret a profile value as a boolean for checkboxes.
   */
  function coerceToBoolean(value) {
    if (value === true) {
      return true;
    }
    if (value === false) {
      return false;
    }
    var text = lower(value);
    if (text === 'true' || text === 'yes' || text === 'y' || text === '1' || text === 'on' || text === 'checked') {
      return true;
    }
    return false;
  }

  /**
   * CONTENTEDITABLE (rich-text cover letter boxes on Ashby, Upwork).
   *
   * These are not form controls, so there is no `value` and no native
   * setter to borrow. Setting textContent and firing a bubbling 'input' is
   * what every rich-text editor (Draft.js, ProseMirror, Quill) listens for.
   */
  function setContentEditableValue(el, value) {
    focusElement(el);

    el.textContent = value === null || value === undefined ? '' : String(value);

    dispatchInputEvent(el);
    dispatchChangeEvent(el);

    blurElement(el);

    return asText(el.textContent) === asText(value);
  }

  /* ===================================================================
   * SECTION 6 — PUBLIC API.
   * =================================================================== */

  /**
   * AF.setValue(el, value, field) -> Boolean
   *
   * Apply `value` to `el`, using the strategy appropriate to field.kind.
   * Returns true only when the value was genuinely applied.
   *
   * The whole body is wrapped in try/catch: one exotic field on one exotic
   * ATS must never abort a run of forty fields.
   */
  AF.setValue = function (el, value, field) {
    try {
      if (!el) {
        return false;
      }

      // Determine the kind. Prefer what the scraper told us; fall back to
      // sniffing the element, because callers (undo, AI bridge) may pass a
      // partial field object.
      var kind = asText(field && field.kind) || sniffKind(el);

      // Requirement 8: file inputs are untouchable. For security reasons a
      // page cannot set input.files programmatically anyway, and trying to
      // click one pops a native file dialog in the user's face.
      if (kind === 'file' || (el.type && lower(el.type) === 'file')) {
        return false;
      }

      // Disabled or readonly controls will silently ignore us; report
      // failure honestly rather than pretending we filled them.
      if (el.disabled === true || el.readOnly === true) {
        return false;
      }

      if (kind === 'select') {
        return setSelectValue(el, value, field);
      }
      if (kind === 'radio') {
        return setRadioValue(el, value, field);
      }
      if (kind === 'checkbox') {
        return setCheckboxValue(el, value);
      }
      if (kind === 'contenteditable') {
        return setContentEditableValue(el, value);
      }

      // 'text' and 'textarea' and everything else that carries a value.
      return setTextValue(el, value);
    } catch (error) {
      logFailure('setValue', field, error);
      return false;
    }
  };

  /**
   * Work out a field kind from the element alone, for callers that did not
   * supply a full Field object.
   */
  function sniffKind(el) {
    var tag = (el.tagName || '').toUpperCase();

    if (tag === 'SELECT') {
      return 'select';
    }
    if (tag === 'TEXTAREA') {
      return 'textarea';
    }
    if (tag === 'INPUT') {
      var type = lower(el.type);
      if (type === 'radio') {
        return 'radio';
      }
      if (type === 'checkbox') {
        return 'checkbox';
      }
      if (type === 'file') {
        return 'file';
      }
      return 'text';
    }
    if (el.isContentEditable === true) {
      return 'contenteditable';
    }
    return 'text';
  }

  /**
   * AF.setValueAsync(el, value, field) -> Promise<Boolean>
   *
   * Same as setValue, but focuses the element first, waits a short beat,
   * and only then writes. Some widgets — Workday's comboboxes, Upwork's
   * skill pickers — mount their input handler lazily when the control
   * receives focus. Writing instantly after focus can land before the
   * handler exists, and the keystroke is lost.
   *
   * Implemented with a bare Promise + setTimeout: no async libraries, and
   * no `async`/`await` syntax dependency in the classic-script build.
   * Java analogy: CompletableFuture with a delayed executor.
   */
  AF.setValueAsync = function (el, value, field) {
    return new Promise(function (resolve) {
      try {
        if (!el) {
          resolve(false);
          return;
        }

        // Focus now, so the widget's lazy handler has time to mount.
        focusElement(el);

        setTimeout(function () {
          // setValue focuses again — harmless, and it keeps the two paths
          // identical so there is only one place where the real work lives.
          var applied = AF.setValue(el, value, field);
          resolve(applied);
        }, FOCUS_SETTLE_MS);
      } catch (error) {
        logFailure('setValueAsync', field, error);
        resolve(false);
      }
    });
  };

  /**
   * Have we already recorded this element (or, for a radio, this element's
   * group) in the current undo buffer?
   *
   * A linear scan is fine: application forms have tens of fields, not
   * thousands, and this keeps the buffer a plain readable array.
   */
  function snapshotHasElement(el) {
    if (!_snapshot) {
      return false;
    }
    var i;
    for (i = 0; i < _snapshot.length; i++) {
      var record = _snapshot[i];
      if (record.el === el) {
        return true;
      }
      // A radio group is recorded once, under its first member, so any other
      // member of that group counts as "already recorded" too.
      if (record.members && record.members.indexOf(el) !== -1) {
        return true;
      }
    }
    return false;
  }

  /**
   * AF.snapshot(fields)
   *
   * Record the current state of every field so AF.restore() can put the
   * form back exactly as we found it. The buffer is kept in the module-level
   * `_snapshot` variable — the caller gets nothing it could corrupt, which
   * is why the contract calls it "an opaque token stored internally".
   *
   * THE BUFFER IS ADDITIVE, NEVER CLOBBERED.
   *   content.js calls this at the top of EVERY run. If a second run simply
   *   replaced the buffer, it would record the ALREADY AUTOFILLED state as
   *   the "before" state, and Undo would then faithfully put the autofilled
   *   values back — reporting success while changing nothing. So: an element
   *   that is already in the buffer keeps its FIRST, genuinely original
   *   record, and only elements we have never seen are added.
   *
   *   AF.restore() sets the buffer back to null, so the first fill after an
   *   undo starts from a clean sheet.
   */
  AF.snapshot = function (fields) {
    try {
      // Only start a fresh buffer when there is nothing left to undo.
      if (_snapshot === null) {
        _snapshot = [];
      }

      if (!fields || fields.length === 0) {
        return;
      }

      var i;
      for (i = 0; i < fields.length; i++) {
        var field = fields[i];
        if (!field || !field.el) {
          continue;
        }

        var el = field.el;
        var kind = asText(field.kind) || sniffKind(el);

        // File inputs are never touched, so never recorded.
        if (kind === 'file') {
          continue;
        }

        // Already recorded by an earlier run — keep the older, truer record.
        if (snapshotHasElement(el)) {
          continue;
        }

        var record = { field: field, el: el, kind: kind };

        if (kind === 'checkbox') {
          record.checked = el.checked === true;
          record.value = asText(el.value);
        } else if (kind === 'radio') {
          // One Field describes a WHOLE radio group and field.el is only its
          // first member, so recording el.checked would remember the wrong
          // thing whenever the user had picked any other option (and would
          // remember "false" for every unanswered question, which is exactly
          // the case Undo has to be able to reverse). Record the group.
          record.members = collectRadioGroup(el, field);
          record.checkedMember = findCheckedRadio(record.members);
        } else if (kind === 'select') {
          record.selectedIndex = el.selectedIndex;
          record.value = asText(el.value);
          // Remember the option's visible text too: it is what identifies the
          // option if the page re-renders its option list before the undo.
          record.text = '';
          if (el.options && el.options[el.selectedIndex]) {
            record.text = asText(el.options[el.selectedIndex].textContent);
          }
        } else if (kind === 'contenteditable') {
          record.value = asText(el.textContent);
        } else {
          record.value = el.value === undefined || el.value === null ? '' : String(el.value);
        }

        _snapshot.push(record);
      }
    } catch (error) {
      // Deliberately NOT clearing _snapshot here: whatever we already
      // recorded is still the user's only way back.
      logFailure('snapshot', null, error);
    }
  };

  /**
   * Put ONE radio group back the way it was.
   *
   * Two genuinely different cases, and the second one is the common one:
   *   a) some member was checked before the fill -> click that member again
   *      (clicking it automatically unchecks whichever one we selected).
   *   b) NOTHING was checked before the fill — the normal starting state of
   *      every EEO, veteran, disability and work-authorisation question —
   *      so the group has to be emptied again. See clearRadioGroup.
   *
   * @returns {Boolean} true when the group really is back to its old state
   */
  function restoreRadioGroup(record) {
    var members = (record.members && record.members.length > 0)
      ? record.members
      : [record.el];

    var original = record.checkedMember;

    // --- case (a): re-select the member that was checked before ----------
    if (original) {
      if (original.checked === true) {
        return true; // nothing changed it in the first place
      }
      try {
        focusElement(original);
        original.click(); // full activation behaviour, see setRadioValue
        blurElement(original);
      } catch (error) {
        return false;
      }
      return original.checked === true;
    }

    // --- case (b): the question was unanswered — empty it again ----------
    return clearRadioGroup(members);
  }

  /**
   * Put ONE <select> back the way it was.
   *
   * WHY THIS DOES NOT GO THROUGH AF.setValue
   *   The "before" state of an application dropdown is almost always its
   *   placeholder ("Select...", "-- Choose --"). setSelectValue deliberately
   *   removes placeholder options from its candidate list, because CHOOSING
   *   a placeholder as an answer is never right. Undo has the opposite
   *   intent: going back to the placeholder is exactly what we want. Routing
   *   undo through the answer-picking code therefore could never restore the
   *   most common case, so undo gets its own, simpler path: put the
   *   remembered option index back and announce it.
   *
   * @returns {Boolean} true when the select really is back to its old state
   */
  function restoreSelectValue(record) {
    var el = record.el;
    var index = record.selectedIndex;
    var optionCount = (el.options && typeof el.options.length === 'number') ? el.options.length : 0;

    // "Nothing was selected at all" is a valid state and is easy to put back.
    if (typeof index === 'number' && index < 0) {
      focusElement(el);
      resetReactValueTracker(el);
      el.selectedIndex = -1;
      dispatchInputEvent(el);
      dispatchChangeEvent(el);
      blurElement(el);
      return el.selectedIndex === -1;
    }

    if (typeof index === 'number' && index >= 0 && index < optionCount) {
      // Only trust the remembered POSITION when the option sitting there is
      // still the option we saw. Dependent dropdowns (country -> state) throw
      // their list away and rebuild it, and position 4 of the new list is a
      // completely different answer.
      var optionNow = el.options[index];
      var sameOption =
        asText(optionNow.value) === asText(record.value) ||
        asText(optionNow.textContent) === asText(record.text);

      if (sameOption) {
        focusElement(el);
        resetReactValueTracker(el);
        el.selectedIndex = index;
        dispatchInputEvent(el);
        dispatchChangeEvent(el);
        blurElement(el);
        return el.selectedIndex === index;
      }
    }

    // The option list changed under us. Fall back to matching by text, which
    // is the best we can do — it cannot bring a placeholder back, and it
    // honestly returns false when it fails.
    var wanted = record.text !== '' ? record.text : record.value;
    return AF.setValue(el, wanted, record.field);
  }

  /**
   * AF.restore() -> Boolean
   *
   * Undo. Text values are written back THROUGH AF.setValue, not by direct
   * assignment — otherwise the framework's own state would keep the
   * autofilled value and the visible "undo" would be a lie that reappears
   * on the next re-render. Radio groups and selects have their own paths
   * above, because the answer-picking rules in setValue are wrong for undo.
   *
   * Returns false when there is nothing to restore.
   * The snapshot is cleared afterwards, so undo is a one-shot.
   *
   * Per-field successes and failures are counted into _lastRestoreReport so
   * the caller can tell the user the truth (see AF.lastRestoreReport).
   */
  AF.restore = function () {
    _lastRestoreReport = { restored: 0, failed: 0, failedLabels: [] };

    try {
      if (!_snapshot) {
        return false;
      }

      if (_snapshot.length === 0) {
        _snapshot = null;
        return false;
      }

      var i;
      for (i = 0; i < _snapshot.length; i++) {
        var record = _snapshot[i];
        if (!record || !record.el) {
          continue;
        }

        var el = record.el;
        var putBack = false;

        try {
          // Nothing to do for a field we never changed — and there are plenty
          // of those, because we snapshot the whole form, not just the fields
          // we filled. Skipping them avoids a pointless storm of events, and
          // it keeps the failure count honest: a readonly box that already
          // holds its original value is restored, not "failed".
          if (recordMatchesCurrentState(record)) {
            _lastRestoreReport.restored++;
            continue;
          }

          if (record.kind === 'checkbox') {
            // setValue's checkbox branch clicks only when the state differs,
            // so handing it the old boolean restores it exactly.
            putBack = AF.setValue(el, record.checked, record.field);
          } else if (record.kind === 'radio') {
            putBack = restoreRadioGroup(record);
          } else if (record.kind === 'select') {
            putBack = restoreSelectValue(record);
          } else {
            // text / textarea / contenteditable — including restoring to ''.
            putBack = AF.setValue(el, record.value, record.field);
          }
        } catch (error) {
          logFailure('restore of one field', record.field, error);
          putBack = false;
        }

        if (putBack) {
          _lastRestoreReport.restored++;
        } else {
          _lastRestoreReport.failed++;
          _lastRestoreReport.failedLabels.push(describeRecord(record));
        }
      }

      if (_lastRestoreReport.failed > 0) {
        console.warn('[autofill] undo could not put ' + _lastRestoreReport.failed +
          ' field(s) back: ' + _lastRestoreReport.failedLabels.join(', '));
      }

      _snapshot = null;
      return true;
    } catch (error) {
      logFailure('restore', null, error);
      _snapshot = null;
      return false;
    }
  };

  /**
   * Is this control ALREADY holding exactly what the snapshot recorded?
   *
   * Used by restore() to leave untouched fields alone. Comparisons are per
   * kind, and anything we cannot read confidently answers false, so the worst
   * case is that we write the old value back over an identical one.
   */
  function recordMatchesCurrentState(record) {
    try {
      var el = record.el;

      if (record.kind === 'checkbox') {
        return (el.checked === true) === (record.checked === true);
      }

      if (record.kind === 'radio') {
        var members = (record.members && record.members.length > 0) ? record.members : [el];
        return findCheckedRadio(members) === record.checkedMember;
      }

      if (record.kind === 'select') {
        return el.selectedIndex === record.selectedIndex;
      }

      if (record.kind === 'contenteditable') {
        return asText(el.textContent) === asText(record.value);
      }

      // text / textarea / everything else with a plain value
      var current = el.value === undefined || el.value === null ? '' : String(el.value);
      return current === record.value;
    } catch (error) {
      return false;
    }
  }

  /**
   * A short human name for a snapshot record, used in the "could not undo"
   * warning and in the report the popup shows.
   */
  function describeRecord(record) {
    var field = record ? record.field : null;
    if (!field) {
      return '(unlabelled field)';
    }
    return (
      asText(field.label) ||
      asText(field.ariaLabel) ||
      asText(field.name) ||
      asText(field.id) ||
      asText(field.placeholder) ||
      '(unlabelled field)'
    );
  }

  /**
   * AF.lastRestoreReport() -> { restored, failed, failedLabels }
   *
   * What the most recent AF.restore() actually managed to do. AF.restore()
   * still returns a plain Boolean (the documented contract), so this is the
   * optional extra detail: the popup uses it to say "2 fields could not be
   * put back" instead of claiming the form is untouched when it is not.
   *
   * A copy is returned so a caller cannot corrupt our counters.
   */
  AF.lastRestoreReport = function () {
    return {
      restored: _lastRestoreReport.restored,
      failed: _lastRestoreReport.failed,
      failedLabels: _lastRestoreReport.failedLabels.slice()
    };
  };

  /**
   * AF.highlight(el, status)
   *
   * Draw a coloured 2px outline around a field so the user can see at a
   * glance what happened:
   *   'ok'   green — filled from the local profile
   *   'ai'   blue  — filled from an AI suggestion, please double-check
   *   'skip' amber — left alone / no confident match
   *
   * We remember the element's previous INLINE outline and outlineOffset and
   * put them back after 2500ms, so we never permanently alter the page's
   * styling. Note we only save the inline style, not the computed one —
   * restoring '' correctly hands control back to the page's own stylesheet.
   *
   * RE-ENTRANCY (this bit is easy to get wrong)
   *   The user can highlight the same element twice inside those 2500ms —
   *   "Fill without AI" followed straight away by "Fill this form" does it,
   *   and every run re-highlights the file inputs. If the second call read
   *   el.style.outline as "the original", it would capture the COLOURED
   *   outline the first call wrote; the first timer would then restore the
   *   genuine original and the second timer would paint the colour back on
   *   permanently. So the pending timer id and the TRUE original values live
   *   on the element itself: a second call cancels the outstanding timer and
   *   keeps the originals that are already stored.
   */
  AF.highlight = function (el, status) {
    try {
      if (!el || !el.style) {
        return;
      }

      var colour = HIGHLIGHT_COLOURS[status];
      if (!colour) {
        colour = HIGHLIGHT_COLOURS.skip;
      }

      if (el.__afHighlightTimer) {
        // A highlight is still running on this element. Cancel its timer and
        // deliberately do NOT re-read the current outline — it is ours, not
        // the page's. __afOutline / __afOutlineOffset already hold the truth.
        clearTimeout(el.__afHighlightTimer);
        el.__afHighlightTimer = null;
      } else {
        // First highlight on this element: now the inline style really is the
        // page's own, so it is safe to remember.
        el.__afOutline = el.style.outline;
        el.__afOutlineOffset = el.style.outlineOffset;
      }

      el.style.outline = '2px solid ' + colour;
      el.style.outlineOffset = '2px';

      el.__afHighlightTimer = setTimeout(function () {
        try {
          // Fall back to '' (= "no inline outline") if the stored value went
          // missing, which hands styling back to the page's own stylesheet.
          el.style.outline = typeof el.__afOutline === 'string' ? el.__afOutline : '';
          el.style.outlineOffset =
            typeof el.__afOutlineOffset === 'string' ? el.__afOutlineOffset : '';
        } catch (error) {
          // The node may have been removed from the DOM by a re-render.
        }
        try {
          el.__afHighlightTimer = null;
          el.__afOutline = undefined;
          el.__afOutlineOffset = undefined;
        } catch (error) {
          // Frozen element. Nothing we can do, and nothing that matters.
        }
      }, HIGHLIGHT_MS);
    } catch (error) {
      logFailure('highlight', null, error);
    }
  };

  /**
   * AF.scrollToFirst(el)
   *
   * Bring the given element (normally the first field we filled) into the
   * middle of the viewport with a smooth animation. Kept separate from
   * highlight() so the caller decides which single element deserves the
   * scroll — scrolling on every highlight would fight the user.
   */
  AF.scrollToFirst = function (el) {
    try {
      if (!el || typeof el.scrollIntoView !== 'function') {
        return;
      }
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch (error) {
      // Older engines reject the options object; fall back to the boolean.
      try {
        el.scrollIntoView(true);
      } catch (ignored) {
        // Give up quietly.
      }
    }
  };

  /**
   * AF.hasSnapshot() -> Boolean
   *
   * Small convenience for the popup so it can enable/disable its Undo
   * button without reaching into module internals.
   */
  AF.hasSnapshot = function () {
    return _snapshot !== null && _snapshot.length > 0;
  };

  /* Exposed for the popup / options page so the legend colours there stay
   * in sync with the outlines drawn on the page. Read-only by convention. */
  AF.HIGHLIGHT_COLOURS = HIGHLIGHT_COLOURS;
})();
