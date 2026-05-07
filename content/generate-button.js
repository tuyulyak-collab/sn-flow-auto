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

    // Cross-PC fallback signals — different Flow A/B variants and locales
    // expose the submit button via these attribute hints. These are weak
    // bonuses by design so they only break a tie, never override the
    // strong arrow_forward / submit-type signals on the canonical layout.
    try {
      const ds = el.dataset || {};
      const tid = String(ds.testid || ds.testId || "").toLowerCase();
      if (/(generate|submit|send|create|prompt)/.test(tid)) s += 4;
      const aria = (el.getAttribute && (el.getAttribute("aria-label") || "")) || "";
      if (/^(generate|create|submit|send)\b/i.test(aria.trim())) s += 5;
    } catch (_) {}

    if (anchor) {
      const d = D.distance(el, anchor);
      // closer = better, cap influence
      if (d < 600) s += Math.max(0, 5 - Math.floor(d / 120));
      // Sibling-of-the-prompt-input bonus: on every Flow variant we've seen,
      // the submit button is rendered inside the same toolbar / form as the
      // prompt input. This bonus helps when the button has a non-canonical
      // glyph (e.g. localized icon font) but is otherwise correctly placed.
      try {
        if (el.closest && anchor.closest) {
          const sharedForm = el.closest("form");
          if (sharedForm && sharedForm === anchor.closest("form")) s += 4;
        }
      } catch (_) {}
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

  // Snapshot of what visual placeholder/loading affordances were on the
  // page before we clicked submit — used by verifySubmitted to detect a
  // *new* loading affordance appearing as a positive signal even when
  // the prompt input doesn't clear and the button doesn't disable on
  // some Flow A/B variants. Cross-PC variants observed in May 2026:
  //   - Flow image gen: a flower/pinhole skeleton tile fades in
  //   - Veo video gen: an aria-busy spinner appears in the gallery
  //   - aitestkitchen surface: a progress bar with role="progressbar"
  function loadingAffordancesNow() {
    const out = new Set();
    try {
      for (const el of document.querySelectorAll('[role="progressbar"]')) {
        if (D.isVisible && D.isVisible(el)) out.add(el);
      }
      for (const el of document.querySelectorAll('[aria-busy="true"]')) {
        if (D.isVisible && D.isVisible(el)) out.add(el);
      }
      // Skeleton/placeholder image tiles — these usually have a low naturalWidth
      // image with a recognisable URL pattern. We just count visible <img>
      // matches as a coarse signal; verifySubmitted only cares about deltas.
      for (const el of document.querySelectorAll("img")) {
        const src = el.currentSrc || el.src || "";
        if (/(flower-placeholder|pinhole|empty-state|skeleton|loading)/i.test(src) && D.isVisible(el)) {
          out.add(el);
        }
      }
    } catch (_) {}
    return out;
  }

  // After clicking submit, poll briefly for a visible signal that Flow
  // actually accepted the submission. Heuristics:
  //   - The prompt input clears (Flow blanks the bar after a successful submit)
  //   - The submit button becomes disabled / aria-disabled
  //   - A new loading/skeleton/progress affordance appears (Flow renders
  //     a placeholder tile while generating)
  //   - A Flow validation toast surfaces ("Prompt must be provided" et al.)
  //     We treat this as a *negative* signal — if it shows up, the click was
  //     received but the prompt wasn't in Slate's controlled state, so we
  //     return a sentinel telling the caller to surface a friendly error
  //     instead of waiting 5 minutes for media that will never arrive.
  //
  // totalMs default bumped from 2.5s → 5s because cross-PC reports show
  // Flow taking >3s to clear the prompt or disable the button on slower
  // hardware. The Slow PC mode toggle (popup → Settings) can multiply
  // this further via settings.compatTimeoutMultiplier.
  async function verifySubmitted(promptEl, btn, beforeText, totalMs = 5000) {
    const start = Date.now();
    const beforeTrim = (beforeText || "").trim();
    const loadingBefore = loadingAffordancesNow();
    while (Date.now() - start < totalMs) {
      await new Promise((r) => setTimeout(r, 120));

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

      // Positive signal C: a new loading affordance (placeholder tile,
      // progress bar, aria-busy region) appeared since we clicked. This
      // covers Flow A/B variants where the prompt input stays populated
      // and the button stays enabled but a skeleton tile materialises in
      // the gallery.
      try {
        const loadingNow = loadingAffordancesNow();
        for (const el of loadingNow) {
          if (!loadingBefore.has(el)) return { ok: true, signal: "loading-affordance" };
        }
      } catch (_) {}
    }
    // Build a richer no-signal description so the popup/log shows *why*
    // the verification gave up instead of an opaque [object Object].
    let curText = "";
    try {
      curText = promptEl
        ? (promptEl.tagName === "TEXTAREA" || promptEl.tagName === "INPUT"
            ? String(promptEl.value || "")
            : String(promptEl.innerText || promptEl.textContent || ""))
        : "";
    } catch (_) {}
    const stillFilled = curText.trim().length > 0;
    const btnDisabled = !!(btn && (btn.disabled || (btn.getAttribute && btn.getAttribute("aria-disabled") === "true")));
    return {
      ok: false,
      signal: "no-signal",
      reason: [
        "waited " + totalMs + "ms",
        "promptStillFilled=" + stillFilled,
        "buttonStillEnabled=" + (btn ? !btnDisabled : "no-button"),
        "newLoadingAffordance=false",
      ].join(", "),
    };
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

  async function clickGenerate(promptEl, opts) {
    const Log = root.SNFlowLogger;
    const btn = findGenerateButton(promptEl);

    // Per-attempt verification timeout — defaults match the new 5s baseline,
    // but the run loop can pass a higher value (e.g. when Slow PC mode is
    // on or for chained video steps that need more wait headroom).
    const verifyMs = (opts && opts.verifyMs) || 5000;

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
      if (Log && Log.log) Log.log("generate: clicked button", describeButton(btn));
    } else if (Log && Log.warn) {
      Log.warn("generate: no button matched, will fall back to Enter on prompt");
    }

    // First verification — did the button click do anything?
    let result = await verifySubmitted(promptEl, btn, beforeText, btn ? verifyMs : 0);
    if (result.validationError) {
      throw new Error("Flow rejected submit: " + result.validationError);
    }
    if (result.ok) return { ok: true, via: clickedVia, signal: result.signal };

    // Fallback A: Enter keystroke on the prompt input. Many submit handlers
    // listen for Enter as the canonical form-submit action.
    if (promptEl) {
      pressEnter(promptEl);
      clickedVia = clickedVia ? clickedVia + "+enter" : "enter";
      if (Log && Log.log) Log.log("generate: pressed Enter on prompt input as fallback");
      result = await verifySubmitted(promptEl, btn, beforeText, verifyMs);
      if (result.validationError) {
        throw new Error("Flow rejected submit: " + result.validationError);
      }
      if (result.ok) return { ok: true, via: clickedVia, signal: result.signal };
    }

    // Nothing worked. Surface a structured reason so the run loop /
    // System Check can show *why* — not just "[object Object]".
    const reason = (result && result.reason) || "no-signal";
    if (Log && Log.warn) {
      Log.warn("generate: submit not detected after click and Enter fallback", {
        clickedVia,
        button: describeButton(btn),
        reason,
      });
    }
    return { ok: false, via: clickedVia, reason, button: describeButton(btn) };
  }

  root.SNFlowGenerate = { findGenerateButton, clickGenerate, describeButton };
})(typeof self !== "undefined" ? self : this);
