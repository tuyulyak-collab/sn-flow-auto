/* content/flow-add-media.js — attach an image to Google Flow as the input
 * for an Image-to-Video generation step (Chain mode, PR #7).
 *
 * Public API:
 *   SNFlowAddMedia.attachInputImage(mediaUrl, opts) -> Promise<{ok: boolean, via: string}>
 *     opts = { filename?: string, timeout?: number }
 *
 * Strategy (best-effort, multiple fallbacks):
 *   1. Resolve the image to a Blob:
 *      - Try `fetch(mediaUrl)` from the content-script context (which inherits
 *        page cookies, so authenticated Flow CDN URLs usually work).
 *      - If that throws (CORS / network), fall back to a background-fetched
 *        blob via chrome.runtime.sendMessage({type: "SN_FLOW_FETCH_BLOB", url}).
 *   2. Click Flow's "Add Media" / image input affordance to open the file
 *      picker, OR find the existing <input type=file> directly. Programmatically
 *      assign the file via DataTransfer.
 *   3. Fallbacks if the file-input path fails:
 *      a. Synthetic `paste` ClipboardEvent with DataTransfer.files = [file]
 *         on the prompt textarea (Flow's prompt is a rich-text input that
 *         accepts pasted images on labs.google).
 *      b. Synthetic `drop` event on the prompt-area drop zone.
 *
 * NOTE: Flow's exact DOM for image input is undocumented and may shift. This
 * module is intentionally defensive and emits a clear error if no strategy
 * succeeded so the run loop can mark the chain video step `failed` rather
 * than silently produce an unconditioned video.
 */
