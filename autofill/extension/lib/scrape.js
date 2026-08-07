/* =============================================================================
 * autofill / extension / lib / scrape.js
 * -----------------------------------------------------------------------------
 * WHAT THIS FILE DOES
 *   It reads a web page (a job application form) and produces a plain list of
 *   "Field" objects describing every form control a human could type into.
 *   It NEVER writes to the page. It is 100% read-only. Filling is fill.js's job.
 *
 * HOW IT IS LOADED
 *   Plain classic script (no import/export, no build step). Chrome loads it in
 *   the order given in manifest.json. Everything it exposes is hung off one
 *   global object called AF (short for AutoFill), exactly like a Java utility
 *   class with static methods:
 *
 *       AF.scrapeFields(document)  ->  Field[]      (see contract below)
 *       AF.scrapeAll()             ->  Field[]      (current document only)
 *       AF.toSerialisable(fields)  ->  plain objects, safe to send over a port
 *       AF.debugDump()             ->  prints a table in DevTools console
 *
 * THE Field SHAPE (shared contract - other modules depend on these exact keys)
 *   {
 *     index:       Number,   // 0,1,2... in document order, stable per scrape
 *     el:          Element,  // LIVE dom node. Never sent over a message port.
 *     kind:        String,   // text|textarea|select|radio|checkbox|file|contenteditable
 *     type:        String,   // raw <input type="..."> value, '' if not an input
 *     name:        String,
 *     id:          String,
 *     placeholder: String,
 *     ariaLabel:   String,
 *     label:       String,   // best-effort visible label text
 *     context:     String,   // nearest legend / heading, gives the AI a hint
 *     required:    Boolean,
 *     options:     Array,    // [{value, text}] for select + radio, [] otherwise
 *     groupName:   String,   // radio group name, '' otherwise
 *     filled:      Boolean   // true when the control already has a value
 *   }
 *
 * A NOTE FOR THE READER (you are a Java/Spring + Flutter dev, not a JS dev)
 *   - `var AF = (globalThis.AF = globalThis.AF || {});` is the JS way of saying
 *     "give me the singleton AF, creating it if this file happened to load
 *     first". Every file in this project starts with that same line, so load
 *     order never matters.
 *   - The whole file body is wrapped in an IIFE - `(function () { ... })();` -
 *     which is JS's equivalent of a private static block: anything declared
 *     inside is invisible to the rest of the page. Only what we explicitly
 *     assign onto AF escapes.
 * ===========================================================================*/

var AF = (globalThis.AF = globalThis.AF || {});

