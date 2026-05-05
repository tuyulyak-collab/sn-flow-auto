/* content/downloader.js — trigger the download for a generated tile.
 *
 * Strategy (post PR #13):
 *   1) If we have a media URL, fire chrome.downloads.download() with our
 *      SN_flow_{random5}_{ddmmyyyy}.{ext} filename into SN_Flow_Auto/. This
 *      is the ONLY thing we want to happen on the happy path so the user
 *      ends up with exactly one renamed file, not two.
 *   2) Only if the URL-based download throws (or no URL was resolved), fall
 *      back to clicking Flow's native Download menuitem. Flow's native click
 *      writes a UUID-named file to the default Downloads folder, which is
 *      noisy duplicate output the user explicitly does not want.
 *
 * Flow's native per-tile download flow (used only as fallback):
 *   1) Hover the tile to reveal an overlay strip with three buttons:
 *        favorite (heart), redo (Reuse prompt), more_vert (More)
 *   2) Click more_vert → opens a Radix dropdown with Animate / Add to Prompt
 *      / Favorite / Download / Share / ...
 *   3) Click the menuitem whose icon glyph is "download".
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
   *   1) Try URL-based download with our SN_flow_* rename (happy path).
   *   2) Only on failure (or no URL), fall back to Flow's native click
   *      and finally to a generic global Download button.
   *
   * The native click is intentionally NOT fired on the happy path: it
   * writes a UUID-named duplicate to the user's default Downloads folder,
   * which is what the user reported as "the rename feature isn't working"
   * (they were seeing both the renamed copy AND the UUID copy).
   */
  async function downloadResult(mediaEl, mediaUrl, filename) {
    if (mediaUrl) {
      try {
        const dl = await sendDownloadToBackground(mediaUrl, filename);
        return {
          method: "url",
          filename,
          url: mediaUrl,
          downloadId: dl && dl.id,
        };
      } catch (_) {
        // fall through to native-click fallback
      }
    }

    let nativeClicked = false;
    try {
      nativeClicked = await clickFlowNativeDownload(mediaEl);
    } catch (_) { nativeClicked = false; }
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
    // Last-resort retry through the SW (in case the first attempt failed for
    // a transient reason like the SW reloading mid-download).
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
