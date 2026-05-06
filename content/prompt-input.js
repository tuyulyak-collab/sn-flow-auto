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
 *   - keydown for navigation/selection (Cmd+A, Backspace, Delete, etc.)
 * If we mutate the DOM directly (innerHTML / textNode append, or DOM-level
 * Range + execCommand("delete")) the text *appears* in the editor visually but
 * Slate's React-controlled model stays empty — Flow's submit handler sees an
 * empty prompt, AND React's reconciler later crashes with NotFoundError:
 * Failed to execute 'removeChild' on 'Node' because the DOM and the React
 * fiber tree have diverged.
 *
 * We therefore use ONLY Slate-friendly event dispatches:
 *   1) Focus + dispatch Ctrl+A keydown (Slate's keydown handler updates its
 *      selection model — does NOT touch the DOM).
 *   2) If editor is non-empty, dispatch beforeinput with
 *      inputType="deleteContentBackward" (Slate handles via its onBeforeInput
 *      handler — updates both DOM and React state in one transaction).
 *   3) Dispatch beforeinput with inputType="insertText" and data=text
 *      (Slate handles natively — single React update, reconciliation-safe).
 *      As a fallback, dispatch a paste event with ClipboardEvent +
 *      DataTransfer (Slate's onPaste handler).
 *
 * We deliberately do NOT call document.execCommand("delete") or
 * document.execCommand("insertText"), and do NOT mutate window.getSelection()
 * directly via Range.selectNodeContents on a Slate editor — those bypass
 * Slate's controlled model and corrupt React's reconciliation, leading to
 * the labs.google "Application error: a client-side exception has occurred"
 * page on the next render (verified May 2026).
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

  // Slate listens for keydown events to update its selection model. Dispatching
  // a Ctrl+A keydown causes Slate to set its internal selection to cover the
  // whole editor — without touching the DOM. This is the React-safe way to
  // "select all" inside a Slate editor; window.getSelection() + Range API is
  // NOT (it sets the DOM selection but Slate's controlled state stays stale,
  // and any subsequent execCommand("delete") corrupts React's fiber tree).
  function dispatchKey(el, key, opts = {}) {
    if (!el) return;
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform || "");
    const init = {
      key,
      code: opts.code || (key.length === 1 ? "Key" + key.toUpperCase() : key),
      keyCode: opts.keyCode || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0),
      which: opts.keyCode || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0),
      bubbles: true,
      cancelable: true,
      composed: true,
      ctrlKey: !isMac && !!opts.mod,
      metaKey: isMac && !!opts.mod,
      shiftKey: !!opts.shift,
    };
    try { el.dispatchEvent(new KeyboardEvent("keydown", init)); } catch (_) {}
    try { el.dispatchEvent(new KeyboardEvent("keyup", init)); } catch (_) {}
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

  // Returns the trimmed text Slate currently shows. Used to decide whether to
  // skip the clear step (empty editor → no clear needed).
  function isEmptyEditor(el) {
    if (!el) return true;
    if (placeholderStillShowing(el)) return true;
    const txt = (el.innerText || el.textContent || "").replace(/\s+/g, "");
    return !txt;
  }

  // Slate-safe clear. Each step routes through Slate's React-aware event
  // handlers — never via document.execCommand or direct DOM mutation. If
  // beforeinput is preventDefault'd, Slate took ownership and updated its
  // controlled state; if not, we fall back to a delete keydown which Slate
  // also handles via onKeyDown.
  function slateSafeClear(el) {
    if (!el) return;
    el.focus();
    if (isEmptyEditor(el)) return;
    // 1) Select all via keydown — Slate's keydown handler covers Cmd/Ctrl+A.
    dispatchKey(el, "a", { mod: true, code: "KeyA", keyCode: 65 });
    // 2) Delete the selection via beforeinput. Slate handles this and updates
    //    both DOM and React state in one transaction.
    try {
      el.dispatchEvent(new InputEvent("beforeinput", {
        bubbles: true, cancelable: true, composed: true,
        inputType: "deleteContentBackward",
      }));
    } catch (_) {}
    // 3) Backstop: if step 2 didn't clear (older Slate / non-Slate
    //    contenteditable), a Backspace keydown will. Slate listens for
    //    Backspace in its keydown handler and routes through Editor.deleteBackward.
    if (!isEmptyEditor(el)) {
      dispatchKey(el, "Backspace", { code: "Backspace", keyCode: 8 });
    }
  }

  // Insert text by dispatching a beforeinput event (Slate's primary input
  // observer). Slate's onBeforeInput handler calls Editor.insertText which
  // updates BOTH the DOM AND the React-controlled model in a single React
  // transaction. We do NOT call document.execCommand here — that would
  // mutate the DOM directly and desync React's fiber tree.
  function tryBeforeInputInsert(el, text) {
    try {
      const before = new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        composed: true,
        inputType: "insertText",
        data: text,
      });
      el.dispatchEvent(before);
      return true;
    } catch (_) {
      return false;
    }
  }

  // Insert text by simulating a paste. ClipboardEvent + DataTransfer is the
  // path Slate handles via its onPaste handler — it will call editor.insertText
  // (or insertFragment) which updates the React-controlled model. We do NOT
  // attempt the Object.defineProperty fallback for ClipboardEvent.clipboardData
  // — defining a non-configurable own property on an event whose prototype
  // exposes clipboardData via a getter can trip Slate's paste handler.
  function tryPasteInsert(el, text) {
    try {
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      const ev = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        composed: true,
        clipboardData: dt,
      });
      // If this Chrome build doesn't preserve clipboardData on synthetic
      // ClipboardEvent, abort — Slate's paste handler reads clipboardData
      // and would no-op without it. We'd rather fall through to another
      // strategy than override the property and risk a TypeError.
      if (!ev.clipboardData) return false;
      el.dispatchEvent(ev);
      return true;
    } catch (_) {
      return false;
    }
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

    // contenteditable / role=textbox / Slate path. Clear via Slate-safe events
    // ONCE up front (no execCommand, no Range manipulation), then try the two
    // remaining Slate-friendly insert strategies in order. We skip the
    // (DOM-mutating) execCommand insert strategy entirely — it was the cause
    // of "Application error: a client-side exception has occurred" on Flow
    // when the React reconciler later tried to remove DOM nodes that we'd
    // already mutated out from under it (NotFoundError: Failed to execute
    // 'removeChild' on 'Node').
    const isSlate = el.getAttribute("data-slate-editor") === "true";

    slateSafeClear(el);
    // Give Slate one frame to commit the clear before inserting.
    await new Promise((r) => setTimeout(r, 30));

    const strategies = isSlate
      ? [
          { name: "beforeinput", fn: tryBeforeInputInsert },
          { name: "paste", fn: tryPasteInsert },
        ]
      : [
          { name: "beforeinput", fn: tryBeforeInputInsert },
          { name: "paste", fn: tryPasteInsert },
        ];

    for (const s of strategies) {
      let ran = false;
      try {
        ran = s.fn(el, text);
      } catch (e) {
        if (Log && Log.warn) Log.warn("[SN Flow] prompt insert strategy threw", { name: s.name, e: String(e && e.message || e) });
        continue;
      }
      if (!ran) {
        if (Log && Log.warn) Log.warn("[SN Flow] prompt insert strategy declined", { name: s.name });
        continue;
      }
      const ok = await pollForCommit(el, text, 800);
      if (ok) {
        if (Log && Log.log) Log.log("[SN Flow] prompt fill ok", { strategy: s.name, len: text.length });
        return true;
      }
      if (Log && Log.warn) Log.warn("[SN Flow] prompt insert strategy did not commit; trying next", { name: s.name });
      // Re-clear before the next strategy so we don't append on top of a
      // partial first attempt. Slate-safe path only.
      slateSafeClear(el);
      await new Promise((r) => setTimeout(r, 30));
    }

    // Non-Slate contenteditable fallback: textNode append. We only do this
    // for elements that are explicitly NOT Slate — for Slate this would
    // corrupt the React fiber tree (the very bug we're fixing).
    if (!isSlate) {
      try {
        el.innerHTML = "";
        el.appendChild(document.createTextNode(text));
        el.dispatchEvent(new InputEvent("input", {
          bubbles: true, cancelable: false, composed: true,
          inputType: "insertText", data: text,
        }));
      } catch (_) {}
      const ok = await pollForCommit(el, text, 400);
      if (ok) return true;
    }

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
