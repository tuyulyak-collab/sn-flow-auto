/* content/flow-settings.js — drive Google Flow's combined settings dropdown
 * (the chip next to the Generate button that holds Image/Video tab,
 *  aspect ratio tabs, and output-count tabs).
 *
 * DOM contract observed on labs.google/fx/tools/flow (May 2026):
 *   - The trigger is <button aria-haspopup="menu"> rendered inline next to
 *     the Generate (arrow_forward) button. Its label is the active model name
 *     (e.g. "Nano Banana 2") plus an aspect ratio icon (crop_16_9 etc.) plus
 *     an output count (e.g. "x2").
 *   - When opened, the dropdown is a Radix popper with role="menu", inside
 *     which there are three <div role="tablist"> groups:
 *       1) Mode     -> button[role=tab][id$="-trigger-IMAGE"|"-trigger-VIDEO"]
 *       2) Ratio    -> button[role=tab][id$="-trigger-LANDSCAPE"|"-trigger-LANDSCAPE_4_3"
 *                                       |"-trigger-SQUARE"|"-trigger-PORTRAIT_3_4"|"-trigger-PORTRAIT"]
 *       3) Count    -> button[role=tab][id$="-trigger-1"|"-trigger-2"|"-trigger-3"|"-trigger-4"]
 *   - aria-selected="true" is applied to the active tab in each tablist.
 *
 * Public API:
 *   SNFlowSettings.applySettings({ mode, aspectRatio, outputCount })
 *     -> { mode, aspectRatio, outputCount } (effective values, after best-effort)
 *   SNFlowSettings.readActive() -> current Flow setting state, if any
 */
