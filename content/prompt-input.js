/* content/prompt-input.js — find the prompt input on Google Flow and write text into it.
 *
 * Strategy (in priority order):
 *   1) Slate.js editor — Flow's prompt bar is a Slate editor: <div data-slate-editor="true"
 *      role="textbox" contenteditable="true" data-slate-node="value">. We use this hard
 *      selector first to skip the project-title input and the search bar.
 *   2) Generic role="textbox" / contenteditable, scored by keyword + size + position
 *   3) <textarea> / <input type=text> as a last resort
 *
 * For the Slate editor we must clear the existing range and re-insert text via
 * document.execCommand("insertText"), which Slate observes as a beforeinput
 * event and renders correctly. We avoid touching innerHTML directly because that
 * detaches Slate's leaf nodes and React swallows the change.
 */
(function (root) {
  const D = root.SNFlowDom;

  const PROMPT_KEYWORDS = [
    "prompt", "describe", "your idea", "what do you want",
    "what do you want to create",
    "type", "imagine", "scene", "describe your", "describe the",
  ];

  function findSlateEditor() {
    // Flow uses a Slate.js editor: data-slate-editor="true". This is the prompt bar.
    const all = D.queryAllDeep('[data-slate-editor="true"]');
    let best = null;
    let bestArea = 0;
    for (const el of all) {
      if (!D.isVisible(el) || !D.isEnabled(el)) continue;
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      // pick the most prominent (largest visible) — Flow only renders one prompt
      // editor at a time, but be robust.
      if (area > bestArea) { best = el; bestArea = area; }
    }
    return best;
  }

  function score(el) {
    let s = 0;
    const text = D.elText(el);
    for (const k of PROMPT_KEYWORDS) {
      if (text.includes(k)) s += 4;
    }
    if (el.tagName === "TEXTAREA") s += 3;
    if (el.getAttribute("role") === "textbox") s += 5;
    if (el.getAttribute("contenteditable") === "true") s += 4;
    if (el.getAttribute("data-slate-editor") === "true") s += 12;
    if (el.getAttribute("aria-multiline") === "true") s += 2;
    try {
      const r = el.getBoundingClientRect();
      if (r.width > 240) s += 1;
      if (r.height > 28) s += 1;
      // Flow renders the prompt bar near the bottom of the viewport
      if (r.top > window.innerHeight * 0.5) s += 2;
    } catch (_) {}
    // de-prioritize search inputs / project title inputs at the top
    if (text.includes("search") || text.includes("filter")) s -= 8;
    if (text.includes("editable text")) s -= 6; // Flow's project title field
    if (el.dataset && el.dataset.testid && /search/i.test(el.dataset.testid)) s -= 8;
    return s;
  }

  function findPromptInput() {
    // Fast path: known Slate selector
    const slate = findSlateEditor();
    if (slate) return slate;

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

  function clearSlateEditor(el) {
    // Select the entire Slate value, then let insertText overwrite it.
    try {
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      // execCommand delete observes Slate's beforeinput
      try { document.execCommand("delete", false); } catch (_) {}
    } catch (_) {}
  }

  async function setPromptText(el, text) {
    if (!el) throw new Error("prompt input not found");

    el.focus();

    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      // React-friendly value setter
      try {
        const Proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(Proto, "value");
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

    // contenteditable / role=textbox / Slate path
    const isSlate = el.getAttribute("data-slate-editor") === "true";
    if (isSlate) clearSlateEditor(el);

    let inserted = false;
    try {
      // execCommand("insertText") triggers beforeinput → Slate accepts this and
      // renders the text correctly. Avoid touching innerHTML directly on Slate.
      inserted = document.execCommand && document.execCommand("insertText", false, text);
    } catch (_) {}
    if (!inserted) {
      // generic contenteditable fallback
      try { el.innerHTML = ""; } catch (_) {}
      const node = document.createTextNode(text);
      el.appendChild(node);
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

  function readPromptText(el) {
    if (!el) el = findPromptInput();
    if (!el) return "";
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return String(el.value || "");
    return String(el.innerText || el.textContent || "").trim();
  }

  root.SNFlowPromptInput = { findPromptInput, findSlateEditor, setPromptText, readPromptText };
})(typeof self !== "undefined" ? self : this);
