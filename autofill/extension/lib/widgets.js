/* =====================================================================
 * widgets.js  —  custom (fake) dropdowns.
 *
 * WHAT PROBLEM DOES THIS FILE SOLVE?
 * ----------------------------------
 * lib/fill.js knows how to set a real <select>. A real <select> is a
 * browser-native control: it has .options, .selectedIndex, and setting
 * those actually changes what the form submits.
 *
 * Modern application trackers do NOT use <select>. Workday, Ashby,
 * Greenhouse's newer forms, Lever and anything built with the popular
 * "react-select" library draw their own dropdown out of plain <div>s:
 *
 *     <div class="select__control" role="combobox" aria-expanded="false">
 *       <input class="select__input" ...>          <- often readonly
 *       <div class="select__single-value">Select...</div>
 *     </div>
 *     ... and when you click it, somewhere else in the page:
 *     <div class="select__menu" role="listbox">
 *       <div role="option">United States</div>
 *       <div role="option">Vietnam</div>
 *     </div>
 *
 * There is no .value to write and no .options to search. The ONLY way to
 * choose "Vietnam" is to behave like a human hand: click the control,
 * wait for the menu to be drawn, find the row whose text says Vietnam,
 * and click that row. AF.setValue correctly refuses to touch these (it
 * would type into a readonly input and report failure), so every such
 * field is currently left blank. That is the biggest remaining gap in
 * the fill rate, and this file closes it.
 *
 * JAVA ANALOGY
 *   AF.setValue is like calling a setter on a POJO: synchronous, and it
 *   either works or it does not. This file is like driving a Selenium
 *   WebDriver: you send an input event, then you WAIT for the UI thread
 *   to react and re-render, then you look at what appeared, then you send
 *   the next event. Everything here is therefore asynchronous and returns
 *   a Promise (Java: CompletableFuture).
 *
 * THE THREE RULES THIS FILE OBEYS
 *   1. Never guess. If no option's text convincingly matches the value we
 *      were asked for, we close the menu and report failure. Putting the
 *      wrong answer into a work-authorisation or veteran-status dropdown
 *      is far worse than leaving it empty.
 *   2. Never report success we have not seen with our own eyes. After
 *      clicking an option we re-read what the control DISPLAYS and only
 *      return true when it really changed.
 *   3. Never leave the page in a strange state. Any failure path presses
 *      Escape so the menu we opened is closed again.
 *
 * PUBLIC API
 *   AF.widgets.isCustomDropdown(el)          -> Boolean
 *   AF.widgets.detectWidgetKind(el)          -> 'react-select' | 'workday'
 *                                             | 'aria-combobox'
 *                                             | 'headless-listbox' | null
 *   AF.widgets.setCustomDropdown(el, value)  -> Promise<Boolean>
 *   AF.widgets.readDisplayedValue(el)        -> String   (bonus, see below)
 *   AF.widgets.LAST_ERROR                    -> String   (why we failed)
 * ===================================================================== */

/* The one and only global namespace, created defensively exactly like every
 * other module: whichever classic script runs first creates the object, the
 * rest reuse it. No ES modules, no imports — the manifest loads these files
 * in order as plain scripts. */
var AF = (globalThis.AF = globalThis.AF || {});