(function () {
  'use strict';

  /* ---------------------------------------------------------------------------
   * SECTION 1 - constants
   * -------------------------------------------------------------------------*/

  /** Longest label/context string we keep. Anything longer is noise. */
  var MAX_TEXT_LENGTH = 200;

  /**
   * <input type="..."> values that are NOT user data entry and must be ignored.
   * type=image is the obscure one: it renders a clickable picture, like a submit
   * button with a graphic.
   */
  var IGNORED_INPUT_TYPES = {
    hidden: true,
    submit: true,
    button: true,
    reset: true,
    image: true
  };

  /**
   * The CSS selector for "things a person can type into or choose from".
   * contenteditable="" (empty string) legally means "true" in HTML, so we match
   * both spellings. Ashby's rich-text cover-letter box is a contenteditable div.
   */
  var CANDIDATE_SELECTOR =
    'input, select, textarea, [contenteditable="true"], [contenteditable=""]';

  /* ---------------------------------------------------------------------------
   * SECTION 2 - tiny text helpers
   * -------------------------------------------------------------------------*/

  /**
   * Normalise a piece of label text.
   *   - turns every run of whitespace (including newlines) into one space
   *   - trims the ends
   *   - strips a trailing '*' (the classic "required" marker)
   *   - strips the word '(required)' / 'required' in parentheses, any case
   *   - caps the result at MAX_TEXT_LENGTH characters
   *
   * @param {String} raw
   * @returns {String} cleaned text, '' when there was nothing useful
   */
  function cleanText(raw) {
    if (raw === null || raw === undefined) {
      return '';
    }

    var text = String(raw);

    // Collapse all whitespace runs (spaces, tabs, newlines) into a single space.
    text = text.replace(/\s+/g, ' ').trim();

    // Remove '(required)' or '(Required)' anywhere in the string.
    text = text.replace(/\(\s*required\s*\)/gi, ' ');

    // Remove a trailing standalone word 'required'.
    text = text.replace(/\s+required\s*$/i, '');

    // Remove any trailing asterisks (possibly several, possibly spaced out).
    text = text.replace(/[\s*]+$/, '');

    // Collapse again, because the removals above can leave double spaces.
    text = text.replace(/\s+/g, ' ').trim();

    if (text.length > MAX_TEXT_LENGTH) {
      text = text.slice(0, MAX_TEXT_LENGTH);
    }

    return text;
  }

  /**
   * Read an attribute and always return a String ('' when the attribute is
   * missing). Saves us writing null checks in fifteen places.
   */
  function attr(el, attributeName) {
    if (!el || typeof el.getAttribute !== 'function') {
      return '';
    }
    var value = el.getAttribute(attributeName);
    return value === null || value === undefined ? '' : String(value);
  }

  /**
   * Visible text of a candidate label element, WITHOUT the text of any form
   * controls nested inside it.
   *
   * Why: a <label> often wraps its own control, e.g.
   *     <label>Country <select><option>India</option></select></label>
   * Reading textContent there would give us "Country India" - the option text
   * leaks in. So we clone the node (a throwaway copy that is never inserted in
   * the page, therefore still read-only as far as the real page is concerned),
   * delete the controls from the copy, and read what is left.
   *
   * @param {Element} el
   * @returns {String}
   */
  function visibleTextWithoutControls(el) {
    if (!el) {
      return '';
    }

    // Fast path: no nested controls, so no need to clone anything.
    var hasNestedControl = false;
    if (typeof el.querySelector === 'function') {
      hasNestedControl = !!el.querySelector('input, select, textarea, button');
    }
    if (!hasNestedControl) {
      return cleanText(el.textContent);
    }

    var copy = el.cloneNode(true);
    var junk = copy.querySelectorAll('input, select, textarea, button, option');
    var i;
    for (i = 0; i < junk.length; i++) {
      if (junk[i].parentNode) {
        junk[i].parentNode.removeChild(junk[i]);
      }
    }
    return cleanText(copy.textContent);
  }

  /* ---------------------------------------------------------------------------
   * SECTION 3 - DOM navigation helpers that understand shadow DOM
   *
   * Shadow DOM is a mini-document hidden inside one element. Workday and some
   * Ashby widgets use it. Normal parentNode walking stops dead at the shadow
   * boundary, so every "walk upwards" helper below uses parentOf(), which hops
   * out of a shadow root onto its host element and keeps going.
   * -------------------------------------------------------------------------*/

  /**
   * One step up the tree, crossing shadow boundaries.
   * @param {Node} node
   * @returns {Node|null}
   */
  function parentOf(node) {
    if (!node) {
      return null;
    }
    if (node.parentNode) {
      return node.parentNode;
    }
    // No parentNode? We may be standing on a ShadowRoot; jump to its host.
    if (node.host) {
      return node.host;
    }
    return null;
  }

  /**
   * The root this node lives in: either the main `document` or a ShadowRoot.
   * Used when we need to resolve an id reference (ids are scoped per root).
   */
  function rootOf(node) {
    if (node && typeof node.getRootNode === 'function') {
      return node.getRootNode();
    }
    return document;
  }

  /**
   * Look up an element by id inside the same tree as `node`.
   * We deliberately do NOT use `document.getElementById` because inside a
   * shadow root the id lives in the shadow tree, not the main document.
   */
  function getElementByIdNear(node, id) {
    if (!id) {
      return null;
    }
    var root = rootOf(node);
    if (root && typeof root.getElementById === 'function') {
      return root.getElementById(id);
    }
    // ShadowRoot has querySelector but not always getElementById.
    if (root && typeof root.querySelectorAll === 'function') {
      var all = root.querySelectorAll('[id]');
      var i;
      for (i = 0; i < all.length; i++) {
        if (all[i].id === id) {
          return all[i];
        }
      }
    }
    return null;
  }

  /**
   * Is this element (or any ancestor) hidden from assistive tech?
   * Forms often keep a whole collapsed accordion in the DOM with
   * aria-hidden="true"; we must not offer those fields.
   */
  function isInAriaHiddenSubtree(el) {
    var node = el;
    var guard = 0; // paranoia counter, stops any pathological loop
    while (node && guard < 200) {
      guard++;
      if (node.nodeType === 1 && attr(node, 'aria-hidden') === 'true') {
        return true;
      }
      node = parentOf(node);
    }
    return false;
  }

  /**
   * Does the element occupy space on screen?
   *
   * We check TWO things because each one alone lies to us:
   *   - offsetParent is null for display:none elements (good signal) BUT it is
   *     also null for position:fixed elements, which are perfectly visible.
   *   - getClientRects().length is 0 for display:none elements too.
   * Only when BOTH say "nothing here" do we believe the element is invisible.
   */
  function hasLayoutBox(el) {
    if (!el) {
      return false;
    }
    var hasOffsetParent = el.offsetParent !== null && el.offsetParent !== undefined;
    var rectCount = 0;
    if (typeof el.getClientRects === 'function') {
      rectCount = el.getClientRects().length;
    }
    return hasOffsetParent || rectCount > 0;
  }

  /* ---------------------------------------------------------------------------
   * SECTION 4 - collecting candidate elements in document order
   * -------------------------------------------------------------------------*/

  /**
   * Depth-first walk from `root`, pushing every element that matches
   * CANDIDATE_SELECTOR into `out`, and stepping into any OPEN shadow root it
   * meets. Closed shadow roots are invisible to scripts - nothing we can do.
   *
   * Because we descend children in order, `out` ends up in document order,
   * which is what gives us stable `index` numbers.
   *
   * @param {Node}    root     document, ShadowRoot, or Element to walk
   * @param {Set}     visited  cycle guard - a node is processed at most once
   * @param {Array}   out      accumulator, mutated in place
   */
  function collectCandidates(root, visited, out) {
    if (!root) {
      return;
    }
    if (visited.has(root)) {
      return; // already walked this subtree - protects against cycles
    }
    visited.add(root);

    // `children` exists on Document, ShadowRoot and Element alike and only
    // contains element nodes (no text nodes), which is exactly what we want.
    var kids = root.children;
    if (!kids) {
      return;
    }

    var i;
    for (i = 0; i < kids.length; i++) {
      var child = kids[i];
      if (visited.has(child)) {
        continue;
      }

      // 1) Is this child itself a control we care about?
      if (typeof child.matches === 'function' && child.matches(CANDIDATE_SELECTOR)) {
        out.push(child);
      }

      // 2) Step into its open shadow root, if it has one (Workday / Ashby).
      if (child.shadowRoot) {
        collectCandidates(child.shadowRoot, visited, out);
      }

      // 3) Step into its normal children.
      collectCandidates(child, visited, out);
    }
  }

  /**
   * Should this candidate element be dropped entirely?
   * @returns {Boolean} true when we must ignore it
   */
  function shouldSkip(el) {
    var tag = el.tagName ? el.tagName.toLowerCase() : '';

    // Non-interactive input types (hidden, submit, button, reset, image).
    if (tag === 'input') {
      var rawType = (attr(el, 'type') || 'text').toLowerCase();
      if (IGNORED_INPUT_TYPES[rawType] === true) {
        return true;
      }
    }

    // A disabled control cannot be filled by a human or by us.
    if (el.disabled === true) {
      return true;
    }

    // Hidden from screen readers => hidden from us.
    if (isInAriaHiddenSubtree(el)) {
      return true;
    }

    // Zero layout box => not on screen.
    if (!hasLayoutBox(el)) {
      return true;
    }

    return false;
  }

  /* ---------------------------------------------------------------------------
   * SECTION 5 - label resolution
   *
   * This is the heart of the scraper: turning a nameless <input> into the human
   * question it is asking. We try seven strategies in priority order and the
   * first non-empty answer wins.
   * -------------------------------------------------------------------------*/

  /** (a) <label for="theId"> living anywhere in the same tree. */
  function labelFromForAttribute(el) {
    if (!el.id) {
      return '';
    }
    var root = rootOf(el);
    if (!root || typeof root.querySelectorAll !== 'function') {
      return '';
    }
    // We scan rather than build a CSS selector, because ids on real forms can
    // contain characters (':', '.', '[') that break selector syntax.
    var labels = root.querySelectorAll('label[for]');
    var i;
    for (i = 0; i < labels.length; i++) {
      if (labels[i].getAttribute('for') === el.id) {
        var text = visibleTextWithoutControls(labels[i]);
        if (text) {
          return text;
        }
      }
    }
    return '';
  }

  /** (b) An ancestor <label> that wraps the control. */
  function labelFromAncestorLabel(el) {
    var node = parentOf(el);
    var guard = 0;
    while (node && guard < 50) {
      guard++;
      if (node.nodeType === 1 && node.tagName && node.tagName.toLowerCase() === 'label') {
        return visibleTextWithoutControls(node);
      }
      node = parentOf(node);
    }
    return '';
  }

  /** (c) aria-labelledby="id1 id2" -> resolve each id, join with a space. */
  function labelFromAriaLabelledBy(el) {
    var raw = attr(el, 'aria-labelledby');
    if (!raw) {
      return '';
    }
    var ids = raw.split(/\s+/);
    var parts = [];
    var i;
    for (i = 0; i < ids.length; i++) {
      if (!ids[i]) {
        continue;
      }
      var target = getElementByIdNear(el, ids[i]);
      if (target) {
        var piece = visibleTextWithoutControls(target);
        if (piece) {
          parts.push(piece);
        }
      }
    }
    return cleanText(parts.join(' '));
  }

  /** (d) aria-label="..." straight off the element. */
  function labelFromAriaLabel(el) {
    return cleanText(attr(el, 'aria-label'));
  }

  /**
   * (e) The closest preceding sibling with text - either a bare text node
   * ("Email:" typed directly before the input) or an element such as a <span>
   * or <div> holding the question.
   *
   * We start at the element itself and walk previousSibling. If that finds
   * nothing we go up one level and try the parent's previous siblings, because
   * many form builders wrap the input in its own <div>. Depth is capped at 3
   * levels so we never wander into an unrelated part of the page.
   */
  function labelFromPrecedingSibling(el) {
    var node = el;
    var levelsUp = 0;

    while (node && levelsUp <= 3) {
      var sibling = node.previousSibling;
      var siblingGuard = 0;

      while (sibling && siblingGuard < 20) {
        siblingGuard++;

        if (sibling.nodeType === 3) {
          // Text node typed directly in the markup.
          var textNodeValue = cleanText(sibling.nodeValue);
          if (textNodeValue) {
            return textNodeValue;
          }
        } else if (sibling.nodeType === 1) {
          var tag = sibling.tagName.toLowerCase();
          // Skip other form controls - they are not our label.
          if (tag !== 'input' && tag !== 'select' && tag !== 'textarea') {
            // Once we have climbed out of our own wrapper, a sibling that
            // CONTAINS a form control is the NEIGHBOURING field group, not our
            // label. Reading it would hand us the previous question's wording
            // (or, on a radio list, the previous option's answer text).
            if (levelsUp > 0 && containsFormControl(sibling)) {
              sibling = sibling.previousSibling;
              continue;
            }
            var elementText = visibleTextWithoutControls(sibling);
            if (elementText) {
              return elementText;
            }
          }
        }
        sibling = sibling.previousSibling;
      }

      node = parentOf(node);
      levelsUp++;
    }

    return '';
  }

  /** True when this element has a form control somewhere inside it. */
  function containsFormControl(el) {
    if (!el || typeof el.querySelector !== 'function') {
      return false;
    }
    return !!el.querySelector('input, select, textarea');
  }

  /**
   * (e2) The text that FOLLOWS the control.
   *
   * This is the single most common radio / checkbox markup on our target
   * sites, and it is the one shape none of the other strategies can see:
   *
   *     <input type="radio" name="q" value="1"><span>Yes</span>
   *
   * fill.js has always known about it (readRadioLabelText looks at
   * nextElementSibling, commented "Lever does this"); the scraper did not, so
   * every such radio inherited the PREVIOUS option's text via strategy (e).
   *
   * Only used for radios and checkboxes: for a text input, the text after the
   * box is usually a hint ("we will never share this") rather than a label.
   */
  function labelFromFollowingSibling(el) {
    var sibling = el.nextSibling;
    var guard = 0;

    while (sibling && guard < 5) {
      guard++;

      if (sibling.nodeType === 3) {
        var textNodeValue = cleanText(sibling.nodeValue);
        if (textNodeValue) {
          return textNodeValue;
        }
      } else if (sibling.nodeType === 1) {
        var tag = sibling.tagName.toLowerCase();
        // Another control means the option list moved on; we are done.
        if (tag === 'input' || tag === 'select' || tag === 'textarea') {
          return '';
        }
        if (containsFormControl(sibling)) {
          return '';
        }
        var elementText = visibleTextWithoutControls(sibling);
        if (elementText) {
          return elementText;
        }
      }
      sibling = sibling.nextSibling;
    }

    return '';
  }

  /**
   * (f) Table layouts. Old Workday and many enterprise portals lay forms out as
   * <tr><td>Question</td><td><input></td></tr>. So: take the <td> holding our
   * input, look at the cell before it; if there is no previous cell, use the
   * first cell of the row.
   */
  function labelFromTableCell(el) {
    // Find the enclosing cell, crossing shadow boundaries as we climb.
    var cell = null;
    var node = parentOf(el);
    var guard = 0;
    while (node && guard < 50) {
      guard++;
      if (node.nodeType === 1 && node.tagName) {
        var tag = node.tagName.toLowerCase();
        if (tag === 'td' || tag === 'th') {
          cell = node;
          break;
        }
        if (tag === 'table' || tag === 'form' || tag === 'body') {
          break; // gone too far, there is no cell
        }
      }
      node = parentOf(node);
    }
    if (!cell) {
      return '';
    }

    // The cell immediately to the left.
    var previousCell = cell.previousElementSibling;
    if (previousCell) {
      var previousText = visibleTextWithoutControls(previousCell);
      if (previousText) {
        return previousText;
      }
    }

    // Otherwise the row's first cell (often a <th> row header).
    var row = cell.parentElement;
    if (row && row.children && row.children.length > 0) {
      var firstCell = row.children[0];
      if (firstCell !== cell) {
        var firstText = visibleTextWithoutControls(firstCell);
        if (firstText) {
          return firstText;
        }
      }
    }

    return '';
  }

  /** (g) Last resort: the placeholder text. */
  function labelFromPlaceholder(el) {
    return cleanText(attr(el, 'placeholder'));
  }

  /**
   * Run the strategies in order and return the first non-empty result.
   *
   * @param {Element} el
   * @param {String} [kind] the field kind, when the caller already knows it.
   *        For 'radio' and 'checkbox' the "text after the control" strategy is
   *        inserted before the "text before the control" one, because
   *        `<input><span>Yes</span>` is how those are almost always written and
   *        looking backwards there returns a neighbour's wording instead.
   * @returns {String} '' when the form gives us nothing at all
   */
  function resolveLabel(el, kind) {
    var strategies = [
      labelFromForAttribute,
      labelFromAncestorLabel,
      labelFromAriaLabelledBy,
      labelFromAriaLabel
    ];

    if (kind === 'radio' || kind === 'checkbox') {
      strategies.push(labelFromFollowingSibling);
    }

    strategies = strategies.concat([
      labelFromPrecedingSibling,
      labelFromTableCell,
      labelFromPlaceholder
    ]);

    var i;
    for (i = 0; i < strategies.length; i++) {
      var result = '';
      try {
        result = strategies[i](el);
      } catch (error) {
        // A broken page must never break the scrape. Move on to the next idea.
        result = '';
      }
      if (result) {
        return cleanText(result);
      }
    }
    return '';
  }

  /* ---------------------------------------------------------------------------
   * SECTION 6 - context resolution (the section a field belongs to)
   * -------------------------------------------------------------------------*/

  /**
   * Nearest ancestor <fieldset>'s <legend>, otherwise the nearest heading
   * (h1..h6) that appears BEFORE this element. Gives the AI bridge a hint such
   * as "Work Authorization" or "Voluntary Self-Identification".
   *
   * @param {Element} el
   * @returns {String} capped at 200 chars, '' when nothing found
   */
  function resolveContext(el) {
    // --- 1) fieldset > legend -----------------------------------------------
    var node = parentOf(el);
    var guard = 0;
    while (node && guard < 60) {
      guard++;
      if (node.nodeType === 1 && node.tagName && node.tagName.toLowerCase() === 'fieldset') {
        var legend = node.querySelector('legend');
        if (legend) {
          var legendText = visibleTextWithoutControls(legend);
          if (legendText) {
            return legendText;
          }
        }
      }
      node = parentOf(node);
    }

    // --- 2) nearest preceding heading ---------------------------------------
    // Climb the tree; at each level walk backwards through the previous
    // siblings looking for a heading, or a container whose LAST heading is the
    // closest one before us.
    node = el;
    var levelsUp = 0;
    while (node && levelsUp < 12) {
      var sibling = node.previousElementSibling;
      var siblingGuard = 0;
      while (sibling && siblingGuard < 50) {
        siblingGuard++;

        var tag = sibling.tagName ? sibling.tagName.toLowerCase() : '';
        if (/^h[1-6]$/.test(tag)) {
          var direct = visibleTextWithoutControls(sibling);
          if (direct) {
            return direct;
          }
        }

        if (typeof sibling.querySelectorAll === 'function') {
          var nested = sibling.querySelectorAll('h1, h2, h3, h4, h5, h6');
          if (nested.length > 0) {
            // The LAST heading inside that block is the one nearest to us.
            var nestedText = visibleTextWithoutControls(nested[nested.length - 1]);
            if (nestedText) {
              return nestedText;
            }
          }
        }

        sibling = sibling.previousElementSibling;
      }

      node = parentOf(node);
      levelsUp++;
    }

    return '';
  }

  /* ---------------------------------------------------------------------------
   * SECTION 7 - per-control details: kind, options, filled
   * -------------------------------------------------------------------------*/

  /**
   * Classify the element into one of the seven `kind` values in the contract.
   * @returns {String}
   */
  function resolveKind(el) {
    var tag = el.tagName ? el.tagName.toLowerCase() : '';

    if (tag === 'textarea') {
      return 'textarea';
    }
    if (tag === 'select') {
      return 'select';
    }
    if (tag === 'input') {
      var type = (attr(el, 'type') || 'text').toLowerCase();
      if (type === 'radio') {
        return 'radio';
      }
      if (type === 'checkbox') {
        return 'checkbox';
      }
      if (type === 'file') {
        return 'file';
      }
      // text, email, tel, url, number, date, password, search... all "text".
      return 'text';
    }
    // Anything else that matched our selector is an editable div/span.
    return 'contenteditable';
  }

  /**
   * Is the control "required"? We accept the HTML attribute and the ARIA one,
   * because React form libraries frequently only set aria-required.
   */
  function resolveRequired(el) {
    if (el.required === true) {
      return true;
    }
    if (attr(el, 'aria-required') === 'true') {
      return true;
    }
    return false;
  }

  /**
   * Options for a <select>.
   *
   * Rule from the spec: skip the leading placeholder option when its value is
   * the empty string (things like "-- Please select --"), because it is not a
   * real answer. We do NOT throw its text away: the caller receives it as the
   * field's `placeholder`, so a matcher can recognise an untouched dropdown.
   *
   * @returns {{options: Array, placeholderText: String}}
   */
  function readSelectOptions(selectEl) {
    var options = [];
    var placeholderText = '';
    var list = selectEl.options || [];
    var i;

    for (i = 0; i < list.length; i++) {
      var option = list[i];
      var value = option.value === null || option.value === undefined ? '' : String(option.value);
      var text = cleanText(option.textContent);

      // First entry with an empty value = the placeholder. Remember its words,
      // then leave it out of the real choices.
      if (i === 0 && value === '') {
        placeholderText = text;
        continue;
      }

      options.push({ value: value, text: text });
    }

    return { options: options, placeholderText: placeholderText };
  }

  /**
   * Does this control already hold a value the user typed / picked?
   * We report it; we never act on it. fill.js decides whether to overwrite.
   */
  function resolveFilled(el, kind) {
    try {
      if (kind === 'checkbox' || kind === 'radio') {
        return el.checked === true;
      }
      if (kind === 'file') {
        return !!(el.files && el.files.length > 0);
      }
      if (kind === 'contenteditable') {
        return cleanText(el.textContent) !== '';
      }
      // text, textarea, select
      var value = el.value;
      if (value === null || value === undefined) {
        return false;
      }
      return String(value).trim() !== '';
    } catch (error) {
      return false;
    }
  }

  /* ---------------------------------------------------------------------------
   * SECTION 8 - radio groups
   *
   * A radio group is ONE question with N answers, so it must become ONE field,
   * not N fields. We group the radios by their `name` attribute and emit a
   * single field at the position of the first radio in the group.
   * -------------------------------------------------------------------------*/

  /**
   * Best label for a whole radio group. The individual radio's own label is the
   * ANSWER ("Yes"), not the QUESTION, so we look outward instead:
   *   1. a container with role="radiogroup" carrying aria-label / -labelledby
   *   2. the enclosing <fieldset>'s <legend>
   *   3. the text sitting just before the group's container
   *
   * @param {Element} firstRadio
   * @returns {String}
   */
  function resolveRadioGroupLabel(firstRadio) {
    // --- 1) role="radiogroup" container --------------------------------------
    var node = parentOf(firstRadio);
    var guard = 0;
    while (node && guard < 40) {
      guard++;
      if (node.nodeType === 1) {
        if (attr(node, 'role') === 'radiogroup' || attr(node, 'role') === 'group') {
          var viaLabelledBy = labelFromAriaLabelledBy(node);
          if (viaLabelledBy) {
            return viaLabelledBy;
          }
          var viaAriaLabel = labelFromAriaLabel(node);
          if (viaAriaLabel) {
            return viaAriaLabel;
          }
        }

        // --- 2) fieldset > legend ---------------------------------------------
        if (node.tagName && node.tagName.toLowerCase() === 'fieldset') {
          var legend = node.querySelector('legend');
          if (legend) {
            var legendText = visibleTextWithoutControls(legend);
            if (legendText) {
              return legendText;
            }
          }
        }
      }
      node = parentOf(node);
    }

    // --- 3) text just before the group's wrapper ------------------------------
    // We climb a couple of levels (radio -> its own <label> -> the options
    // wrapper) and ask "what text comes right before this block?".
    var wrapper = firstRadio;
    var climbed = 0;
    while (wrapper && climbed < 4) {
      var precedingText = labelFromPrecedingSibling(wrapper);
      if (precedingText) {
        return precedingText;
      }
      wrapper = parentOf(wrapper);
      climbed++;
    }

    return '';
  }

  /**
   * Build the options[] array of a radio group: one entry per radio, using each
   * radio's own resolved label as the human-readable text.
   */
  function buildRadioOptions(radios) {
    var options = [];
    var i;
    for (i = 0; i < radios.length; i++) {
      var radio = radios[i];
      var value = radio.value === null || radio.value === undefined ? '' : String(radio.value);
      // 'radio' matters here: it is what makes resolveLabel look at the text
      // AFTER the input first, which is where an option's answer text lives.
      var text = resolveLabel(radio, 'radio');
      if (!text) {
        text = value; // some forms rely purely on the value attribute
      }
      options.push({ value: value, text: text });
    }
    return options;
  }

  /* ---------------------------------------------------------------------------
   * SECTION 9 - the public scrape
   * -------------------------------------------------------------------------*/

  /**
   * Build one Field object for a single, non-radio element.
   *
   * @param {Element} el
   * @param {String}  kind
   * @returns {Object} a Field WITHOUT its index (assigned by the caller)
   */
  function buildSimpleField(el, kind) {
    var placeholder = cleanText(attr(el, 'placeholder'));
    var options = [];

    if (kind === 'select') {
      var selectData = readSelectOptions(el);
      options = selectData.options;
      // Carry the "-- Select --" wording through as the placeholder so the
      // matcher can tell an untouched dropdown from a chosen one.
      if (!placeholder && selectData.placeholderText) {
        placeholder = selectData.placeholderText;
      }
    }

    return {
      index: -1, // filled in by scrapeFields once the full list is known
      el: el,
      kind: kind,
      type: el.tagName && el.tagName.toLowerCase() === 'input' ? attr(el, 'type') : '',
      name: attr(el, 'name'),
      id: el.id ? String(el.id) : '',
      placeholder: placeholder,
      ariaLabel: cleanText(attr(el, 'aria-label')),
      label: resolveLabel(el, kind),
      context: resolveContext(el),
      required: resolveRequired(el),
      options: options,
      groupName: '',
      filled: resolveFilled(el, kind)
    };
  }

  /**
   * Build the single Field object that represents a whole radio group.
   *
   * @param {Element[]} radios  every radio sharing the same name, in doc order
   * @param {String}    groupName
   * @returns {Object} a Field WITHOUT its index
   */
  function buildRadioGroupField(radios, groupName) {
    var first = radios[0];

    // The group counts as filled when ANY of its radios is already checked.
    var anyChecked = false;
    // The group counts as required when ANY radio carries the required flag.
    var anyRequired = false;
    var i;
    for (i = 0; i < radios.length; i++) {
      if (radios[i].checked === true) {
        anyChecked = true;
      }
      if (resolveRequired(radios[i])) {
        anyRequired = true;
      }
    }

    var label = resolveRadioGroupLabel(first);
    if (!label) {
      // Absolute fallback: better a machine name than nothing at all.
      label = cleanText(groupName);
    }

    return {
      index: -1,
      el: first, // the contract says: the FIRST radio of the group
      kind: 'radio',
      type: 'radio',
      name: groupName,
      id: first.id ? String(first.id) : '',
      placeholder: '',
      ariaLabel: cleanText(attr(first, 'aria-label')),
      label: label,
      context: resolveContext(first),
      required: anyRequired,
      options: buildRadioOptions(radios),
      groupName: groupName,
      filled: anyChecked
    };
  }

  /**
   * MAIN ENTRY POINT.
   * Scrape every fillable field out of a document (or any subtree).
   *
   * @param {Document|Element|ShadowRoot} [rootDocument] defaults to `document`
   * @returns {Array} Field[] in document order, index 0..n-1
   */
  function scrapeFields(rootDocument) {
    var root = rootDocument || document;

    // ---- step 1: gather every candidate element, in document order ----------
    var candidates = [];
    var visited = new Set(); // cycle guard for the shadow-DOM walk
    try {
      collectCandidates(root, visited, candidates);
    } catch (error) {
      console.warn('[AF.scrapeFields] DOM walk failed:', error);
    }

    // ---- step 2: turn them into Field objects -------------------------------
    var fields = [];

    // Radios are special: many elements, one field. `radioGroups` remembers
    // which group name we have already emitted, and where its field sits in
    // `fields`, so later radios of the same name just add an option.
    var radioGroupsByName = Object.create(null); // name -> Element[]
    var radioFieldIndexByName = Object.create(null); // name -> position in `fields`

    var i;
    for (i = 0; i < candidates.length; i++) {
      var el = candidates[i];

      if (shouldSkip(el)) {
        continue;
      }

      var kind = resolveKind(el);

      if (kind === 'radio') {
        // Radios with no name cannot be grouped by the browser either, so we
        // give each one a private synthetic key and it becomes its own group.
        var rawName = attr(el, 'name');
        var groupKey = rawName !== '' ? rawName : '__unnamed_radio_' + i;

        if (radioGroupsByName[groupKey] === undefined) {
          // First radio of this group: create the group and reserve its slot.
          radioGroupsByName[groupKey] = [el];
          fields.push(null); // placeholder, replaced at the end of the loop
          radioFieldIndexByName[groupKey] = fields.length - 1;
        } else {
          // A later member of a group we have already seen.
          radioGroupsByName[groupKey].push(el);
        }
        continue;
      }

      // Everything else is a straightforward one-element-one-field mapping.
      fields.push(buildSimpleField(el, kind));
    }

    // ---- step 3: materialise the radio groups into their reserved slots -----
    var groupKeys = Object.keys(radioGroupsByName);
    for (i = 0; i < groupKeys.length; i++) {
      var key = groupKeys[i];
      var radios = radioGroupsByName[key];
      var slot = radioFieldIndexByName[key];
      // The synthetic key must not leak into the data, so report '' for those.
      var reportedName = key.indexOf('__unnamed_radio_') === 0 ? '' : key;
      fields[slot] = buildRadioGroupField(radios, reportedName);
    }

    // ---- step 4: assign the stable indexes ----------------------------------
    var result = [];
    for (i = 0; i < fields.length; i++) {
      if (!fields[i]) {
        continue; // defensive: a reserved slot that somehow never got filled
      }
      fields[i].index = result.length;
      result.push(fields[i]);
    }

    return result;
  }

  /**
   * Scrape the document this content script is running in.
   *
   * IMPORTANT: do NOT try to reach into iframes from here. The manifest sets
   * "all_frames": true, so Chrome injects a separate copy of this script into
   * every frame and each copy scrapes its own document. Touching another
   * frame's document directly is blocked by the cross-origin policy anyway.
   *
   * @returns {Array} Field[]
   */
  function scrapeAll() {
    return scrapeFields(document);
  }

  /**
   * Strip the live DOM reference so the result can be sent through
   * chrome.runtime messaging / to the AI bridge. DOM nodes cannot be cloned by
   * the structured-clone algorithm, so forgetting this throws at runtime.
   *
   * @param {Array} fields  Field[] from scrapeFields
   * @returns {Array} the same objects minus `el`
   */
  function toSerialisable(fields) {
    var list = fields || [];
    var out = [];
    var i;

    for (i = 0; i < list.length; i++) {
      var field = list[i];
      if (!field) {
        continue;
      }
      out.push({
        index: field.index,
        kind: field.kind,
        type: field.type,
        name: field.name,
        id: field.id,
        placeholder: field.placeholder,
        ariaLabel: field.ariaLabel,
        label: field.label,
        context: field.context,
        required: field.required,
        options: field.options ? field.options.slice() : [],
        groupName: field.groupName,
        filled: field.filled
      });
    }

    return out;
  }

  /* ---------------------------------------------------------------------------
   * SECTION 10 - manual testing helper
   * -------------------------------------------------------------------------*/

  /**
   * Open a real application form, open DevTools, type:  AF.debugDump()
   *
   * Prints a compact table (one row per field) plus the full objects, and
   * returns the serialisable array so you can copy it out with
   * `copy(AF.debugDump())`.
   *
   * @returns {Array} the serialisable fields
   */
  function debugDump() {
    var fields = scrapeFields(document);
    var plain = toSerialisable(fields);

    // A narrow view first - console.table renders nested arrays badly, so the
    // options are summarised as a count plus the first few choices.
    var summary = [];
    var i;
    for (i = 0; i < plain.length; i++) {
      var f = plain[i];
      var preview = '';
      var j;
      for (j = 0; j < f.options.length && j < 3; j++) {
        preview += (preview ? ' | ' : '') + f.options[j].text;
      }
      if (f.options.length > 3) {
        preview += ' | ...';
      }

      summary.push({
        index: f.index,
        kind: f.kind,
        label: f.label,
        context: f.context,
        name: f.name,
        required: f.required,
        filled: f.filled,
        optionCount: f.options.length,
        options: preview
      });
    }

    console.log('[AF] scraped ' + plain.length + ' field(s) from ' + document.location.href);
    if (typeof console.table === 'function') {
      console.table(summary);
    } else {
      console.log(summary);
    }
    console.log('[AF] full serialisable payload:', plain);

    return plain;
  }

  /* ---------------------------------------------------------------------------
   * SECTION 11 - publish the public API onto the AF namespace
   * -------------------------------------------------------------------------*/

  AF.scrapeFields = scrapeFields;
  AF.scrapeAll = scrapeAll;
  AF.toSerialisable = toSerialisable;
  AF.debugDump = debugDump;
})();