(function (root) {
  const D = root.SNFlowDom;
  const Retry = root.SNFlowRetry;
  const Log = root.SNFlowLogger;

  // Map our normalized settings to Flow's radix tab id suffixes.
  const RATIO_TAB = {
    "16:9": "LANDSCAPE",
    "4:3":  "LANDSCAPE_4_3",
    "1:1":  "SQUARE",
    "3:4":  "PORTRAIT_3_4",
    "9:16": "PORTRAIT",
  };
  // Reverse lookup, used by readActive()
  const TAB_RATIO = Object.fromEntries(Object.entries(RATIO_TAB).map(([k, v]) => [v, k]));

  const RATIO_ICON = {
    "16:9": "crop_16_9",
    "4:3":  "crop_landscape",
    "1:1":  "crop_square",
    "3:4":  "crop_portrait",
    "9:16": "crop_9_16",
  };

  // Radix UI listens to `pointerdown` (not just click) to open menus, so plain
  // .click() does nothing on the trigger. realClick dispatches a full
  // pointerdown -> pointerup -> click sequence at the element's center.
  function realClick(el) {
    if (!el) return false;
    try {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const opts = {
        bubbles: true, cancelable: true, composed: true,
        clientX: cx, clientY: cy,
        button: 0, buttons: 1,
        pointerType: "mouse", isPrimary: true,
      };
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new MouseEvent("mousedown", opts));
      el.dispatchEvent(new PointerEvent("pointerup",   { ...opts, buttons: 0 }));
      el.dispatchEvent(new MouseEvent("mouseup",       { ...opts, buttons: 0 }));
      el.dispatchEvent(new MouseEvent("click",         { ...opts, buttons: 0 }));
      return true;
    } catch (_) {
      try { el.click(); return true; } catch (__) { return false; }
    }
  }

  function findSettingsTrigger() {
    // The trigger sits in the bottom prompt bar, next to the Generate button.
    // It has aria-haspopup="menu" and shows model+ratio+count text.
    const candidates = D.queryAllDeep('button[aria-haspopup="menu"]');
    let best = null;
    let bestScore = -Infinity;
    for (const el of candidates) {
      if (!D.isVisible(el) || !D.isEnabled(el)) continue;
      const text = (el.innerText || el.textContent || "").toLowerCase();
      const html = (el.innerHTML || "").toLowerCase();
      const r = el.getBoundingClientRect();
      let s = 0;
      // model names that have appeared in Flow over time
      if (/(nano banana|imagen|veo|gemini|model)/i.test(text)) s += 8;
      // any ratio icon in markup
      if (/crop_(16_9|landscape|square|portrait|9_16)/i.test(html)) s += 5;
      // count marker like "x2" / "x3" / "x4"
      if (/x[1-9]\b/i.test(text)) s += 3;
      // bottom-of-page bias (the prompt bar is near the bottom)
      if (r.top > window.innerHeight * 0.55) s += 2;
      if (s > bestScore) { bestScore = s; best = el; }
    }
    return bestScore > 0 ? best : null;
  }

  async function openDropdown() {
    const trigger = findSettingsTrigger();
    if (!trigger) return null;
    const expanded = trigger.getAttribute("aria-expanded") === "true";
    if (!expanded) {
      try { trigger.scrollIntoView({ block: "center" }); } catch (_) {}
      realClick(trigger);
      await Retry.sleep(180);
    }
    // Wait for the radix menu to appear
    const menu = await Retry.waitFor(() => {
      const m = document.querySelector('[role="menu"][data-state="open"]')
        || D.queryAllDeep('[role="menu"]').find((el) => D.isVisible(el));
      return m || null;
    }, { timeout: 3000, interval: 80 }).catch(() => null);
    return { trigger, menu: menu || null };
  }

  async function closeDropdown(trigger) {
    try {
      if (trigger && trigger.getAttribute("aria-expanded") === "true") {
        realClick(trigger);
        await Retry.sleep(120);
      } else {
        // press Escape as a fallback
        document.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Escape", code: "Escape", which: 27, keyCode: 27, bubbles: true,
        }));
        await Retry.sleep(120);
      }
    } catch (_) {}
  }

  function findTabBySuffix(menuRoot, suffix) {
    const tabs = (menuRoot || document).querySelectorAll('[role="tab"]');
    for (const t of tabs) {
      const id = t.getAttribute("id") || "";
      if (id.endsWith(`-trigger-${suffix}`)) return t;
    }
    return null;
  }

  function findCountTab(menuRoot, n) {
    // Count tabs share the suffix pattern -trigger-1 / -trigger-2 / etc, but they
    // must not match the ratio "PORTRAIT" or anything else, so we filter by text.
    const tabs = (menuRoot || document).querySelectorAll('[role="tab"]');
    for (const t of tabs) {
      const id = t.getAttribute("id") || "";
      const txt = (t.textContent || "").trim().toLowerCase();
      if (id.endsWith(`-trigger-${n}`) && /^x?\s*[1-9]$|^[1-9]\s*x?$/i.test(txt.replace(/\s+/g, ""))) {
        return t;
      }
    }
    // looser fallback: any tab whose text is exactly "x{n}" / "{n}x"
    for (const t of tabs) {
      const txt = (t.textContent || "").trim().toLowerCase().replace(/\s+/g, "");
      if (txt === `x${n}` || txt === `${n}x`) return t;
    }
    return null;
  }

  async function clickTab(tab) {
    if (!tab) return false;
    if (tab.getAttribute("aria-selected") === "true") return true;
    try { tab.scrollIntoView({ block: "center" }); } catch (_) {}
    realClick(tab);
    // wait until aria-selected flips
    return await Retry.waitFor(() => tab.getAttribute("aria-selected") === "true",
      { timeout: 1500, interval: 50 }).catch(() => false);
  }

  function readActive() {
    // Try to read the current selection without opening the menu.
    // The trigger button visually shows the active settings, including a
    // crop_* icon and an "xN" suffix. We also peek into any open menu if there
    // is one (e.g. between two clicks).
    const out = { mode: null, aspectRatio: null, outputCount: null };
    const trigger = findSettingsTrigger();
    if (trigger) {
      const html = (trigger.innerHTML || "");
      const txt = (trigger.innerText || trigger.textContent || "");
      const mIcon = html.match(/crop_(16_9|landscape|square|portrait|9_16)/i);
      if (mIcon) {
        const icon = mIcon[1].toLowerCase();
        for (const [ratio, ic] of Object.entries(RATIO_ICON)) {
          if (ic.replace(/^crop_/, "").toLowerCase() === icon) { out.aspectRatio = ratio; break; }
        }
      }
      const mCount = txt.match(/x\s*([1-9])/i);
      if (mCount) out.outputCount = parseInt(mCount[1], 10);
      // Mode: the trigger itself does not always show "image" vs "video";
      // sniff inside any open menu.
      const open = document.querySelector('[role="menu"][data-state="open"]');
      if (open) {
        const imgTab = findTabBySuffix(open, "IMAGE");
        const vidTab = findTabBySuffix(open, "VIDEO");
        if (imgTab && imgTab.getAttribute("aria-selected") === "true") out.mode = "image";
        else if (vidTab && vidTab.getAttribute("aria-selected") === "true") out.mode = "video";
      }
    }
    return out;
  }

  /**
   * Apply requested settings on the page by interacting with the Flow dropdown.
   * Best-effort: returns the fields that were applied successfully.
   */
  async function applySettings(req) {
    const want = {
      mode: (req && req.mode) ? String(req.mode).toLowerCase() : null,
      aspectRatio: (req && req.aspectRatio) ? String(req.aspectRatio) : null,
      outputCount: (req && req.outputCount) ? parseInt(req.outputCount, 10) : null,
    };
    if (!want.mode && !want.aspectRatio && !want.outputCount) return readActive();

    const opened = await openDropdown();
    if (!opened || !opened.menu) {
      Log && Log.warn && Log.warn("[SN Flow] settings dropdown not found");
      return readActive();
    }
    const { trigger, menu } = opened;
    const applied = { mode: null, aspectRatio: null, outputCount: null };

    try {
      if (want.mode === "image" || want.mode === "video") {
        const tab = findTabBySuffix(menu, want.mode === "video" ? "VIDEO" : "IMAGE");
        if (await clickTab(tab)) applied.mode = want.mode;
        await Retry.sleep(120);
      }

      if (want.aspectRatio && RATIO_TAB[want.aspectRatio]) {
        const tab = findTabBySuffix(menu, RATIO_TAB[want.aspectRatio]);
        if (tab && !tab.disabled && tab.getAttribute("aria-disabled") !== "true") {
          if (await clickTab(tab)) applied.aspectRatio = want.aspectRatio;
        } else {
          // ratio not available for the current mode (e.g. video rejects 1:1)
          Log && Log.warn && Log.warn("[SN Flow] ratio tab unavailable", want.aspectRatio);
        }
        await Retry.sleep(120);
      }

      if (Number.isInteger(want.outputCount) && want.outputCount >= 1 && want.outputCount <= 4) {
        const tab = findCountTab(menu, want.outputCount);
        if (await clickTab(tab)) applied.outputCount = want.outputCount;
        await Retry.sleep(120);
      }
    } finally {
      await closeDropdown(trigger);
    }
    return applied;
  }

  root.SNFlowSettings = { applySettings, readActive, realClick, findSettingsTrigger, RATIO_TAB, RATIO_ICON };
})(typeof self !== "undefined" ? self : this);
