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

  async function clickGenerate(promptEl) {
    const btn = findGenerateButton(promptEl);
    if (!btn) {
      // last-ditch: try Enter key on the prompt
      if (promptEl) {
        const ev = new KeyboardEvent("keydown", {
          key: "Enter", code: "Enter", which: 13, keyCode: 13, bubbles: true,
        });
        promptEl.dispatchEvent(ev);
      }
      return false;
    }
    try { btn.scrollIntoView({ block: "center" }); } catch (_) {}
    // Use realClick (pointerdown + pointerup + click) because Radix/React
    // ignore .click() in some flows.
    const Settings = root.SNFlowSettings;
    if (Settings && typeof Settings.realClick === "function") {
      Settings.realClick(btn);
    } else {
      btn.click();
    }
    return true;
  }

  root.SNFlowGenerate = { findGenerateButton, clickGenerate };
})(typeof self !== "undefined" ? self : this);
