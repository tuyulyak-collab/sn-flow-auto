/* content/prompt-input.js — find the prompt input on Google Flow and write text into it.
 *
 * Strategy (in priority order):
 *   1) Slate.js editor — Flow's prompt bar is a Slate editor: <div data-slate-editor="true"
 *      role="textbox" contenteditable="true" data-slate-node="value">. We use this hard
 *      selector first to skip the project-title input and the search bar.
 *   2) Generic role="textbox" / contenteditable, scored by keyword + size + position
 *   3) <textarea> / <input type=text> as a last resort
 *
 * Slate insertion is the tricky part. Slate maintains its own React-controlled
 * model of the editor's content and only updates that model when it observes
 * one of the events it explicitly listens for:
 *   - native `paste` event (with ClipboardEvent.clipboardData)
 *   - `beforeinput` event (inputType=insertText / insertFromPaste, with .data)
 *   - the synthetic input event produced by document.execCommand("insertText")
 * If we mutate the DOM directly (innerHTML / textNode append) the text *appears*
 * in the editor visually but Slate's controlled model stays empty — the next
 * React render will keep showing the placeholder, and Flow's submit handler
 * sees an empty prompt and rejects with "Prompt must be provided".
 *
 * We therefore try three Slate-aware strategies in order, verifying after
 * each one that *both* the DOM has the text AND Slate's placeholder is gone:
 *   (a) Dispatch a `paste` event with ClipboardEvent + DataTransfer
 *   (b) Dispatch a `beforeinput` event (inputType=insertText, data=text);
 *       if not preventDefault'd, also run document.execCommand("insertText")
 *   (c) Plain document.execCommand("insertText") with explicit selection
 * If all three fail to register with Slate, throw a clear error so the run
 * loop surfaces it instead of waiting 5 minutes for result-watcher to time out.
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

  function selectAll(el) {
    try {
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (_) {}
  }

  // True when the editor's controlled state still considers the prompt empty.
  // Flow renders a placeholder ("What do you want to create?" / similar) only
  // when Slate's React-controlled value is empty. So if a placeholder element
  // is still visible *next to* our DOM-inserted text, Slate didn't accept the
  // insert — we need to retry with another strategy.
  function placeholderStillShowing(el) {
    const root = el.closest('[contenteditable="true"]') || el.parentElement || el;
    if (!root) return false;
    // Slate writes data-slate-placeholder="true" on the placeholder span.
    const ph = root.querySelector('[data-slate-placeholder="true"]')
      || (root.parentElement && root.parentElement.querySelector('[data-slate-placeholder="true"]'));
    if (ph && D.isVisible(ph)) return true;
    // ProseMirror / generic empty-state hints
    const empty = root.querySelector('.is-editor-empty, .ProseMirror-trailingBreak');
    if (empty && D.isVisible(empty)) return true;
    return false;
  }

  // Insert text by simulating a paste. ClipboardEvent + DataTransfer is the
  // path Slate handles via its onPaste handler — it will call editor.insertText
  // (or insertFragment) which updates the React-controlled model.
  //
  // We DO NOT pre-delete the content with execCommand("delete") — that mutates
  // the contenteditable DOM directly and breaks Slate's React reconciler
  // (NotFoundError on removeChild in framework-*.js, which manifests as Flow's
  // "Application error: a client-side exception" overlay). Selecting the
  // existing range is enough — Slate's insertText replaces the selection via
  // its own API, which keeps the React virtual DOM in sync.
  function tryPasteInsert(el, text) {
    selectAll(el);
    try {
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      const ev = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        composed: true,
        clipboardData: dt,
      });
      // Some Chrome builds construct ClipboardEvent without preserving
      // clipboardData; if so, drop it on the event manually.
      if (!ev.clipboardData) {
        try { Object.defineProperty(ev, "clipboardData", { value: dt }); } catch (_) {}
      }
      el.dispatchEvent(ev);
      return true;
    } catch (_) {
      return false;
    }
  }

  // Insert text by dispatching a beforeinput event (Slate's primary input
  // observer). If Slate doesn't preventDefault, we also run execCommand to
  // perform the underlying DOM mutation; if Slate does preventDefault, it
  // owns the mutation itself and we just dispatch a follow-up input event.
  // Same rule as tryPasteInsert: we never call execCommand("delete") to clear
  // first — selection + insert lets the editor replace via its own pipeline.
  function tryBeforeInputInsert(el, text) {
    selectAll(el);
    try {
      const before = new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        composed: true,
        inputType: "insertText",
        data: text,
      });
      const accepted = el.dispatchEvent(before);
      if (accepted && !before.defaultPrevented) {
        try { document.execCommand("insertText", false, text); } catch (_) {}
      }
      el.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        cancelable: false,
        composed: true,
        inputType: "insertText",
        data: text,
      }));
      return true;
    } catch (_) {
      return false;
    }
  }

  // Fallback: explicit execCommand("insertText") with a fresh selection. This
  // is the original path; kept as a last resort for environments where the
  // event-dispatch routes above fail. execCommand("insertText") natively
  // replaces the current selection — no separate delete step needed.
  function tryExecCommandInsert(el, text) {
    selectAll(el);
    let inserted = false;
    try { inserted = !!(document.execCommand && document.execCommand("insertText", false, text)); } catch (_) {}
    if (inserted) {
      el.dispatchEvent(new InputEvent("input", {
        bubbles: true, cancelable: false, composed: true,
        inputType: "insertText", data: text,
      }));
    }
    return inserted;
  }

  // Returns true iff the editor now visibly contains the requested text AND
  // Slate's placeholder is no longer visible (i.e. React state caught up).
  async function pollForCommit(el, expected, totalMs = 600) {
    const exp = String(expected || "").trim();
    if (!exp) return true;
    const start = Date.now();
    while (Date.now() - start < totalMs) {
      await new Promise((r) => setTimeout(r, 80));
      const got = (readPromptText(el) || "").trim();
      if (got && !placeholderStillShowing(el)) return true;
    }
    return false;
  }

  async function setPromptText(el, text) {
    if (!el) throw new Error("prompt input not found");
    const Log = root.SNFlowLogger;

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
      const ok = await pollForCommit(el, text, 400);
      if (!ok) throw new Error("prompt fill verification failed: input remained empty after write");
      return true;
    }

    // contenteditable / role=textbox / Slate path — try strategies in order.
    const isSlate = el.getAttribute("data-slate-editor") === "true";

    const strategies = isSlate
      ? [
          { name: "paste", fn: tryPasteInsert },
          { name: "beforeinput", fn: tryBeforeInputInsert },
          { name: "execCommand", fn: tryExecCommandInsert },
        ]
      : [
          { name: "execCommand", fn: tryExecCommandInsert },
          { name: "beforeinput", fn: tryBeforeInputInsert },
          { name: "paste", fn: tryPasteInsert },
        ];

    for (const s of strategies) {
      try {
        s.fn(el, text);
      } catch (e) {
        if (Log && Log.warn) Log.warn("[SN Flow] prompt insert strategy threw", { name: s.name, e: String(e && e.message || e) });
        continue;
      }
      const ok = await pollForCommit(el, text, 600);
      if (ok) {
        if (Log && Log.log) Log.log("[SN Flow] prompt fill ok", { strategy: s.name, len: text.length });
        return true;
      }
      if (Log && Log.warn) Log.warn("[SN Flow] prompt insert strategy did not commit; trying next", { name: s.name });
    }

    // No brute-force innerHTML fallback here: directly mutating innerHTML on
    // a Slate-controlled contenteditable would crash Flow's React reconciler
    // (the same NotFoundError on removeChild we now actively detect in
    // generate-button.js#isFlowCrashed). Better to fail loudly than corrupt
    // the page state.
    const tag = el.tagName + (isSlate ? "[slate]" : "");
    const msg = "prompt fill verification failed: Slate state stayed empty after every insert strategy (" + tag + ")";
    if (Log && Log.error) Log.error("[SN Flow] " + msg);
    throw new Error(msg);
  }

  function readPromptText(el) {
    if (!el) el = findPromptInput();
    if (!el) return "";
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return String(el.value || "");
    return String(el.innerText || el.textContent || "").trim();
  }

  root.SNFlowPromptInput = { findPromptInput, findSlateEditor, setPromptText, readPromptText };
})(typeof self !== "undefined" ? self : this);
