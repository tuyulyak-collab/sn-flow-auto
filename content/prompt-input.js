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
 * We deliberately do NOT call document.execCommand("delete") on a Slate
 * editor — that path removes DOM nodes that Slate's React tree references,
 * which corrupts React's reconciliation and causes the labs.google
 * "Application error: a client-side exception has occurred" page on the
 * next render (NotFoundError: removeChild, verified May 2026).
 *
 * document.execCommand("insertText") IS used as a fallback when the
 * synthetic beforeinput event isn't preventDefault'd by Slate — unlike the
 * delete variant, insertText only ADDS DOM nodes, which Slate's
 * MutationObserver picks up and reconciles into its controlled state. This
 * is the same path that Slate uses to ingest real keyboard input.
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

  // Set the DOM selection to the end of the editor's content (or to the
  // editor itself if it's empty). Slate listens to selectionchange and
  // will sync its controlled selection model. We deliberately collapse the
  // range — we never leave a non-collapsed Range covering live DOM nodes
  // because the next mutation could remove those nodes from underneath
  // React (the original crash signature).
  function setDomSelectionAtEnd(el) {
    try {
      el.focus();
      const range = document.createRange();
      // Walk to the deepest last child so the cursor sits AFTER any
      // existing text. For an empty Slate editor this is just el itself.
      let target = el;
      while (target && target.lastChild) target = target.lastChild;
      if (target && target.nodeType === 3 /* TEXT_NODE */) {
        const len = (target.nodeValue || "").length;
        range.setStart(target, len);
        range.setEnd(target, len);
      } else {
        range.selectNodeContents(target || el);
        range.collapse(false);
      }
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (_) {}
  }

  // Insert text by dispatching a beforeinput event (Slate's primary input
  // observer). Two-stage path:
  //   (a) Synthetic beforeinput — if Slate's onBeforeInput accepts it (calls
  //       preventDefault), Slate updates BOTH the DOM AND its React state
  //       in one transaction.
  //   (b) If Slate doesn't preventDefault (typical for synthetic events,
  //       which lack getTargetRanges()), we fall back to
  //       document.execCommand("insertText"). This fires a *native*
  //       beforeinput that Slate's onBeforeInput handler processes
  //       correctly, AND/OR triggers Slate's MutationObserver to ingest
  //       the resulting DOM changes into its React state.
  // Crucially, we do NOT call execCommand("delete") anywhere on a Slate
  // editor — that's the operation that corrupted React's fiber tree.
  // execCommand("insertText") only ADDS nodes and is safe.
  function tryBeforeInputInsert(el, text) {
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

  // Returns true iff Slate's React-controlled state now contains the
  // requested text. Critically, this checks for `data-slate-string="true"`
  // spans (only present when Slate's React render has actually committed
  // text to the DOM) — NOT just el.innerText, which can be transiently
  // populated by raw DOM mutations that React then overwrites on its next
  // render. The latter was the previous failure mode: pollForCommit
  // returned true while Slate's React state was still empty, so Flow's
  // submit handler kept seeing an empty prompt.
  async function pollForCommit(el, expected, totalMs = 600) {
    const exp = String(expected || "").trim();
    if (!exp) return true;
    const isSlate = el && el.getAttribute && el.getAttribute("data-slate-editor") === "true";
    const start = Date.now();
    while (Date.now() - start < totalMs) {
      await new Promise((r) => setTimeout(r, 80));
      if (isSlate) {
        // Strict check: collect text from Slate's rendered string spans.
        const spans = el.querySelectorAll('[data-slate-string="true"]');
        let slateText = "";
        for (const s of spans) slateText += s.textContent || "";
        slateText = slateText.replace(/\s+/g, " ").trim();
        const want = exp.replace(/\s+/g, " ").trim();
        if (!placeholderStillShowing(el) && slateText && (slateText === want || slateText.startsWith(want.slice(0, Math.min(want.length, 24))))) {
          return true;
        }
      } else {
        const got = (readPromptText(el) || "").trim();
        if (got && !placeholderStillShowing(el)) return true;
      }
    }
    return false;
  }

  // Dispatch a full real-pointer click sequence on `el` at its center. Slate's
  // onMouseDown handler reads the click target + mouse event coordinates to
  // set its internal `editor.selection`. Without a valid Slate selection,
  // any subsequent beforeinput / execCommand("insertText") is a no-op (Slate
  // doesn't know WHERE to insert). el.focus() alone is NOT sufficient — it
  // sets DOM focus but doesn't trigger Slate's mouse pathway, so
  // editor.selection stays null until the user actually clicks. This is why
  // the previous insertion strategies appeared to work (DOM had text, poll
  // verified it) but Slate's React state stayed empty (Flow's submit
  // handler reads editor.value which derives from React state, not DOM).
  function realClickEditor(el) {
    if (!el) return;
    try {
      const r = el.getBoundingClientRect();
      const x = r.left + Math.max(8, Math.min(r.width - 8, r.width / 2));
      const y = r.top + Math.max(8, Math.min(r.height - 8, r.height / 2));
      const init = {
        bubbles: true, cancelable: true, composed: true, view: window,
        clientX: x, clientY: y, screenX: x, screenY: y,
        button: 0, buttons: 1,
        pointerId: 1, pointerType: "mouse", isPrimary: true,
      };
      try { el.dispatchEvent(new PointerEvent("pointerover", init)); } catch (_) {}
      try { el.dispatchEvent(new MouseEvent("mouseover", init)); } catch (_) {}
      try { el.dispatchEvent(new PointerEvent("pointerdown", init)); } catch (_) {}
      try { el.dispatchEvent(new MouseEvent("mousedown", init)); } catch (_) {}
      try { el.focus(); } catch (_) {}
      try { el.dispatchEvent(new PointerEvent("pointerup", init)); } catch (_) {}
      try { el.dispatchEvent(new MouseEvent("mouseup", init)); } catch (_) {}
      try { el.dispatchEvent(new MouseEvent("click", init)); } catch (_) {}
    } catch (_) {}
  }

  // Last-resort fallback: inject a tiny <script> into the page context that
  // walks the React fiber tree from the Slate editor element to find
  // Slate's editor instance, then calls editor.insertText() directly.
  // This bypasses ALL event handling — it directly mutates Slate's
  // controlled state. We use this only when every event-driven strategy
  // has failed because it depends on React internals (16/17/18 fiber key
  // names: __reactFiber$, __reactInternalInstance$). The injected script
  // posts a CustomEvent back so we know whether it succeeded.
  function tryReactFiberInsert(el, text) {
    return new Promise((resolve) => {
      const ok = (e) => { cleanup(); resolve(!!(e && e.detail && e.detail.ok)); };
      const timer = setTimeout(() => { cleanup(); resolve(false); }, 1500);
      function cleanup() {
        clearTimeout(timer);
        document.removeEventListener("sn-flow-fiber-insert-result", ok);
      }
      document.addEventListener("sn-flow-fiber-insert-result", ok, { once: true });
      try {
        // We tag the target editor so the page-context script can find
        // exactly the same element we have a reference to.
        const tag = "data-sn-flow-target-" + Math.random().toString(36).slice(2, 8);
        el.setAttribute(tag, "1");
        const src = "(" + (function (selector, payload) {
          try {
            var node = document.querySelector(selector);
            if (!node) return done(false);
            var fiberKey = Object.keys(node).find(function (k) {
              return k.indexOf("__reactFiber") === 0 || k.indexOf("__reactInternalInstance") === 0;
            });
            if (!fiberKey) return done(false);
            var fiber = node[fiberKey];
            // Walk up looking for an object with `editor` (Slate stores it
            // on the EditableComponent instance as memoizedProps.editor or
            // stateNode.editor depending on version).
            var editor = null;
            for (var depth = 0; depth < 30 && fiber && !editor; depth++) {
              var mp = fiber.memoizedProps;
              if (mp && mp.editor && typeof mp.editor.insertText === "function") editor = mp.editor;
              else if (fiber.stateNode && fiber.stateNode.editor && typeof fiber.stateNode.editor.insertText === "function") editor = fiber.stateNode.editor;
              fiber = fiber.return;
            }
            if (!editor) return done(false);
            // Clear and insert via Slate's editor API — this updates
            // React state directly. Use Transforms when available.
            try {
              var Transforms = window.SlateTransforms || (editor.constructor && editor.constructor.Transforms) || null;
              if (Transforms && typeof Transforms.select === "function") {
                Transforms.select(editor, { anchor: editor.start([]), focus: editor.end([]) });
                editor.deleteFragment();
              } else if (typeof editor.delete === "function") {
                // editor.selection may be null — select all first.
                if (typeof editor.start === "function" && typeof editor.end === "function") {
                  editor.selection = { anchor: editor.start([]), focus: editor.end([]) };
                  editor.delete();
                }
              }
              editor.insertText(payload);
              editor.onChange && editor.onChange();
              return done(true);
            } catch (e) {
              return done(false);
            }
          } catch (e) {
            return done(false);
          }
          function done(ok) {
            document.dispatchEvent(new CustomEvent("sn-flow-fiber-insert-result", { detail: { ok: !!ok } }));
          }
        }).toString() + ")(" + JSON.stringify("[" + tag + ']') + ", " + JSON.stringify(text) + ");";
        const script = document.createElement("script");
        script.textContent = src;
        (document.head || document.documentElement).appendChild(script);
        script.remove();
        // Clean up the tag a moment later (the script ran already).
        setTimeout(function () { try { el.removeAttribute(tag); } catch (_) {} }, 50);
      } catch (_) {
        cleanup();
        resolve(false);
      }
    });
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

    // contenteditable / role=textbox / Slate path.
    //
    // For Slate (Flow's prompt bar), the only mutations that update both
    // the DOM AND Slate's React-controlled state are those that go through
    // Slate's own event handlers (onMouseDown, onKeyDown, onBeforeInput,
    // onPaste). Direct DOM mutations are picked up by Slate's MutationObserver
    // ONLY when Slate has a valid editor.selection — and Slate's selection
    // is null until a real pointer/keyboard event has set it. el.focus()
    // alone does NOT prime selection.
    //
    // Strategy order, each with a stricter pollForCommit (checks Slate's
    // data-slate-string spans, not just innerText):
    //   1. realClick on editor    → sets Slate selection
    //      Cmd+A keydown + Backspace keydown if not empty (Slate clears via onKeyDown)
    //      execCommand("insertText") → native beforeinput → Slate accepts
    //   2. realClick + synthetic beforeinput (insertText) with execCommand fallback
    //   3. realClick + ClipboardEvent paste with proper DataTransfer
    //   4. Page-context React fiber injection (calls editor.insertText directly)
    //
    // We DO NOT call execCommand("delete") on a Slate editor anywhere —
    // that path removed DOM nodes Slate's React tree referenced and caused
    // the labs.google "Application error" page (NotFoundError: removeChild,
    // verified May 2026). execCommand("insertText") only ADDS nodes and is
    // safe.
    const isSlate = el.getAttribute("data-slate-editor") === "true";

    // Step 1: real pointer click on the editor. Slate's onMouseDown sets
    // editor.selection to the click point. Without this, every subsequent
    // insertion strategy is no-op at the Slate-state level even though it
    // may briefly mutate the DOM.
    realClickEditor(el);
    await new Promise((r) => setTimeout(r, 80));

    // Step 2: Slate-safe clear via keydown events. With selection now
    // valid, Cmd+A + Backspace clears Slate's React state cleanly.
    if (isSlate) {
      if (!isEmptyEditor(el)) {
        dispatchKey(el, "a", { mod: true, code: "KeyA", keyCode: 65 });
        await new Promise((r) => setTimeout(r, 30));
        dispatchKey(el, "Backspace", { code: "Backspace", keyCode: 8 });
        await new Promise((r) => setTimeout(r, 50));
      }
    } else {
      slateSafeClear(el);
      await new Promise((r) => setTimeout(r, 30));
    }

    // Step 3: ensure DOM selection is collapsed at end (defensive). Slate
    // mirrors this via selectionchange.
    setDomSelectionAtEnd(el);
    await new Promise((r) => setTimeout(r, 10));

    // Strategy 1: execCommand("insertText") directly (now that selection is set).
    // This is the path Slate uses to ingest real keyboard input — a native
    // beforeinput fires that Slate's onBeforeInput handler processes.
    if (isSlate) {
      try { el.focus(); } catch (_) {}
      try { document.execCommand("insertText", false, text); } catch (_) {}
      const ok = await pollForCommit(el, text, 800);
      if (ok) {
        if (Log && Log.log) Log.log("[SN Flow] prompt fill ok", { strategy: "execCommand", len: text.length });
        return true;
      }
      if (Log && Log.warn) Log.warn("[SN Flow] execCommand insertText did not commit; trying next");
      // Re-clear before next strategy.
      realClickEditor(el);
      await new Promise((r) => setTimeout(r, 60));
      if (!isEmptyEditor(el)) {
        dispatchKey(el, "a", { mod: true, code: "KeyA", keyCode: 65 });
        await new Promise((r) => setTimeout(r, 30));
        dispatchKey(el, "Backspace", { code: "Backspace", keyCode: 8 });
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    const strategies = [
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
      realClickEditor(el);
      await new Promise((r) => setTimeout(r, 60));
      if (!isEmptyEditor(el)) {
        dispatchKey(el, "a", { mod: true, code: "KeyA", keyCode: 65 });
        await new Promise((r) => setTimeout(r, 30));
        dispatchKey(el, "Backspace", { code: "Backspace", keyCode: 8 });
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    // Strategy 4: page-context React fiber injection (last resort).
    if (isSlate) {
      if (Log && Log.warn) Log.warn("[SN Flow] event-driven strategies all failed; trying React fiber injection");
      const fiberOk = await tryReactFiberInsert(el, text);
      if (fiberOk) {
        const committed = await pollForCommit(el, text, 800);
        if (committed) {
          if (Log && Log.log) Log.log("[SN Flow] prompt fill ok", { strategy: "reactFiber", len: text.length });
          return true;
        }
      }
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
