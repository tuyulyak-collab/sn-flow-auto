/* content/generate-button.js — find and click the "Generate" / "Create" button on Google Flow.
 * Strategy:
 *   - look at all buttons / role=button elements
 *   - score by text/aria-label keywords ("generate", "create", "send", "submit", arrow-right icons)
 *   - prefer buttons close to the prompt input (positionally)
 *   - retry with click + form submit fallback
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
  ];

  function score(el, anchor) {
    let s = 0;
    const text = D.elText(el);
    for (const k of POSITIVE_KEYWORDS) if (text.includes(k)) s += 5;
    for (const k of NEGATIVE_KEYWORDS) if (text.includes(k)) s -= 8;

    // icon-only buttons: look for arrow / send / play SVGs
    if (!text) {
      const svg = el.querySelector && el.querySelector("svg");
      if (svg) {
        const svgText = (svg.outerHTML || "").toLowerCase();
        if (/(arrow|send|play|generate|paper-plane|chevron-right|right)/.test(svgText)) s += 3;
      }
    }

    if (el.getAttribute && el.getAttribute("type") === "submit") s += 4;
    if (el.tagName === "BUTTON") s += 1;

    if (anchor) {
      const d = D.distance(el, anchor);
      // closer = better, cap influence
      if (d < 600) s += Math.max(0, 5 - Math.floor(d / 120));
    }
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
      // last-ditch: try Enter key on prompt
      if (promptEl) {
        const ev = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", which: 13, keyCode: 13, bubbles: true });
        promptEl.dispatchEvent(ev);
      }
      return false;
    }
    try {
      btn.scrollIntoView({ block: "center" });
    } catch (_) {}
    btn.click();
    return true;
  }

  root.SNFlowGenerate = { findGenerateButton, clickGenerate };
})(typeof self !== "undefined" ? self : this);