(function () {
  'use strict';

  /* The sub-namespace this file owns. Same defensive pattern one level down,
   * so load order can never wipe somebody else's work. */
  var widgets = (AF.widgets = AF.widgets || {});

  /**
   * Why the last setCustomDropdown() call returned false.
   *
   * This is a plain string property, deliberately NOT a function, because the
   * caller in content.js just wants to paste it into a report line. It is
   * reset to '' at the start of every setCustomDropdown() call, so reading it
   * after a `true` result always gives ''.
   *
   * IT HOLDS ONE MESSAGE, FROM THE MOST RECENT CALL.
   *   So the caller must fill dropdowns ONE AT A TIME — wait for the promise
   *   of dropdown A to settle and read LAST_ERROR before starting dropdown B.
   *   Firing several setCustomDropdown() calls in parallel would leave them
   *   overwriting each other's explanation. Sequential is what we want anyway:
   *   two menus open at once would fight over the keyboard focus.
   */
  widgets.LAST_ERROR = '';

  /* ===================================================================
   * SECTION 0 — tunable timings.
   *
   * All in milliseconds. They are named constants rather than magic numbers
   * sprinkled through the code so you have one place to make the extension
   * more patient on a slow machine or a slow corporate laptop.
   * =================================================================== */

  /* How long we are willing to wait for a menu to appear after clicking the
   * control. Two seconds is generous: Workday genuinely takes ~700ms to fetch
   * its option list from the server on a cold page. */
  var OPEN_BUDGET_MS = 2000;

  /* How long we wait for the menu after TYPING into a filtering combobox.
   * Same budget — the type-to-filter path usually triggers a network call. */
  var FILTER_BUDGET_MS = 2000;

  /* How long we wait for the control's own visible text to update after we
   * clicked an option. React re-renders asynchronously, so the DOM does not
   * change during the click — it changes one or two frames later. */
  var VERIFY_BUDGET_MS = 1500;

  /* A short pause after scrolling / focusing, to let a smooth scroll settle
   * and to let a widget mount the handlers it only attaches on focus.
   * The same reasoning as FOCUS_SETTLE_MS in lib/fill.js. */
  var SETTLE_MS = 120;

  /* Hard ceiling for the whole operation, used as a paranoia guard. If a page
   * somehow keeps us polling forever, we give up rather than hang the run. */
  var TOTAL_BUDGET_MS = 8000;

  /* ===================================================================
   * SECTION 1 — selectors describing what an "option" looks like.
   * =================================================================== */

  /**
   * Every way we know of that a library renders one clickable row of a menu.
   *
   * Ordered from most standard to most brand-specific:
   *   [role="option"]            the ARIA standard; react-select, Ashby,
   *                              Headless UI and modern Workday all use it
   *   [role="listbox"] li        older/simpler widgets that use a plain list
   *   [data-automation-id="promptOption"]  Workday's own row marker
   *   [class*="select__option"]  react-select's default BEM class
   *   [class*="-option"]         react-select with emotion-generated classes
   *                              (they look like "css-1n7v3ny-option")
   */
  var OPTION_SELECTOR = [
    '[role="option"]',
    '[role="listbox"] li',
    '[data-automation-id="promptOption"]',
    '[class*="select__option"]',
    '[class*="-option"]'
  ].join(', ');

  /**
   * Containers that hold a menu. Used when we need to search the whole page
   * because the library "portalled" its menu to the end of <body> (see the
   * long comment in collectVisibleOptions).
   */
  var MENU_SELECTOR = [
    '[role="listbox"]',
    '[class*="select__menu"]',
    '[class*="-menu"]',
    '[data-automation-id="activeListContainer"]'
  ].join(', ');

  /* ===================================================================
   * SECTION 2 — tiny generic helpers (strings, logging).
   *
   * DUPLICATION NOTE — asText / lower / normalise / isPlaceholderOption /
   * findMatchingOptionIndex below are COPIES of the private functions with
   * the same names in lib/fill.js. fill.js keeps them inside its IIFE and
   * exports none of them, and the hard constraints of this project forbid
   * any import mechanism, so the choice was: copy them, or reach into
   * another module's internals. Copying is the honest option.
   *
   * IF YOU CHANGE THE MATCHING RULES, CHANGE THEM IN BOTH FILES:
   *   lib/fill.js   -> findMatchingOptionIndex (used for real <select>)
   *   lib/widgets.js -> findMatchingOptionIndex (used for fake dropdowns)
   * Otherwise a real <select> and a fake dropdown asking the same question
   * would start giving different answers, which is exactly the kind of bug
   * nobody ever finds.
   * =================================================================== */

  /** Anything -> trimmed string. null/undefined -> ''. */
  function asText(anything) {
    if (anything === null || anything === undefined) {
      return '';
    }
    return String(anything).trim();
  }

  /** Trimmed and lower-cased, for case-insensitive comparisons. */
  function lower(anything) {
    return asText(anything).toLowerCase();
  }

  /**
   * Aggressive normalisation, identical to fill.js:
   * lower-case, every non alphanumeric character becomes a space, runs of
   * whitespace collapse, then trim. So "U.S. Citizen / Green-Card" and
   * "us citizen green card" compare equal.
   */
  function normalise(anything) {
    var text = lower(anything);
    var withoutPunctuation = text.replace(/[^a-z0-9 ]+/g, ' ');
    var collapsed = withoutPunctuation.replace(/\s+/g, ' ');
    return collapsed.trim();
  }

  /**
   * Record why we failed, and say it once in the console.
   *
   * Written straight onto AF.widgets (not into a closure variable) so the
   * caller genuinely sees the new value — assigning to a captured local would
   * leave AF.widgets.LAST_ERROR frozen at its initial ''.
   */
  function setLastError(message) {
    widgets.LAST_ERROR = asText(message);
    if (widgets.LAST_ERROR !== '') {
      // console.warn, not error: an unfillable exotic dropdown is expected,
      // not a bug in the extension.
      console.warn('[autofill][widgets] ' + widgets.LAST_ERROR);
    }
  }

  /** Read an attribute without ever throwing (some nodes are exotic). */
  function attr(el, name) {
    try {
      if (!el || typeof el.getAttribute !== 'function') {
        return '';
      }
      var value = el.getAttribute(name);
      return value === null || value === undefined ? '' : String(value);
    } catch (error) {
      return '';
    }
  }

  /** The element's class attribute as a plain lower-case string. */
  function classOf(el) {
    try {
      if (!el) {
        return '';
      }
      // SVG elements have a SVGAnimatedString as .className, not a string,
      // so go through the attribute, which is always text.
      return lower(attr(el, 'class'));
    } catch (error) {
      return '';
    }
  }

  /** Is this a real element node (not text, not a document, not null)? */
  function isElement(node) {
    return !!node && node.nodeType === 1;
  }

  /**
   * Does the element occupy space on screen?
   *
   * DUPLICATION NOTE: same two-signal check as hasLayoutBox in lib/scrape.js
   * (also private there). Both signals lie on their own:
   *   - offsetParent is null for display:none AND for position:fixed;
   *   - getClientRects().length is 0 for display:none.
   * Only when both say "nothing" do we believe the element is invisible.
   *
   * We additionally reject visibility:hidden and opacity:0, because a closed
   * react-select menu is frequently kept in the DOM that way — and clicking
   * an invisible option does nothing at all.
   */
  function isVisible(el) {
    try {
      if (!isElement(el)) {
        return false;
      }

      var hasOffsetParent = el.offsetParent !== null && el.offsetParent !== undefined;
      var rectCount = 0;
      if (typeof el.getClientRects === 'function') {
        rectCount = el.getClientRects().length;
      }
      if (!hasOffsetParent && rectCount === 0) {
        return false;
      }

      var view = (el.ownerDocument && el.ownerDocument.defaultView) || window;
      if (view && typeof view.getComputedStyle === 'function') {
        var style = view.getComputedStyle(el);
        if (style) {
          if (style.visibility === 'hidden' || style.display === 'none') {
            return false;
          }
          if (asText(style.opacity) === '0') {
            return false;
          }
        }
      }
      return true;
    } catch (error) {
      // If we cannot measure it, assume it is not usable.
      return false;
    }
  }

  /** Hidden from assistive tech (aria-hidden on the node or any ancestor). */
  function isAriaHidden(el) {
    var node = el;
    var guard = 0; // paranoia counter, stops any pathological loop
    while (isElement(node) && guard < 100) {
      guard++;
      if (attr(node, 'aria-hidden') === 'true') {
        return true;
      }
      node = node.parentElement;
    }
    return false;
  }

  /* ===================================================================
   * SECTION 3 — promise plumbing (delay, animation-frame polling).
   *
   * No libraries, no async/await — the rest of the codebase is written in
   * plain ES5-with-Promises style and this file matches it.
   * =================================================================== */

  /**
   * delay(ms) -> Promise that resolves after ms milliseconds.
   * Java analogy: CompletableFuture.runAsync with a delayed executor.
   */
  function delay(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  /**
   * Schedule a callback for the next repaint.
   *
   * requestAnimationFrame is the right tool for "wait until the browser has
   * had a chance to re-render": it fires exactly when the page has painted,
   * which is precisely the moment a newly-rendered menu becomes measurable.
   * setTimeout(16) is the fallback for environments without rAF.
   */
  function requestFrame(callback) {
    try {
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(callback);
        return;
      }
    } catch (error) {
      // fall through to the timer
    }
    setTimeout(callback, 16);
  }

  /**
   * pollUntil(testFn, budgetMs) -> Promise<result | null>
   *
   * Call testFn() once per animation frame until it returns something truthy,
   * or until the budget runs out (then null).
   *
   * WHY NOT A FIXED setTimeout?
   *   A fixed "wait 500ms then look" is wrong in both directions: it wastes
   *   half a second on a fast local page, and it is far too short for Workday
   *   fetching its country list over a corporate VPN. Polling gives us the
   *   best of both — we continue the instant the menu exists.
   *
   * WHY THE EXTRA setTimeout GUARD?
   *   requestAnimationFrame does NOT fire in a background (hidden) tab. If
   *   the user switches tabs mid-fill, the rAF chain silently stops and this
   *   promise would never settle, hanging the whole run. The guard timer is
   *   an independent clock that always resolves.
   */
  function pollUntil(testFn, budgetMs) {
    return new Promise(function (resolve) {
      var startedAt = Date.now();
      var finished = false;
      var guardTimer = null;

      function finish(result) {
        if (finished) {
          return;
        }
        finished = true;
        if (guardTimer !== null) {
          clearTimeout(guardTimer);
          guardTimer = null;
        }
        resolve(result);
      }

      // Independent clock, see the comment above. +250ms so it only ever
      // fires when the rAF loop itself has stopped running.
      guardTimer = setTimeout(function () {
        finish(null);
      }, budgetMs + 250);

      function tick() {
        if (finished) {
          return;
        }

        var result = null;
        try {
          result = testFn();
        } catch (error) {
          result = null;
        }

        if (result) {
          finish(result);
          return;
        }

        if (Date.now() - startedAt >= budgetMs) {
          finish(null);
          return;
        }

        requestFrame(tick);
      }

      requestFrame(tick);
    });
  }

  /* ===================================================================
   * SECTION 4 — synthetic events.
   *
   * WHY WE CANNOT JUST CALL el.click()
   * ----------------------------------
   * el.click() dispatches exactly ONE event: 'click'. Several dropdown
   * libraries never listen for click on their options:
   *   - react-select selects on 'mousedown' (so that the blur of the search
   *     input, which happens between mousedown and click, cannot cancel it);
   *   - Downshift / Headless UI listen for 'pointerdown' plus 'mouseup';
   *   - Workday tracks 'mousedown' then 'mouseup' on the same node.
   * A bare .click() on those widgets silently does nothing, which is the
   * classic "my automation clicked it and nothing happened" bug.
   *
   * So we replay the WHOLE sequence a real mouse produces, in the real order:
   *   pointerover -> mouseover -> pointermove -> mousemove
   *   -> pointerdown -> mousedown -> pointerup -> mouseup -> click
   * Sending extra events no library listens to is harmless; missing the one
   * it does listen to is fatal. Hence: send them all.
   * =================================================================== */

  /**
   * Build a MouseEvent. Falls back to a generic Event on ancient engines.
   * `buttons: 1` is what the browser sets while the left button is held down,
   * and a few libraries check it to ignore synthetic-looking events.
   */
  function makeMouseEvent(el, type) {
    var view = (el && el.ownerDocument && el.ownerDocument.defaultView) || window;
    var isPressed = type === 'mousedown' || type === 'pointerdown';
    try {
      return new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true, // so the event escapes a shadow root, like a real one
        view: view,
        detail: 1,
        button: 0,
        buttons: isPressed ? 1 : 0
      });
    } catch (error) {
      var fallback = document.createEvent('Event');
      fallback.initEvent(type, true, true);
      return fallback;
    }
  }

  /**
   * Build a PointerEvent, falling back to the equivalent MouseEvent when the
   * engine cannot construct one. Modern React uses pointer events first.
   */
  function makePointerEvent(el, type) {
    var view = (el && el.ownerDocument && el.ownerDocument.defaultView) || window;
    var isPressed = type === 'pointerdown';
    try {
      return new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: view,
        detail: 1,
        button: 0,
        buttons: isPressed ? 1 : 0,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true
      });
    } catch (error) {
      return makeMouseEvent(el, type);
    }
  }

  /**
   * Fire the full "a human clicked here" sequence on one element.
   * Returns true when every dispatch succeeded.
   */
  function fullClick(el) {
    try {
      if (!isElement(el)) {
        return false;
      }

      // 1. The hover phase. Some menus only mark a row "active" on hover and
      //    then commit the ACTIVE row on mouseup, so skipping hover can make
      //    the click land on whatever row was highlighted before.
      el.dispatchEvent(makePointerEvent(el, 'pointerover'));
      el.dispatchEvent(makeMouseEvent(el, 'mouseover'));
      el.dispatchEvent(makePointerEvent(el, 'pointermove'));
      el.dispatchEvent(makeMouseEvent(el, 'mousemove'));

      // 2. The press phase — the one react-select actually listens to.
      el.dispatchEvent(makePointerEvent(el, 'pointerdown'));
      el.dispatchEvent(makeMouseEvent(el, 'mousedown'));

      // 3. Focus. A real mousedown moves focus to the control; widgets that
      //    open on focus need this, and it costs nothing when they do not.
      try {
        if (typeof el.focus === 'function') {
          el.focus({ preventScroll: true });
        }
      } catch (focusError) {
        // Disabled or detached node; not fatal.
      }

      // 4. The release phase, then the click itself for everyone else.
      el.dispatchEvent(makePointerEvent(el, 'pointerup'));
      el.dispatchEvent(makeMouseEvent(el, 'mouseup'));
      el.dispatchEvent(makeMouseEvent(el, 'click'));

      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Send a keydown + keyup pair. Used for two things only:
   *   - ArrowDown, the universal "open this combobox" key, as a last-resort
   *     way to open a widget that ignored our click;
   *   - Escape, to close a menu we could not use.
   *
   * `key` is the modern property every framework reads; `keyCode` is the
   * deprecated one that older jQuery-era code still checks. We set both.
   */
  function pressKey(el, key, keyCode) {
    try {
      if (!isElement(el)) {
        return;
      }
      var view = (el.ownerDocument && el.ownerDocument.defaultView) || window;
      var options = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: view,
        key: key,
        code: key,
        keyCode: keyCode,
        which: keyCode
      };
      try {
        el.dispatchEvent(new KeyboardEvent('keydown', options));
        el.dispatchEvent(new KeyboardEvent('keyup', options));
      } catch (constructError) {
        var down = document.createEvent('Event');
        down.initEvent('keydown', true, true);
        el.dispatchEvent(down);
      }
    } catch (error) {
      // Never fatal.
    }
  }

  /* ===================================================================
   * SECTION 5 — DETECTION.
   *
   * We prefer STRUCTURAL signals (ARIA roles, which are a web standard) over
   * brand names (class names, which change whenever the vendor upgrades a
   * library). Brand checks exist only where there is no standard signal —
   * Workday being the main offender.
   * =================================================================== */

  /**
   * Walk up from `el` through at most `levels` ancestors, calling testFn on
   * each. Returns the first element for which testFn is true, else null.
   *
   * WHY A LIMIT?
   *   Without one, a plain text input inside a page whose <body> happens to
   *   carry role="listbox" would be reported as a dropdown. Three or four
   *   levels is the realistic distance between a combobox's inner input and
   *   its control wrapper.
   */
  function findAncestor(el, levels, testFn) {
    var node = el;
    var steps = 0;
    while (isElement(node) && steps <= levels) {
      if (testFn(node)) {
        return node;
      }
      node = node.parentElement;
      steps++;
    }
    return null;
  }

  /** Signal: Workday. Its markup is stamped with data-automation-id values. */
  function looksLikeWorkday(el) {
    var id = lower(attr(el, 'data-automation-id'));
    if (id === '') {
      return false;
    }
    // 'multiSelectContainer', 'promptOption', 'selectinput', anything with
    // 'dropdown' in it. Substring tests, because Workday keeps adding new
    // ones with the same stems.
    if (id.indexOf('dropdown') !== -1) {
      return true;
    }
    if (id.indexOf('selectinput') !== -1) {
      return true;
    }
    if (id.indexOf('multiselect') !== -1) {
      return true;
    }
    return false;
  }

  /**
   * Signal: react-select (and the many libraries that copy its class names).
   *   select__control      the default BEM theme
   *   react-select__...    the default classNamePrefix
   *   css-1s2u09g-control  emotion's generated class for the control
   */
  function looksLikeReactSelect(el) {
    var className = classOf(el);
    if (className === '') {
      return false;
    }
    if (className.indexOf('select__control') !== -1) {
      return true;
    }
    if (className.indexOf('react-select') !== -1) {
      return true;
    }
    // Emotion-generated: css-<hash>-control. Anchored on the '-control'
    // suffix so we do not match every element that merely contains "css-".
    if (/css-[a-z0-9]+-control/.test(className)) {
      return true;
    }
    return false;
  }

  /** Signal: the ARIA combobox pattern. This is the standards-based check. */
  function looksLikeAriaCombobox(el) {
    var role = lower(attr(el, 'role'));
    if (role === 'combobox') {
      return true;
    }
    if (lower(attr(el, 'aria-haspopup')) === 'listbox') {
      return true;
    }
    // aria-expanded alone is a weak signal (it is also used by accordions),
    // so we only accept it together with something that names a popup list.
    var hasExpanded = attr(el, 'aria-expanded') !== '';
    var ownsSomething = attr(el, 'aria-controls') !== '' || attr(el, 'aria-owns') !== '';
    if (hasExpanded && ownsSomething) {
      return true;
    }
    return false;
  }

  /** Signal: a listbox-shaped widget with no combobox role on top of it. */
  function looksLikeHeadlessListbox(el) {
    var role = lower(attr(el, 'role'));
    if (role === 'listbox') {
      return true;
    }
    // Headless UI and Radix mark their triggers with a state attribute and
    // point at the popup they own.
    if (attr(el, 'aria-expanded') !== '' && role === 'button') {
      return true;
    }
    return false;
  }

  /**
   * Signal: the "fake select" built from a readonly text input plus a chevron
   * button. There is no ARIA at all on these, so the shape IS the signal:
   * an <input readonly> whose parent also contains a button/arrow element.
   */
  function looksLikeReadonlyInputWithChevron(el) {
    try {
      if (!isElement(el)) {
        return false;
      }
      var tag = (el.tagName || '').toUpperCase();
      if (tag !== 'INPUT') {
        return false;
      }
      // Only a readonly (or explicitly non-typable) input qualifies. A normal
      // text input next to a button is just a search box.
      if (el.readOnly !== true) {
        return false;
      }

      var parent = el.parentElement;
      if (!isElement(parent)) {
        return false;
      }

      // Any button, or any element whose class hints at a chevron/arrow/caret,
      // sitting in the same wrapper.
      if (parent.querySelector('button')) {
        return true;
      }
      var decorated = parent.querySelector('[class*="chevron"], [class*="caret"], [class*="arrow"], svg');
      return !!decorated;
    } catch (error) {
      return false;
    }
  }

  /**
   * AF.widgets.detectWidgetKind(el) -> String | null
   *
   * Which family of fake dropdown is this, if any?
   *
   * Returns null for a plain text input, a real <select>, a checkbox, a
   * radio — anything AF.setValue already handles. The caller MUST treat null
   * as "use AF.setValue instead".
   *
   * Order matters: the most specific family wins, so that a Workday combobox
   * (which also carries role="combobox") is reported as 'workday' and gets
   * Workday's slower timings rather than being mistaken for a generic one.
   */
  widgets.detectWidgetKind = function (el) {
    try {
      if (!isElement(el)) {
        return null;
      }

      // A genuine <select> is never a custom dropdown — fill.js owns it.
      var tag = (el.tagName || '').toUpperCase();
      if (tag === 'SELECT') {
        return null;
      }
      // Nor is a checkbox / radio / file input.
      if (tag === 'INPUT') {
        var type = lower(el.type);
        if (type === 'checkbox' || type === 'radio' || type === 'file' || type === 'hidden') {
          return null;
        }
      }

      // --- 1. Workday ---------------------------------------------------
      // Check the element and up to 3 ancestors: Workday puts the automation
      // id on the wrapper, not on the inner input.
      if (findAncestor(el, 3, looksLikeWorkday)) {
        return 'workday';
      }

      // --- 2. react-select ----------------------------------------------
      if (findAncestor(el, 3, looksLikeReactSelect)) {
        return 'react-select';
      }

      // --- 3. the ARIA combobox pattern ---------------------------------
      // Two levels only: the role lives either on the input itself (ARIA 1.2)
      // or on the wrapper around it (ARIA 1.1).
      if (findAncestor(el, 2, looksLikeAriaCombobox)) {
        return 'aria-combobox';
      }

      // --- 4. a bare listbox / disclosure button ------------------------
      if (findAncestor(el, 2, looksLikeHeadlessListbox)) {
        return 'headless-listbox';
      }

      // --- 5. the no-ARIA "readonly input + chevron" fake select --------
      if (looksLikeReadonlyInputWithChevron(el)) {
        return 'headless-listbox';
      }

      // Nothing matched: this is a plain control, so the caller falls back
      // to AF.setValue. Saying "not sure, treat it as text" is always the
      // safe answer here.
      return null;
    } catch (error) {
      // A hostile or exotic node. Claiming "not a dropdown" makes the caller
      // use AF.setValue, which has its own guards. Safe.
      return null;
    }
  };

  /**
   * AF.widgets.isCustomDropdown(el) -> Boolean
   *
   * Convenience wrapper. Exists so call sites read as English:
   *     if (AF.widgets.isCustomDropdown(field.el)) { ... }
   */
  widgets.isCustomDropdown = function (el) {
    return widgets.detectWidgetKind(el) !== null;
  };

  /* ===================================================================
   * SECTION 6 — locating the parts of the widget.
   * =================================================================== */

  /**
   * The element we should CLICK to open the menu.
   *
   * The caller hands us whatever scrape.js found, which is usually the inner
   * <input>. Clicking the input often works, but clicking the CONTROL WRAPPER
   * is far more reliable — react-select attaches its open handler to the
   * wrapper, and Workday's clickable region is the wrapper too.
   */
  function findControlElement(el, kind) {
    var wrapper = null;

    if (kind === 'workday') {
      wrapper = findAncestor(el, 3, looksLikeWorkday);
    } else if (kind === 'react-select') {
      wrapper = findAncestor(el, 3, looksLikeReactSelect);
    } else if (kind === 'aria-combobox') {
      wrapper = findAncestor(el, 2, looksLikeAriaCombobox);
    } else if (kind === 'headless-listbox') {
      wrapper = findAncestor(el, 2, looksLikeHeadlessListbox);
    }

    // Fall back to the element itself — better to click something than
    // nothing, and for an ARIA 1.2 combobox the input IS the control.
    return wrapper || el;
  }

  /**
   * The typable <input> inside the control, or null when there is none.
   *
   * Used by the "type to filter" step. We deliberately exclude hidden inputs
   * (react-select keeps one to carry the submitted value) — typing into a
   * hidden input would do nothing and the value it holds is not ours to set
   * directly.
   */
  function findInnerInput(control, original) {
    try {
      // If the caller already handed us an input, prefer that one: it is the
      // node scrape.js decided represents the field.
      if (isElement(original)) {
        var originalTag = (original.tagName || '').toUpperCase();
        if (originalTag === 'INPUT' || originalTag === 'TEXTAREA') {
          return original;
        }
      }

      if (!isElement(control)) {
        return null;
      }
      var controlTag = (control.tagName || '').toUpperCase();
      if (controlTag === 'INPUT' || controlTag === 'TEXTAREA') {
        return control;
      }

      return control.querySelector('input:not([type="hidden"]), textarea');
    } catch (error) {
      return null;
    }
  }

  /**
   * Every menu container this control claims to own via aria-controls /
   * aria-owns. This is the standards-correct way to find a portalled menu
   * and it is exact, so we look here before we resort to scanning <body>.
   */
  function findOwnedMenus(control, innerInput) {
    var menus = [];
    var sources = [control, innerInput];
    var i;

    for (i = 0; i < sources.length; i++) {
      var source = sources[i];
      if (!isElement(source)) {
        continue;
      }

      // Both attributes can list SEVERAL ids separated by spaces.
      var ids = (attr(source, 'aria-controls') + ' ' + attr(source, 'aria-owns')).split(/\s+/);
      var j;
      for (j = 0; j < ids.length; j++) {
        var id = asText(ids[j]);
        if (id === '') {
          continue;
        }
        try {
          // getRootNode() so this also works inside an open shadow root,
          // where document.getElementById would find nothing.
          var root = source.getRootNode ? source.getRootNode() : document;
          var found = null;
          if (root && typeof root.getElementById === 'function') {
            found = root.getElementById(id);
          } else if (root && typeof root.querySelector === 'function') {
            found = root.querySelector('#' + cssEscape(id));
          }
          if (found && menus.indexOf(found) === -1) {
            menus.push(found);
          }
        } catch (error) {
          // Bad id, hostile page. Skip it.
        }
      }
    }
    return menus;
  }

  /**
   * CSS.escape with a guard, so a stray quote or a leading digit in an id
   * cannot break our selector string.
   * DUPLICATION NOTE: same helper as cssEscape in lib/fill.js.
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

  /* ===================================================================
   * SECTION 7 — finding the options that are on screen right now.
   * =================================================================== */

  /**
   * Collect every visible, enabled option row currently rendered for this
   * control.
   *
   * WHERE WE LOOK, AND WHY THE ORDER MATTERS
   *   1. inside the control's own subtree — the simple case;
   *   2. inside whatever the control says it owns via aria-controls/owns;
   *   3. anywhere in the document.
   *
   *   Step 3 is necessary because most menu libraries "portal" their popup:
   *   instead of rendering the menu next to the control, they append it to
   *   the end of <body>. They do that so the menu is not clipped by a parent
   *   with `overflow: hidden` and so its z-index is not trapped in a stacking
   *   context. The DOM consequence is that the menu is nowhere near its own
   *   combobox, and a subtree-only search finds nothing.
   *
   *   Step 3 is also the risky one: a different, unrelated widget elsewhere
   *   on the page could have options in the DOM. Two things keep us safe —
   *   we only reach step 3 when steps 1 and 2 found nothing, and every
   *   candidate must pass the visibility test, which a closed menu fails.
   *
   * @returns {Element[]} possibly empty, never null
   */
  function collectVisibleOptions(control, innerInput) {
    var results = [];

    function absorb(root) {
      if (!root || typeof root.querySelectorAll !== 'function') {
        return;
      }
      var found;
      try {
        found = root.querySelectorAll(OPTION_SELECTOR);
      } catch (error) {
        return;
      }
      var i;
      for (i = 0; i < found.length; i++) {
        var candidate = found[i];

        if (results.indexOf(candidate) !== -1) {
          continue; // already collected via another selector
        }
        if (!isVisible(candidate)) {
          continue; // a closed menu that is still in the DOM
        }
        if (isAriaHidden(candidate)) {
          continue; // deliberately hidden from users
        }
        if (lower(attr(candidate, 'aria-disabled')) === 'true') {
          continue; // greyed out; clicking it does nothing
        }
        if (candidate.disabled === true) {
          continue;
        }
        // A row with no words on it cannot be matched against a value, and
        // is usually a separator or a loading spinner.
        if (asText(candidate.textContent) === '') {
          continue;
        }

        results.push(candidate);
      }
    }

    // 1. the control's own subtree
    absorb(control);

    // 2. the menus the control says it owns
    if (results.length === 0) {
      var owned = findOwnedMenus(control, innerInput);
      var i;
      for (i = 0; i < owned.length; i++) {
        absorb(owned[i]);
      }
    }

    // 3. the whole document — the portalled-menu case
    if (results.length === 0) {
      var doc = (control && control.ownerDocument) || document;
      // Search inside recognised menu containers first, so that we prefer a
      // real popup over some random element that happens to have role=option.
      var menus;
      try {
        menus = doc.querySelectorAll(MENU_SELECTOR);
      } catch (error) {
        menus = [];
      }
      var m;
      for (m = 0; m < menus.length; m++) {
        if (isVisible(menus[m])) {
          absorb(menus[m]);
        }
      }

      // Absolute last resort: the entire body.
      if (results.length === 0 && doc.body) {
        absorb(doc.body);
      }
    }

    return results;
  }

  /**
   * Turn option ELEMENTS into the {text, value} descriptors the matching
   * cascade understands.
   *
   * `value` is taken from whichever machine-readable attribute the library
   * used, so that a profile holding a code ("VN") can still match a row whose
   * visible text is "Vietnam".
   */
  function describeOptions(optionElements) {
    var descriptors = [];
    var i;
    for (i = 0; i < optionElements.length; i++) {
      var el = optionElements[i];
      descriptors.push({
        text: asText(el.textContent),
        value:
          asText(attr(el, 'data-value')) ||
          asText(attr(el, 'value')) ||
          asText(attr(el, 'data-automation-label')) ||
          asText(attr(el, 'data-option-value')) ||
          '',
        el: el,
        domIndex: i
      });
    }
    return descriptors;
  }

  /* ===================================================================
   * SECTION 8 — the matching cascade.
   *
   * DUPLICATION NOTE (repeated here because this is the important one):
   * this is a copy of findMatchingOptionIndex / isPlaceholderOption from
   * lib/fill.js. Keep the two in step. See the note at SECTION 2.
   * =================================================================== */

  /**
   * Placeholder rows such as "-- Select --" must never be chosen as an
   * answer, so they are removed before matching.
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

  /**
   * Pick the option that answers `wanted`, or -1.
   *
   * Strictest rule first, loosening one step at a time:
   *   1. exact text,  case-insensitive
   *   2. exact value, case-insensitive
   *   3. "contains" either direction, case-insensitive
   *   4. normalised equality (punctuation stripped)
   *   5. normalised "contains" either direction
   *
   * There is deliberately no step 6 that picks the first option. Returning
   * -1 (leave it blank) is always better than a confident wrong answer.
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

    // --- 1. exact text ---------------------------------------------------
    for (i = 0; i < candidates.length; i++) {
      if (lower(candidates[i].text) === wantedRaw) {
        return i;
      }
    }

    // --- 2. exact value --------------------------------------------------
    for (i = 0; i < candidates.length; i++) {
      if (lower(candidates[i].value) === wantedRaw) {
        return i;
      }
    }

    // --- 3. contains, either direction -----------------------------------
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

    // --- 4 & 5. normalised equality, then normalised contains ------------
    if (wantedNorm !== '') {
      for (i = 0; i < candidates.length; i++) {
        if (normalise(candidates[i].text) === wantedNorm) {
          return i;
        }
        if (normalise(candidates[i].value) === wantedNorm) {
          return i;
        }
      }

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

  /* ===================================================================
   * SECTION 9 — reading back what the control now DISPLAYS.
   * =================================================================== */

  /**
   * AF.widgets.readDisplayedValue(el) -> String
   *
   * What does this control currently show to the user?
   *
   * This is the only honest way to verify a fake dropdown: there is no
   * .value to inspect, so we read the words on the screen.
   *
   * THE TRAP THIS FUNCTION AVOIDS
   *   If the menu is still open and happens to live INSIDE the control's
   *   subtree, then control.textContent contains every option's text —
   *   including the one we just clicked. Verification would then "succeed"
   *   for any value at all. So we walk the subtree ourselves and refuse to
   *   descend into anything that is a listbox, a menu or an option.
   *
   * Exported because content.js can use it to tell an untouched dropdown
   * ("Select...") from an answered one when deciding what to ask the user.
   */
  widgets.readDisplayedValue = function (el) {
    try {
      if (!isElement(el)) {
        return '';
      }

      var kind = widgets.detectWidgetKind(el);
      var control = findControlElement(el, kind || 'aria-combobox');
      var innerInput = findInnerInput(control, el);

      var pieces = [];

      // 1. A typable input's own value is the most direct signal. Workday's
      //    comboboxes keep the chosen label right here.
      if (isElement(innerInput)) {
        var typed = asText(innerInput.value);
        if (typed !== '') {
          pieces.push(typed);
        }
      }

      // 2. The visible text of the control, minus any open menu.
      pieces.push(collectVisibleTextExcludingMenus(control));

      // 3. The hidden input react-select submits with. Its content is a
      //    machine value ("VN"), which still verifies a "Vietnam" choice via
      //    the normalised comparison.
      if (isElement(control) && typeof control.querySelector === 'function') {
        var hidden = control.querySelector('input[type="hidden"]');
        if (hidden) {
          var hiddenValue = asText(hidden.value);
          if (hiddenValue !== '') {
            pieces.push(hiddenValue);
          }
        }
      }

      return asText(pieces.join(' '));
    } catch (error) {
      return '';
    }
  };

  /**
   * Depth-first text collection that stops at menu boundaries.
   * See the trap described in readDisplayedValue.
   */
  function collectVisibleTextExcludingMenus(root) {
    var collected = [];
    var guard = 0; // hard cap on nodes visited, so a huge subtree cannot stall us

    function isMenuish(node) {
      var role = lower(attr(node, 'role'));
      if (role === 'listbox' || role === 'option' || role === 'menu' || role === 'menuitem') {
        return true;
      }
      var className = classOf(node);
      if (className.indexOf('menu') !== -1 || className.indexOf('option') !== -1) {
        return true;
      }
      return false;
    }

    function walk(node) {
      if (!node || guard > 2000) {
        return;
      }
      guard++;

      if (node.nodeType === 3) {
        // Text node.
        var text = asText(node.nodeValue);
        if (text !== '') {
          collected.push(text);
        }
        return;
      }

      if (node.nodeType !== 1) {
        return;
      }

      // Do not descend into an open menu, and do not read hidden decoration.
      if (node !== root && isMenuish(node)) {
        return;
      }
      if (node !== root && attr(node, 'aria-hidden') === 'true') {
        return;
      }

      var children = node.childNodes;
      var i;
      for (i = 0; i < children.length; i++) {
        walk(children[i]);
      }
    }

    try {
      walk(root);
    } catch (error) {
      return '';
    }

    return asText(collected.join(' ').replace(/\s+/g, ' '));
  }

  /**
   * Does the control's displayed text now reflect `chosenText`?
   *
   * We compare with the same normalisation the matcher uses, and we accept
   * "contains" in either direction because:
   *   - the display often adds decoration ("Vietnam ✕" with a clear button);
   *   - the display sometimes truncates a long label.
   */
  function displayReflects(displayed, chosenText, wantedText) {
    var displayedNorm = normalise(displayed);
    if (displayedNorm === '') {
      return false;
    }

    var targets = [normalise(chosenText), normalise(wantedText)];
    var i;
    for (i = 0; i < targets.length; i++) {
      var target = targets[i];
      if (target === '') {
        continue;
      }
      if (displayedNorm === target) {
        return true;
      }
      if (displayedNorm.indexOf(target) !== -1) {
        return true;
      }
      // Truncated display: "United States of Am" inside "united states of america".
      if (target.indexOf(displayedNorm) !== -1 && displayedNorm.length >= 3) {
        return true;
      }
    }
    return false;
  }

  /* ===================================================================
   * SECTION 10 — closing the menu again.
   * =================================================================== */

  /**
   * Leave the page as we found it: press Escape (the universal "close this
   * popup" key), then blur.
   *
   * We send Escape to the inner input AND the control, because the key
   * handler may be attached to either one, and to the document as a final
   * fallback for libraries that listen globally.
   */
  function closeMenu(control, innerInput) {
    try {
      if (isElement(innerInput)) {
        pressKey(innerInput, 'Escape', 27);
      }
      if (isElement(control)) {
        pressKey(control, 'Escape', 27);
      }
      pressKey(document.body || document.documentElement, 'Escape', 27);

      // Blurring closes the handful of widgets that ignore Escape.
      try {
        if (isElement(innerInput) && typeof innerInput.blur === 'function') {
          innerInput.blur();
        } else if (isElement(control) && typeof control.blur === 'function') {
          control.blur();
        }
      } catch (blurError) {
        // Not fatal.
      }
    } catch (error) {
      // Never fatal: this is cleanup, not the job.
    }
  }

  /* ===================================================================
   * SECTION 11 — THE MAIN FLOW.
   * =================================================================== */

  /**
   * AF.widgets.setCustomDropdown(el, value) -> Promise<Boolean>
   *
   * Choose `value` in the fake dropdown that `el` belongs to.
   *
   * The promise NEVER rejects: it resolves true when the choice was made and
   * verified, and false otherwise. A rejected promise would force every call
   * site to write a catch, and one broken exotic widget must never abort a
   * run of forty fields. On false, AF.widgets.LAST_ERROR explains why.
   *
   * THE SEQUENCE (each step exists because a real ATS needs it):
   *   1. scroll the control into view — a click on an off-screen element is
   *      ignored by some libraries, and virtualised menus only render the
   *      rows near the viewport;
   *   2. click the control and POLL for the menu (never a fixed sleep);
   *   3. if no menu appeared, type the value in — many comboboxes render
   *      nothing until you filter — and poll again;
   *   4. match the visible option texts with the same cascade fill.js uses;
   *   5. click the winner with a full synthetic mouse sequence;
   *   6. re-read what the control displays and confirm;
   *   7. on any failure, press Escape so the page is left as found.
   */
  widgets.setCustomDropdown = function (el, value) {
    // A fresh call means a fresh explanation.
    setLastError('');

    var startedAt = Date.now();
    var control = null;
    var innerInput = null;

    try {
      if (!isElement(el)) {
        setLastError('no element was given');
        return Promise.resolve(false);
      }

      var wanted = asText(value);
      if (wanted === '') {
        setLastError('no value to choose (empty string)');
        return Promise.resolve(false);
      }

      var kind = widgets.detectWidgetKind(el);
      if (kind === null) {
        // The caller should have checked, but say so clearly rather than
        // fumbling around in a plain text input.
        setLastError('element is not a custom dropdown — use AF.setValue instead');
        return Promise.resolve(false);
      }

      if (el.disabled === true) {
        setLastError('the dropdown is disabled');
        return Promise.resolve(false);
      }

      control = findControlElement(el, kind);
      innerInput = findInnerInput(control, el);

      /* ---- STEP 1: bring it on screen, then let the scroll settle -------
       * block:'center' puts it in the middle so the menu, which usually
       * opens downwards, has room to render inside the viewport. We do NOT
       * use behavior:'smooth' here: a smooth scroll takes ~300ms during
       * which the element is still moving, and some libraries close a menu
       * that is opened mid-scroll. */
      try {
        if (typeof control.scrollIntoView === 'function') {
          control.scrollIntoView({ block: 'center', inline: 'nearest' });
        }
      } catch (scrollError) {
        try {
          control.scrollIntoView(true);
        } catch (ignored) {
          // Give up on scrolling; the click may still work.
        }
      }

      return delay(SETTLE_MS)
        .then(function () {
          /* ---- STEP 2: open the menu and wait for options ---------------- */
          fullClick(control);

          return pollUntil(function () {
            var options = collectVisibleOptions(control, innerInput);
            // pollUntil stops on the first TRUTHY result, and an empty array
            // is truthy in JavaScript, so return null when there is nothing.
            return options.length > 0 ? options : null;
          }, OPEN_BUDGET_MS);
        })
        .then(function (optionsAfterClick) {
          if (optionsAfterClick && optionsAfterClick.length > 0) {
            return optionsAfterClick;
          }

          /* ---- STEP 3a: nothing appeared — try typing to filter ---------
           * Many comboboxes (Greenhouse's location picker, Workday's country
           * prompt, any react-select with async options) render an EMPTY menu
           * until you type, because the option list is fetched per keystroke.
           *
           * We type through AF.setValue on purpose: it owns the native-setter
           * trick and the React value-tracker reset described at the top of
           * lib/fill.js. Re-implementing that here would mean two copies of
           * the single most fragile piece of logic in the extension. */
          if (!isElement(innerInput)) {
            return null; // nothing to type into
          }
          if (innerInput.readOnly === true || innerInput.disabled === true) {
            return null; // a readonly combobox cannot be filtered
          }
          if (typeof AF.setValue !== 'function') {
            setLastError('lib/fill.js is not loaded, cannot type into the combobox');
            return null;
          }

          // The `field` argument only needs .kind so setValue takes its text
          // path; the label is there to make any warning it logs readable.
          AF.setValue(innerInput, wanted, { kind: 'text', label: 'custom dropdown filter' });

          /* AF.setValue deliberately BLURS the element when it is done (many
           * ATSs only validate on blur). For a normal input that is right —
           * for a combobox it is actively harmful, because losing focus is
           * exactly what closes the menu. So we take focus straight back and
           * nudge the widget with a keystroke-shaped event, which is what a
           * human typing would have produced. */
          try {
            if (typeof innerInput.focus === 'function') {
              innerInput.focus({ preventScroll: true });
            }
          } catch (focusError) {
            // Not fatal.
          }
          pressKey(innerInput, 'ArrowDown', 40);

          return pollUntil(function () {
            var options = collectVisibleOptions(control, innerInput);
            return options.length > 0 ? options : null;
          }, FILTER_BUDGET_MS);
        })
        .then(function (optionsSoFar) {
          if (optionsSoFar && optionsSoFar.length > 0) {
            return optionsSoFar;
          }

          /* ---- STEP 3b: last resort — re-click and press ArrowDown ------
           * A few widgets treat our first click as "close" because they were
           * already open invisibly, and a few only ever open on ArrowDown
           * (that is the ARIA-recommended keyboard behaviour). One more
           * attempt costs a fraction of a second and rescues those. */
          if (Date.now() - startedAt > TOTAL_BUDGET_MS) {
            return null; // out of patience
          }

          fullClick(control);
          pressKey(isElement(innerInput) ? innerInput : control, 'ArrowDown', 40);

          return pollUntil(function () {
            var options = collectVisibleOptions(control, innerInput);
            return options.length > 0 ? options : null;
          }, OPEN_BUDGET_MS);
        })
        .then(function (optionElements) {
          /* ---- STEP 4: match ------------------------------------------- */
          if (!optionElements || optionElements.length === 0) {
            setLastError(
              'the option list never appeared for "' + wanted + '" (' + kind + ' widget)'
            );
            closeMenu(control, innerInput);
            return false;
          }

          var described = describeOptions(optionElements);

          // Drop "-- Select --" style rows: choosing one is never an answer.
          var candidates = [];
          var i;
          for (i = 0; i < described.length; i++) {
            if (!isPlaceholderOption(described[i])) {
              candidates.push(described[i]);
            }
          }

          var hit = findMatchingOptionIndex(candidates, wanted);
          if (hit === -1) {
            /* ---- STEP 7 (the no-match path): close and report ----------
             * We list a few of the option texts we saw, because that single
             * line in the log is what makes an unmatched field diagnosable
             * without opening devtools. */
            setLastError(
              'no option matched "' + wanted + '" among ' + candidates.length +
              ' option(s): ' + summariseOptions(candidates)
            );
            closeMenu(control, innerInput);
            return false;
          }

          var chosen = candidates[hit];

          /* ---- STEP 5: click the winning row ---------------------------
           * Scroll it into view first: menus are often virtualised, and a row
           * that is scrolled out of the menu's own overflow box can be
           * unclickable. block:'nearest' keeps the page itself still. */
          try {
            if (typeof chosen.el.scrollIntoView === 'function') {
              chosen.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            }
          } catch (scrollError) {
            // Not fatal.
          }

          fullClick(chosen.el);

          /* ---- STEP 6: verify ------------------------------------------
           * React re-renders asynchronously: immediately after the click the
           * DOM still shows the old text. So we poll for the display to catch
           * up rather than reading it once and wrongly declaring failure. */
          return pollUntil(function () {
            var displayed = widgets.readDisplayedValue(el);
            return displayReflects(displayed, chosen.text, wanted) ? displayed : null;
          }, VERIFY_BUDGET_MS).then(function (confirmedDisplay) {
            if (confirmedDisplay) {
              // Success. Some widgets keep the menu open for multi-select;
              // close it so the page looks the way the user left it.
              closeMenu(control, innerInput);
              setLastError('');
              return true;
            }

            setLastError(
              'clicked the option "' + chosen.text + '" but the control still shows "' +
              widgets.readDisplayedValue(el) + '" — treating it as not filled'
            );
            closeMenu(control, innerInput);
            return false;
          });
        })
        .catch(function (error) {
          // Any unexpected throw anywhere in the chain lands here.
          setLastError('unexpected error: ' + describeError(error));
          closeMenu(control, innerInput);
          return false;
        });
    } catch (error) {
      // A synchronous throw before the chain even started.
      setLastError('unexpected error: ' + describeError(error));
      closeMenu(control, innerInput);
      return Promise.resolve(false);
    }
  };

  /**
   * A short, safe, human-readable form of a caught error. `error` may be an
   * Error, a string, or something exotic a page threw at us.
   */
  function describeError(error) {
    try {
      if (!error) {
        return 'unknown';
      }
      if (error.message) {
        return String(error.message);
      }
      return String(error);
    } catch (nested) {
      return 'unknown';
    }
  }

  /**
   * First few option texts, comma separated, for the failure message.
   * Truncated so one enormous country list cannot flood the console.
   */
  function summariseOptions(candidates) {
    var MAX_SHOWN = 8;
    var parts = [];
    var i;
    for (i = 0; i < candidates.length && i < MAX_SHOWN; i++) {
      var text = candidates[i].text;
      if (text.length > 40) {
        text = text.slice(0, 40) + '...';
      }
      parts.push('"' + text + '"');
    }
    if (candidates.length > MAX_SHOWN) {
      parts.push('... and ' + (candidates.length - MAX_SHOWN) + ' more');
    }
    return parts.join(', ');
  }
})();