(function (root) {
  const D = root.SNFlowDom;
  const Retry = root.SNFlowRetry;
  const Log = root.SNFlowLogger;
  const PromptInput = root.SNFlowPromptInput;

  // --------- blob fetch ---------

  async function fetchAsBlob(url) {
    if (!url) throw new Error("attachInputImage: empty url");
    // 1) page-context fetch
    try {
      const r = await fetch(url, { credentials: "include", mode: "cors" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.blob();
    } catch (e) {
      Log && Log.warn && Log.warn("[SN Flow] page fetch failed, asking SW", String(e && e.message || e));
    }
    // 2) background SW fetch — uses the SW's fetch (different CORS context).
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: "SN_FLOW_FETCH_BLOB", payload: { url } }, (resp) => {
          const err = chrome.runtime && chrome.runtime.lastError;
          if (err) return reject(new Error(err.message));
          if (!resp || !resp.ok || !resp.dataUrl) return reject(new Error((resp && resp.error) || "SW fetch failed"));
          // dataUrl -> blob (synchronous-ish via fetch())
          fetch(resp.dataUrl).then((r) => r.blob()).then(resolve, reject);
        });
      } catch (e) { reject(e); }
    });
  }

  function blobToFile(blob, filename) {
    const safeName = filename && /\.\w{2,5}$/.test(filename) ? filename : (filename || "input") + extFromMime(blob.type);
    try {
      return new File([blob], safeName, { type: blob.type || "image/png" });
    } catch (_) {
      // Older Chromium WebView fallback
      const f = new Blob([blob], { type: blob.type || "image/png" });
      f.name = safeName;
      f.lastModified = Date.now();
      return f;
    }
  }

  function extFromMime(mime) {
    if (!mime) return ".png";
    const m = mime.toLowerCase();
    if (m.includes("jpeg") || m.includes("jpg")) return ".jpg";
    if (m.includes("webp")) return ".webp";
    if (m.includes("gif")) return ".gif";
    if (m.includes("png")) return ".png";
    if (m.includes("mp4")) return ".mp4";
    return ".png";
  }

  // --------- DOM affordances ---------

  // Find Flow's "Add media" / image-attach trigger button. This sits next to
  // (or inside) the prompt input bar. We look for buttons with image-add
  // material icons or aria-labels containing "image" / "media" / "attach".
  function findAddMediaButton() {
    const buttons = D.queryAllDeep('button, [role="button"]');
    let best = null; let bestScore = -Infinity;
    for (const el of buttons) {
      if (!D.isVisible(el) || !D.isEnabled(el)) continue;
      const aria = (el.getAttribute("aria-label") || "").toLowerCase();
      const text = (el.innerText || el.textContent || "").toLowerCase();
      const html = (el.innerHTML || "").toLowerCase();
      const r = el.getBoundingClientRect();
      let s = 0;
      if (/(add[ _-]?media|attach|upload|image|reference|photo)/i.test(aria)) s += 8;
      if (/(add[ _-]?media|attach|upload|reference|photo)/i.test(text)) s += 4;
      // Material icon names that Flow has historically used for media-add affordances
      if (/(add_photo_alternate|image|attach_file|imagesmode|photo_camera)/i.test(html)) s += 6;
      // Avoid matching "Generate" / send buttons
      if (/(generate|send|submit|forward)/i.test(aria + " " + text)) s -= 8;
      // Bottom-of-page bias — prompt bar is near the bottom
      if (r.top > window.innerHeight * 0.55) s += 1;
      if (s > bestScore) { bestScore = s; best = el; }
    }
    return bestScore > 4 ? best : null;
  }

  function findFileInput() {
    // Flow may have a hidden <input type=file accept="image/*"> we can target
    // directly without clicking the menu trigger.
    const inputs = D.queryAllDeep('input[type="file"]');
    for (const inp of inputs) {
      const accept = (inp.getAttribute("accept") || "").toLowerCase();
      if (!accept || accept.includes("image") || accept === "*/*") return inp;
    }
    return null;
  }

  function findPromptDropZone() {
    // The prompt textarea (or its container) accepts paste/drop of images.
    if (PromptInput && PromptInput.findPromptInput) {
      const el = PromptInput.findPromptInput();
      if (el) return el;
    }
    // Fallback: any contentEditable in the bottom half of the page
    const editables = D.queryAllDeep('[contenteditable="true"], textarea');
    for (const el of editables) {
      if (!D.isVisible(el) || !D.isEnabled(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.top > window.innerHeight * 0.4) return el;
    }
    return null;
  }

  // --------- attach strategies ---------

  function makeDataTransfer(file) {
    const dt = new DataTransfer();
    try { dt.items.add(file); } catch (_) {}
    return dt;
  }

  async function viaFileInput(file) {
    // Strategy A: assign file directly to a discovered file input.
    const inp = findFileInput();
    if (!inp) return false;
    try {
      const dt = makeDataTransfer(file);
      // Override the read-only `files` accessor via descriptor
      Object.defineProperty(inp, "files", {
        configurable: true, enumerable: true,
        get() { return dt.files; },
      });
      // Re-fire change event so React picks it up
      inp.dispatchEvent(new Event("input", { bubbles: true }));
      inp.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } catch (e) {
      Log && Log.warn && Log.warn("[SN Flow] viaFileInput failed", String(e && e.message || e));
      return false;
    }
  }

  async function viaAddMediaClickThenInput(file) {
    // Strategy B: click "Add Media" trigger, then assign file to whatever
    // <input type=file> appears as a result.
    const btn = findAddMediaButton();
    if (!btn) return false;
    try {
      // Best-effort suppress the OS file dialog by hijacking the
      // `<input>.click()` call — when Flow lazily creates the input we
      // intercept and assign files programmatically.
      const origClick = HTMLInputElement.prototype.click;
      let intercepted = false;
      HTMLInputElement.prototype.click = function () {
        if (this.type === "file" && !intercepted) {
          intercepted = true;
          try {
            const dt = makeDataTransfer(file);
            Object.defineProperty(this, "files", {
              configurable: true, enumerable: true,
              get() { return dt.files; },
            });
            this.dispatchEvent(new Event("input", { bubbles: true }));
            this.dispatchEvent(new Event("change", { bubbles: true }));
          } catch (_) {}
          return; // swallow native click
        }
        return origClick.apply(this, arguments);
      };
      try {
        btn.click();
      } finally {
        // restore quickly so we don't trap unrelated clicks
        await Retry.sleep(800);
        HTMLInputElement.prototype.click = origClick;
      }
      // give Flow time to wire its handler
      await Retry.sleep(300);
      return intercepted;
    } catch (e) {
      Log && Log.warn && Log.warn("[SN Flow] viaAddMediaClickThenInput failed", String(e && e.message || e));
      return false;
    }
  }

  async function viaPaste(file) {
    // Strategy C: synthetic paste event with DataTransfer.files
    const target = findPromptDropZone();
    if (!target) return false;
    try {
      target.focus();
      const dt = makeDataTransfer(file);
      const ev = new ClipboardEvent("paste", {
        bubbles: true, cancelable: true, clipboardData: dt,
      });
      // Some implementations don't expose clipboardData as constructor-settable
      try { Object.defineProperty(ev, "clipboardData", { value: dt }); } catch (_) {}
      target.dispatchEvent(ev);
      return true;
    } catch (e) {
      Log && Log.warn && Log.warn("[SN Flow] viaPaste failed", String(e && e.message || e));
      return false;
    }
  }

  async function viaDrop(file) {
    // Strategy D: synthetic drag-and-drop sequence
    const target = findPromptDropZone();
    if (!target) return false;
    try {
      const dt = makeDataTransfer(file);
      const baseInit = {
        bubbles: true, cancelable: true, composed: true,
        dataTransfer: dt,
      };
      target.dispatchEvent(new DragEvent("dragenter", baseInit));
      target.dispatchEvent(new DragEvent("dragover", baseInit));
      target.dispatchEvent(new DragEvent("drop", baseInit));
      target.dispatchEvent(new DragEvent("dragend", baseInit));
      return true;
    } catch (e) {
      Log && Log.warn && Log.warn("[SN Flow] viaDrop failed", String(e && e.message || e));
      return false;
    }
  }

  // --------- verification ---------

  // After dispatching attach, look for any visible thumbnail / preview to
  // confirm the image really landed in Flow's input area. Not bullet-proof —
  // returns true on first observed signal.
  async function waitForAttachConfirmation(timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 4000);
    while (Date.now() < deadline) {
      // Look for any newly added <img> near the prompt bar, or a preview chip
      const previews = D.queryAllDeep('img, [data-test-id*="preview" i], [data-testid*="preview" i]');
      for (const el of previews) {
        if (!D.isVisible(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.top < window.innerHeight * 0.45) continue; // too high to be the input preview
        if (r.width < 24 || r.height < 24) continue;
        return true;
      }
      // Or a removable chip with "remove"/"close" affordance
      const chips = D.queryAllDeep('[aria-label*="remove" i], [aria-label*="close" i]');
      for (const c of chips) {
        if (!D.isVisible(c)) continue;
        const r = c.getBoundingClientRect();
        if (r.top > window.innerHeight * 0.55) return true;
      }
      await Retry.sleep(150);
    }
    return false;
  }

  // --------- public ---------

  async function attachInputImage(mediaUrl, opts) {
    opts = opts || {};
    const filename = opts.filename || ("snflow_input" + extFromMime("image/png"));
    const timeout = opts.timeout || 12000;

    Log && Log.log && Log.log("[SN Flow] attachInputImage start", { mediaUrl: trim(mediaUrl, 80), filename });

    const blob = await fetchAsBlob(mediaUrl);
    if (!blob || blob.size === 0) throw new Error("attachInputImage: empty blob");
    const file = blobToFile(blob, filename);
    Log && Log.log && Log.log("[SN Flow] image fetched", { bytes: blob.size, type: blob.type });

    const strategies = [
      ["fileInput",       () => viaFileInput(file)],
      ["addMediaClick",   () => viaAddMediaClickThenInput(file)],
      ["paste",           () => viaPaste(file)],
      ["drop",            () => viaDrop(file)],
    ];

    let lastVia = null;
    for (const [name, strat] of strategies) {
      try {
        const ok = await strat();
        if (!ok) continue;
        lastVia = name;
        const confirmed = await waitForAttachConfirmation(timeout / strategies.length);
        if (confirmed) {
          Log && Log.log && Log.log("[SN Flow] attachInputImage confirmed", { via: name });
          return { ok: true, via: name };
        }
      } catch (e) {
        Log && Log.warn && Log.warn("[SN Flow] strategy threw", { name, e: String(e && e.message || e) });
      }
    }

    if (lastVia) {
      // We dispatched but never saw confirmation. Return ok=false but with
      // a non-fatal hint so the caller can decide whether to proceed.
      throw new Error("attachInputImage: dispatched via " + lastVia + " but no preview confirmation within " + timeout + "ms");
    }
    throw new Error("attachInputImage: no usable strategy (no file input / add-media button / drop zone found)");
  }

  function trim(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; }

  root.SNFlowAddMedia = {
    attachInputImage,
    // expose internals for tests / future PR #8 polish
    fetchAsBlob,
    findAddMediaButton,
    findFileInput,
    findPromptDropZone,
  };
})(typeof self !== "undefined" ? self : this);
