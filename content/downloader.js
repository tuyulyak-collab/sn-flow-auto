/* content/downloader.js — find and click Google Flow's official download button if present;
 * otherwise resolve the media URL and ask the service worker to chrome.downloads.download().
 */
(function (root) {
  const D = root.SNFlowDom;

  const DL_KEYWORDS = ["download", "save", "export"];
  const DL_NEG = ["upload", "delete", "share"];

  function findDownloadButtonNear(mediaEl) {
    if (!mediaEl) return null;
    // search ancestors for a contextual "download" control
    let scope = mediaEl;
    for (let i = 0; i < 6 && scope; i++) {
      scope = scope.parentElement || null;
      if (!scope) break;
      const cands = scope.querySelectorAll
        ? Array.from(scope.querySelectorAll("button, a[href], [role='button']"))
        : [];
      for (const c of cands) {
        const t = D.elText(c);
        if (DL_NEG.some((k) => t.includes(k))) continue;
        if (DL_KEYWORDS.some((k) => t.includes(k))) {
          if (D.isVisible(c) && D.isEnabled(c)) return c;
        }
        // icon-only button that contains a download-shaped svg path
        const svg = c.querySelector && c.querySelector("svg");
        if (svg && /download|save|arrow.?down/i.test((svg.outerHTML || ""))) {
          if (D.isVisible(c) && D.isEnabled(c)) return c;
        }
      }
    }
    return null;
  }

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
   * Try the page's own download button first, fall back to media URL.
   * @param {Element|null} mediaEl
   * @param {string} mediaUrl
   * @param {string} filename
   * @returns {Promise<{ method: "click" | "url", filename: string, url?: string, downloadId?: number }>}
   */
  async function downloadResult(mediaEl, mediaUrl, filename) {
    // 1) try contextual download button
    const localBtn = findDownloadButtonNear(mediaEl);
    if (localBtn) {
      try { localBtn.scrollIntoView({ block: "center" }); } catch (_) {}
      localBtn.click();
      // We can't rename a click-driven download; surface the click but still send
      // a URL-based download too if we can resolve one (so the user always gets
      // a file with the SN_flow_* name).
      if (mediaUrl) {
        try {
          const dl = await sendDownloadToBackground(mediaUrl, filename);
          return { method: "url", filename, url: mediaUrl, downloadId: dl && dl.id };
        } catch (_) { /* fall through to clicked download */ }
      }
      return { method: "click", filename };
    }

    // 2) global download button (e.g. a top toolbar)
    const globalBtn = findGlobalDownloadButton();
    if (globalBtn && !mediaUrl) {
      try { globalBtn.scrollIntoView({ block: "center" }); } catch (_) {}
      globalBtn.click();
      return { method: "click", filename };
    }

    // 3) URL fallback via service worker (preferred path, gives us our own filename)
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

  root.SNFlowDownloader = { findDownloadButtonNear, findGlobalDownloadButton, downloadResult };
})(typeof self !== "undefined" ? self : this);
