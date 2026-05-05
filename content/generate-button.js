/* content/generate-button.js — find and click the "Create" / submit button on Google Flow.
 *
 * DOM contract observed on labs.google/fx/tools/flow:
 *   <form>
 *     <button type="submit" ...>
 *       <i class="google-symbols">arrow_forward</i>
 *       <span style="position: absolute; ...; clip: rect(0 0 0 0); ...">Create</span>
 *     </button>
 *   </form>
 *   The "Create" text is visually hidden — only the arrow_forward icon is visible.
 *
 * We prefer (in order):
 *   1) a visible button[type="submit"] containing an icon glyph "arrow_forward"
 *      that is positionally near the prompt input
 *   2) any button containing the "arrow_forward" Material/Google Symbol glyph
 *   3) keyword + proximity scoring fallback (Generate / Create / Submit / Send)
 */
(function (root) {
  const D = root.SNFlowDom;
  const PI = root.SNFlowPromptInput;

  const POSITIVE_KEYWORDS = [
    "generate", "create", "submit", "send", "go", "produce", "render",
    "make", "run", "build",
  ];
  const NEGATIVE_KEYWORDS = [
    "cancel", "close", "back", "settings", "help", "menu",
    "sign in", "login", "account", "share", "copy", "delete",
    "more options", "more", "search",
  ];

  function hasIconText(btn, name) {
    if (!btn || !btn.querySelectorAll) return false;
    for (const i of btn.querySelectorAll("i, span")) {
      const t = (i.textContent || "").trim().toLowerCase();
      if (t === name) return true;
    }
    return false;
  }

  // Flow's submit button wraps its accessible label in a visually-hidden
  // span (clip:rect(0 0 0 0) / common sr-only utility classes). Detecting
  // this pattern boosts the *real* submit button over any other button that
  // happens to share its arrow_forward glyph (e.g. a future toolbar button
  // that uses the same Material symbol but renders the label as visible
  // text — that one would NOT have the visually-hidden wrapper).
  function hasVisuallyHiddenLabel(btn) {
    if (!btn || !btn.querySelectorAll) return false;
    try {
      for (const sp of btn.querySelectorAll("span")) {
        const cls = (sp.className || "").toString().toLowerCase();
        if (/(sr-only|visually-hidden|screen-reader|a11y-hidden)/.test(cls)) return true;
        const inline = (sp.getAttribute("style") || "").toLowerCase();
        if (/clip\s*:\s*rect\s*\(\s*0\s+0\s+0\s+0\s*\)/.test(inline)) return true;
        if (/clip-path\s*:\s*inset\s*\(\s*100%\s*\)/.test(inline)) return true;
      }
    } catch (_) {}
    return false;
  }

  function score(el, anchor) {
    let s = 0;
    const text = D.elText(el);
    for (const k of POSITIVE_KEYWORDS) if (text.includes(k)) s += 5;
    for (const k of NEGATIVE_KEYWORDS) if (text.includes(k)) s -= 8;

    // Flow-specific: arrow_forward Google Symbol icon glyph
    if (hasIconText(el, "arrow_forward")) s += 12;
    if (hasIconText(el, "play_arrow")) s += 8;
    if (hasIconText(el, "send")) s += 8;

    // SVG-icon fallback (other tools / future Flow refactors)
    if (!text) {
      const svg = el.querySelector && el.querySelector("svg");
      if (svg) {
        const svgText = (svg.outerHTML || "").toLowerCase();
        if (/(arrow|send|play|paper-plane|chevron-right|right)/.test(svgText)) s += 3;
      }
    }

    if (el.getAttribute && el.getAttribute("type") === "submit") s += 4;
    if (el.tagName === "BUTTON") s += 1;
    // a button living inside a <form> is much more likely to be Generate
    try { if (el.closest && el.closest("form")) s += 3; } catch (_) {}
    // visually-hidden a11y label is the strongest signal for Flow's submit:
    // toolbar / nav buttons render their label as visible text, so any
    // button with a sr-only label AND an arrow icon is almost certainly
    // the prompt-bar submit button.
    if (hasVisuallyHiddenLabel(el)) s += 6;

    if (anchor) {
      const d = D.distance(el, anchor);
      // closer = better, cap influence
      if (d < 600) s += Math.max(0, 5 - Math.floor(d / 120));
    }

    // Flow's prompt bar is near the bottom of the viewport
    try {
      const r = el.getBoundingClientRect();
      if (r.top > window.innerHeight * 0.55) s += 2;
    } catch (_) {}
    return s;
  }

  function findGenerateButton(promptEl) {
    const anchor = promptEl || (PI && PI.findPromptInput && PI.findPromptInput());
    const candidates = [];
    for (const el of D.queryAllDeep("button, [role='button'], input[type='submit']")) {
      if (D.isVisible(el) && D.isEnabled(el)) candidates.push(el);
    }
    if (!candidates.length) return null;

    const scored = candidates.map((el) => ({ el, score: score(el, anchor) }));
    scored.sort((a, b) => b.score - a.score);
    if (!scored[0] || scored[0].score <= 0) return null;
    return scored[0].el;
  }

  // Returns a small descriptor for logging — exposes the chosen button's
  // tag/role/text/icon glyphs so DOM-drift bugs are debuggable from the
  // Flow tab DevTools console without inspecting outerHTML by hand.
  function describeButton(btn) {
    if (!btn) return null;
    const text = (btn.innerText || btn.textContent || "").trim().slice(0, 40);
    const aria = btn.getAttribute("aria-label") || "";
    const type = btn.getAttribute("type") || "";
    const icons = [];
    try {
      for (const i of btn.querySelectorAll("i, span")) {
        const t = (i.textContent || "").trim();
        if (t && /^[a-z_]{3,30}$/i.test(t) && t.length < 24) icons.push(t);
      }
    } catch (_) {}
    return { tag: btn.tagName, type, aria, text, icons: icons.slice(0, 4) };
  }

  // Synthesise a full Enter key sequence on the prompt input. Many form-style
  // submit handlers (and Slate-driven editors) react to the Enter keystroke
  // even when our scoring picked the wrong "send" button.
  function pressEnter(el) {
    if (!el) return false;
    try {
      el.focus();
      const opts = {
        key: "Enter", code: "Enter", keyCode: 13, which: 13,
        bubbles: true, cancelable: true, composed: true,
      };
      el.dispatchEvent(new KeyboardEvent("keydown", opts));
      el.dispatchEvent(new KeyboardEvent("keypress", opts));
      el.dispatchEvent(new KeyboardEvent("keyup", opts));
      return true;
    } catch (_) {
      return false;
    }
  }

  // After clicking submit, poll briefly for a visible signal that Flow
  // actually accepted the submission. Heuristics:
  //   - The prompt input clears (Flow blanks the bar after a successful submit)
  //   - The submit button becomes disabled / aria-disabled
  //   - A Flow validation toast surfaces ("Prompt must be provided" et al.)
  //     We treat this as a *negative* signal — if it shows up, the click was
  //     received but the prompt wasn't in Slate's controlled state, so we
  //     return a sentinel telling the caller to surface a friendly error
  //     instead of waiting 5 minutes for media that will never arrive.
  async function verifySubmitted(promptEl, btn, beforeText, totalMs = 2500) {
    const start = Date.now();
    const beforeTrim = (beforeText || "").trim();
    while (Date.now() - start < totalMs) {
      await new Promise((r) => setTimeout(r, 120));

      // Negative signal: Flow's React tree crashed. Stop polling immediately
      // — no further click or Enter will recover, the user must reload.
      if (isFlowCrashed()) return { ok: false, flowCrashed: true };

      // Negative signal: validation toast.
      const toast = findValidationToast();
      if (toast) return { ok: false, validationError: toast };

      // Positive signal A: prompt input cleared.
      try {
        if (promptEl) {
          const cur = (
            promptEl.tagName === "TEXTAREA" || promptEl.tagName === "INPUT"
              ? String(promptEl.value || "")
              : String(promptEl.innerText || promptEl.textContent || "")
          ).trim();
          if (beforeTrim && !cur) return { ok: true, signal: "input-cleared" };
          // Some Flow surfaces leave the prompt visible but mark it readonly
          // / aria-busy after submit.
          const busy = promptEl.getAttribute("aria-busy") === "true"
            || promptEl.getAttribute("aria-readonly") === "true";
          if (busy) return { ok: true, signal: "input-busy" };
        }
      } catch (_) {}

      // Positive signal B: button became disabled (Flow disables the submit
      // button while a generation is in flight).
      try {
        if (btn && (btn.disabled || btn.getAttribute("aria-disabled") === "true")) {
          return { ok: true, signal: "button-disabled" };
        }
      } catch (_) {}
    }
    return { ok: false, signal: "no-signal" };
  }

  // Look for Flow's "Prompt must be provided" / similar validation toast in
  // any of the page's live regions or alert nodes. Returns the offending
  // text (truncated) or null. Matched against patterns conservatively to
  // avoid false positives from rate-limit / generation-error toasts (those
  // are handled separately by content/dom-error-watcher.js).
  const PROMPT_MISSING_RE =
    /(prompt\s+must\s+be\s+provided|please\s+(enter|provide)\s+(a\s+)?prompt|prompt\s+is\s+required|prompt\s+cannot\s+be\s+empty|enter\s+a\s+prompt)/i;

  function findValidationToast() {
    try {
      const sels = [
        '[role="alert"]',
        '[role="status"]',
        '[aria-live="assertive"]',
        '[aria-live="polite"]',
      ];
      for (const sel of sels) {
        for (const el of document.querySelectorAll(sel)) {
          if (!D.isVisible(el)) continue;
          const txt = (el.innerText || el.textContent || "").trim();
          if (!txt || txt.length < 5) continue;
          if (PROMPT_MISSING_RE.test(txt)) return txt.slice(0, 160);
        }
      }
    } catch (_) {}
    return null;
  }

  // Detect Flow's Next.js client-side crash overlay. When Flow's React tree
  // throws an unhandled exception during/after a submit, Next.js renders a
  // full-screen "Application error" placeholder that blocks the rest of the
  // app. Once this happens, retrying click/Enter is futile and our run loop
  // would just hammer the dead page until the result-watcher times out 5 min
  // later. Detecting it lets us throw a clear error so the user can reload.
  const FLOW_CRASH_RE =
    /application\s+error\s*:?\s*(a\s+)?client[-\s]side\s+exception\s+has\s+occurred(\s+while\s+loading\s+labs\.google)?/i;

  function isFlowCrashed() {
    try {
      // Next.js renders the crash overlay at body level. It's usually one of
      // a small set of nodes; check both body text (cheap) and any prominent
      // top-level <h1>/<h2>/<p> elements.
      const bodyTxt = (document.body && (document.body.innerText || document.body.textContent) || "").slice(0, 4000);
      if (FLOW_CRASH_RE.test(bodyTxt)) return true;
    } catch (_) {}
    return false;
  }

  async function clickGenerate(promptEl) {
    const Log = root.SNFlowLogger;

    // Pre-flight: if Flow's React tree has already crashed, every click and
    // keystroke we attempt will be ignored. Bail out with a clear error so
    // the user (or the run loop) can reload the tab instead of looping
    // through 3 retry attempts to a dead page.
    if (isFlowCrashed()) {
      throw new Error("Flow UI crashed: please reload the Flow tab");
    }

    const btn = findGenerateButton(promptEl);

    // Capture prompt-input value before submit so verifySubmitted can detect
    // a clear-on-submit signal.
    const beforeText = promptEl
      ? (promptEl.tagName === "TEXTAREA" || promptEl.tagName === "INPUT"
          ? String(promptEl.value || "")
          : String(promptEl.innerText || promptEl.textContent || ""))
      : "";

    let clickedVia = null;
    if (btn) {
      try { btn.scrollIntoView({ block: "center" }); } catch (_) {}
      const Settings = root.SNFlowSettings;
      if (Settings && typeof Settings.realClick === "function") {
        Settings.realClick(btn);
      } else {
        btn.click();
      }
      clickedVia = "button";
      if (Log && Log.log) Log.log("[SN Flow] generate: clicked button", describeButton(btn));
    } else if (Log && Log.warn) {
      Log.warn("[SN Flow] generate: no button matched, will fall back to Enter on prompt");
    }

    // First verification — did the button click do anything?
    let result = await verifySubmitted(promptEl, btn, beforeText, btn ? 2500 : 0);
    if (result.flowCrashed) {
      throw new Error("Flow UI crashed: please reload the Flow tab");
    }
    if (result.validationError) {
      throw new Error("Flow rejected submit: " + result.validationError);
    }
    if (result.ok) return true;

    // Fallback A: Enter keystroke on the prompt input. Many submit handlers
    // listen for Enter as the canonical form-submit action.
    if (promptEl) {
      pressEnter(promptEl);
      clickedVia = clickedVia ? clickedVia + "+enter" : "enter";
      if (Log && Log.log) Log.log("[SN Flow] generate: pressed Enter on prompt input as fallback");
      result = await verifySubmitted(promptEl, btn, beforeText, 2500);
      if (result.flowCrashed) {
        throw new Error("Flow UI crashed: please reload the Flow tab");
      }
      if (result.validationError) {
        throw new Error("Flow rejected submit: " + result.validationError);
      }
      if (result.ok) return true;
    }

    // Nothing worked. Treat as "button not found" — caller will retry.
    if (Log && Log.warn) {
      Log.warn("[SN Flow] generate: submit not detected after click and Enter fallback", { clickedVia });
    }
    return false;
  }

  root.SNFlowGenerate = { findGenerateButton, clickGenerate, describeButton, isFlowCrashed };
})(typeof self !== "undefined" ? self : this);
