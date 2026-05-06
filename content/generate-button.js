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

  // True when Slate's `[data-slate-placeholder="true"]` element is rendered
  // anywhere inside the prompt input — Slate only shows this when its
  // editor.children resolves to a single empty paragraph, which is what
  // Flow's submit handler does immediately after consuming a prompt. This
  // is a far more reliable "input cleared" signal than el.innerText, which
  // contains the zero-width-non-joiner (\ufeff) Slate uses to keep an
  // empty paragraph rendered, so a naive .trim() reads non-empty even when
  // the editor IS empty post-submit.
  function placeholderShowingNow(el) {
    if (!el) return false;
    try {
      const root = (el.closest && el.closest('[contenteditable="true"]')) || el.parentElement || el;
      if (!root) return false;
      // Slate writes data-slate-placeholder="true" on the placeholder span.
      const ph = root.querySelector('[data-slate-placeholder="true"]');
      if (ph && D.isVisible(ph)) return true;
    } catch (_) {}
    return false;
  }

  // Strip the zero-width characters Slate uses for empty-paragraph
  // rendering (\ufeff = BYTE ORDER MARK; \u200B = zero-width space) plus
  // ordinary whitespace. .trim() alone does NOT remove \ufeff, which is
  // why the previous "input cleared" check produced false negatives on
  // successful Slate submits.
  function isVisuallyEmpty(s) {
    return !String(s || "").replace(/[\s\u00a0\u200b\ufeff]+/g, "");
  }

  // After clicking submit, poll briefly for a visible signal that Flow
  // actually accepted the submission. Heuristics:
  //   - The prompt input clears (Flow blanks the bar after a successful submit)
  //   - The submit button becomes disabled / aria-disabled
  //   - A Flow validation toast surfaces ("Prompt must be provided" et al.)
  //
  // Order matters: we check POSITIVE signals first. A successful Slate
  // submission can momentarily race with a stale validation toast carried
  // over from earlier interactions — if we treated the toast as a hard
  // failure before noticing the input had already cleared, we'd retry on
  // an empty editor and produce a real validation error. So we only
  // trust the toast as a negative signal AFTER confirming the input did
  // not clear during the same poll iteration.
  async function verifySubmitted(promptEl, btn, beforeText, totalMs = 2500) {
    const start = Date.now();
    const beforeTrim = (beforeText || "").trim();
    while (Date.now() - start < totalMs) {
      await new Promise((r) => setTimeout(r, 120));

      // Positive signal A: prompt input cleared. For Slate this includes:
      //   - the placeholder span being re-rendered, OR
      //   - innerText becoming empty after stripping ZWSP/BOM that Slate
      //     uses to keep its empty-paragraph alive.
      try {
        if (promptEl) {
          if (placeholderShowingNow(promptEl)) {
            return { ok: true, signal: "input-cleared" };
          }
          const cur =
            promptEl.tagName === "TEXTAREA" || promptEl.tagName === "INPUT"
              ? String(promptEl.value || "")
              : String(promptEl.innerText || promptEl.textContent || "");
          if (beforeTrim && isVisuallyEmpty(cur)) {
            return { ok: true, signal: "input-cleared" };
          }
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

      // Negative signal: validation toast. Only checked after positive
      // signals failed for THIS iteration, so a stray "Prompt must be
      // provided" toast from a prior failed submit doesn't preempt
      // detection of a successful clear that happened simultaneously.
      const toast = findValidationToast();
      if (toast) return { ok: false, validationError: toast };
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

  async function clickGenerate(promptEl) {
    const Log = root.SNFlowLogger;
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

  root.SNFlowGenerate = { findGenerateButton, clickGenerate, describeButton };
})(typeof self !== "undefined" ? self : this);
