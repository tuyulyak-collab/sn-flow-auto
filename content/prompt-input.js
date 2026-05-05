/* content/prompt-input.js — find the prompt input on Google Flow and write text into it.
 * Strategy:
 *   1) prefer visible role="textbox" / contenteditable elements with prompt-ish placeholders
 *   2) fallback to plain <textarea> elements
 *   3) write text using the appropriate API (value vs. textContent + InputEvent)
 * Robust to Shadow DOM via SNFlowDom.queryAllDeep.
 */
(function (root) {
  const D = root.SNFlowDom;

  const PROMPT_KEYWORDS = [
    "prompt", "describe", "your idea", "what do you want",
    "type", "imagine", "generate", "scene", "video", "image",
    "describe your", "describe the",
  ];

  function score(el) {
    let s = 0;
    const text = D.elText(el);
    for (const k of PROMPT_KEYWORDS) {
      if (text.includes(k)) s += 4;
    }
    if (el.tagName === "TEXTAREA") s += 3;
    if (el.getAttribute("role") === "textbox") s += 5;
    if (el.getAttribute("contenteditable") === "true") s += 4;
    // bigger boxes more likely to be prompt fields
    try {
      const r = el.getBoundingClientRect();
      if (r.width > 240) s += 1;
      if (r.height > 28) s += 1;
    } catch (_) {}
    // de-prioritize search inputs
    if (text.includes("search") || text.includes("filter")) s -= 6;
    return s;
  }

  function findPromptInput() {
    const candidates = [];

    for (const el of D.queryAllDeep('textarea')) {
      if (D.isVisible(el) && D.isEnabled(el)) candidates.push(el);
    }
    for (const el of D.queryAllDeep('[contenteditable="true"], [contenteditable=""]')) {
      if (D.isVisible(el) && D.isEnabled(el)) candidates.push(el);
    }
    for (const el of D.queryAllDeep('[role="textbox"]')) {
      if (D.isVisible(el) && D.isEnabled(el)) candidates.push(el);
    }
    for (const el of D.queryAllDeep('input[type="text"], input:not([type])')) {
      if (D.isVisible(el) && D.isEnabled(el)) candidates.push(el);
    }

    if (!candidates.length) return null;

    // dedupe + score + pick best (and break ties by area, larger wins)
    const seen = new Set();
    const scored = [];
    for (const el of candidates) {
      if (seen.has(el)) continue;
      seen.add(el);
      const r = el.getBoundingClientRect();
      scored.push({ el, score: score(el), area: r.width * r.height });
    }
    scored.sort((a, b) => (b.score - a.score) || (b.area - a.area));
    return scored[0] && scored[0].score > 0 ? scored[0].el : (scored[0] ? scored[0].el : null);
  }

  function fireInputEvents(el) {
    el.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
  }

  async function setPromptText(el, text) {
    if (!el) throw new Error("prompt input not found");

    el.focus();
    if (el.tagName === "TEXTAREA" || (el.tagName === "INPUT")) {
      // React-friendly value setter
      try {
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")
          || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
        if (nativeSetter && nativeSetter.set) {
          nativeSetter.set.call(el, "");
          fireInputEvents(el);
          nativeSetter.set.call(el, text);
        } else {
          el.value = text;
        }
      } catch (_) {
        el.value = text;
      }
      fireInputEvents(el);
      return true;
    }

    // contenteditable / role=textbox path
    el.innerHTML = "";
    // try execCommand insertText (works in many React-driven editors)
    let inserted = false;
    try {
      // @ts-ignore
      inserted = document.execCommand && document.execCommand("insertText", false, text);
    } catch (_) {}
    if (!inserted) {
      // manual fallback
      const node = document.createTextNode(text);
      el.appendChild(node);
      // place cursor at end
      try {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (_) {}
    }
    fireInputEvents(el);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    return true;
  }

  root.SNFlowPromptInput = { findPromptInput, setPromptText };
})(typeof self !== "undefined" ? self : this);
