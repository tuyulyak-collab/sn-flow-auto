/* content/downloader.js — trigger the download for a generated tile.
 *
 * Flow's per-tile download flow (May 2026):
 *   1) Hover the tile to reveal an overlay strip with three buttons:
 *        favorite (heart), redo (Reuse prompt), more_vert (More)
 *   2) Click the more_vert button — opens a Radix dropdown with menuitems
 *      like Animate / Add to Prompt / Favorite / Download / Share / ...
 *   3) Click the menuitem whose icon glyph is "download". This triggers
 *      Flow's native download flow (uses the user's session cookies, so it
 *      always succeeds with the original quality file).
 *
 * Because Flow's native click sets the filename, we ALSO fire our own
 * chrome.downloads.download() with the resolved Flow media URL, so the user
 * always ends up with a copy named SN_flow_{random5}_{ddmmyyyy}.{ext} in
 * SN_Flow_Auto/. The Flow native click runs in parallel and saves to the
 * default Downloads folder under the original Flow name (best-effort).
 *
 * Public API:
 *   Downloader.downloadResult(mediaEl, mediaUrl, filename)
 *     -> { method: "url"|"click", filename, url?, downloadId? }
 */
(function (root) {
  const D = root.SNFlowDom;
  const Retry = root.SNFlowRetry;

  // Flow's native download menuitem icon
  const NATIVE_DOWNLOAD_ICON = "download";
  const HOVER_TOOLBAR_ICONS = ["more_vert", "more_horiz"];

  function dispatchHover(el) {
    if (!el || !el.dispatchEvent) return;
    for (const t of ["mouseenter", "mouseover", "mousemove", "pointerenter", "pointerover", "pointermove"]) {
      try { el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, clientX: 0, clientY: 0 })); } catch (_) {}
    }
  }

  function findTileFor(mediaEl) {
    if (!mediaEl) return null;
    // Walk up until we hit a card-shaped ancestor (200..900 px wide).
    let cur = mediaEl;
    let bestCard = null;
    for (let i = 0; i < 12 && cur; i++) {
      try {
        const r = cur.getBoundingClientRect();
        if (r.width >= 180 && r.width <= 1000 && r.height >= 120) bestCard = cur;
      } catch (_) {}
      cur = cur.parentElement;
    }
    return bestCard || mediaEl.parentElement || mediaEl;
  }

  function findMoreButtonInTile(tile, mediaEl) {
    if (!tile && !mediaEl) return null;
    const ir = (mediaEl || tile).getBoundingClientRect();
    // candidates: any button visually overlapping the media element
    let best = null;
    for (const b of D.queryAllDeep("button, [role='button']")) {
      if (!D.isVisible(b)) continue;
      const br = b.getBoundingClientRect();
      const cx = br.x + br.width / 2;
      const cy = br.y + br.height / 2;
      if (cx < ir.x || cx > ir.x + ir.width) continue;
      if (cy < ir.y || cy > ir.y + ir.height) continue;
      // does it contain a more_vert / more_horiz icon?
      const icons = b.querySelectorAll && b.querySelectorAll("i, span");
      let isMore = false;
      if (icons) {
        for (const i of icons) {
          const t = (i.textContent || "").trim().toLowerCase();
          if (HOVER_TOOLBAR_ICONS.includes(t)) { isMore = true; break; }
        }
      }
      if (isMore) { best = b; break; }
    }
    return best;
  }

  function findOpenMenu() {
    const open = document.querySelector('[role="menu"][data-state="open"]');
    if (open) return open;
    // any visible role=menu
    const all = D.queryAllDeep('[role="menu"]');
    for (const m of all) if (D.isVisible(m)) return m;
    return null;
  }

  function findDownloadMenuItem(menu) {
    if (!menu) return null;
    const items = menu.querySelectorAll('[role="menuitem"]');
    for (const mi of items) {
      // strong signal: an <i> child whose text is exactly "download"
      const icons = mi.querySelectorAll("i, span");
      for (const ic of icons) {
        const t = (ic.textContent || "").trim().toLowerCase();
        if (t === NATIVE_DOWNLOAD_ICON) return mi;
      }
      // text fallback: label includes "download"
      const text = (mi.innerText || mi.textContent || "").toLowerCase();
      if (/\bdownload\b/.test(text) && !/upload/.test(text)) return mi;
    }
    return null;
  }

  /**
   * Try to invoke Flow's native Download menuitem for the given media element.
   * Returns true on click success.
   */
  async function clickFlowNativeDownload(mediaEl) {
    if (!mediaEl) return false;
    const tile = findTileFor(mediaEl);

    // 1) reveal toolbar (hover)
    dispatchHover(tile || mediaEl);
    try { (tile || mediaEl).scrollIntoView({ block: "center", inline: "center" }); } catch (_) {}
    await Retry.sleep(180);

    // 2) find more_vert button overlaying this tile
    let more = findMoreButtonInTile(tile, mediaEl);
    if (!more) {
      // re-hover after a short delay (some pages animate the toolbar in)
      dispatchHover(tile || mediaEl);
      await Retry.sleep(220);
      more = findMoreButtonInTile(tile, mediaEl);
    }
    if (!more) return false;

    // 3) click and wait for menu — Radix needs pointerdown/up
    try { more.scrollIntoView({ block: "center" }); } catch (_) {}
    const Settings = root.SNFlowSettings;
    if (Settings && Settings.realClick) Settings.realClick(more);
    else more.click();
    const menu = await Retry.waitFor(() => findOpenMenu(), { timeout: 1500, interval: 60 }).catch(() => null);
    if (!menu) return false;

    // 4) click the Download menuitem
    const dl = findDownloadMenuItem(menu);
    if (!dl) {
      // close the menu before bailing out
      try { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); } catch (_) {}
      return false;
    }
    if (Settings && Settings.realClick) Settings.realClick(dl);
    else dl.click();
    return true;
  }

  // ---- legacy/global download button fallbacks ----

  const DL_KEYWORDS = ["download", "save", "export"];
  const DL_NEG = ["upload", "delete", "share"];

  function findGlobalDownloadButton() {
    for (const el of D.queryAllDeep("button, a[href], [role='button']")) {
      const t = D.elText(el);
      if (!t) continue;
      if (DL_NEG.some((k) => t.includes(k))) continue;
      if (DL_KEYWORDS.some((k) => t.includes(k)) && D.isVisible(el) && D.isEnabled(el)) return el;
    }
    return null;
  }

  /**
   * Trigger a download for a Flow tile. Strategy:
   *   1) Click Flow's native Download menuitem (preserves quality + auth)
   *   2) Always also fire chrome.downloads with our SN_flow_* filename if we
   *      have a media URL (so the user gets a renamed copy in SN_Flow_Auto/)
   *   3) If we don't have a URL and the native click failed, fall back to the
   *      first global "Download" button on the page.
   */
  async function downloadResult(mediaEl, mediaUrl, filename) {
    let nativeClicked = false;
    try {
      nativeClicked = await clickFlowNativeDownload(mediaEl);
    } catch (_) { nativeClicked = false; }

    // Always try the URL-based copy when we have a URL — gives us the
    // SN_flow_{random5}_{ddmmyyyy} filename in SN_Flow_Auto/.
    if (mediaUrl) {
      try {
        const dl = await sendDownloadToBackground(mediaUrl, filename);
        return {
          method: "url",
          filename,
          url: mediaUrl,
          downloadId: dl && dl.id,
          alsoNativeClicked: nativeClicked,
        };
      } catch (e) {
        if (nativeClicked) return { method: "click", filename, alsoNativeClicked: true, error: String(e && e.message || e) };
        // fall through to legacy fallback
      }
    }

    if (nativeClicked) return { method: "click", filename };

    const globalBtn = findGlobalDownloadButton();
    if (globalBtn) {
      try { globalBtn.scrollIntoView({ block: "center" }); } catch (_) {}
      const Settings2 = root.SNFlowSettings;
      if (Settings2 && Settings2.realClick) Settings2.realClick(globalBtn);
      else globalBtn.click();
      return { method: "click", filename };
    }

    if (!mediaUrl) throw new Error("no media URL and no download button found");
    const dl = await sendDownloadToBackground(mediaUrl, filename);
    return { method: "url", filename, url: mediaUrl, downloadId: dl && dl.id };
  }

  function sendDownloadToBackground(url, filename) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(
          { type: "SN_FLOW_DOWNLOAD", payload: { url, filename } },
          (resp) => {
            const err = chrome.runtime && chrome.runtime.lastError;
            if (err) return reject(new Error(err.message || "downloads message failed"));
            if (!resp || !resp.ok) return reject(new Error((resp && resp.error) || "download failed"));
            resolve(resp);
          },
        );
      } catch (e) { reject(e); }
    });
  }

  root.SNFlowDownloader = {
    downloadResult,
    findTileFor, findMoreButtonInTile, findDownloadMenuItem,
    findGlobalDownloadButton, clickFlowNativeDownload,
  };
})(typeof self !== "undefined" ? self : this);
