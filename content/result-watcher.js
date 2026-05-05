/* content/result-watcher.js — wait for a freshly generated image / video result.
 *
 * Strategy:
 *   - take a "before" snapshot of every <img src=...> and <video> URL on the page
 *   - watch the DOM for new media elements via MutationObserver + blob/data URL detection
 *   - look for the most recent media that wasn't in the snapshot
 *   - separately, watch network responses for media-looking URLs (img/video) via
 *     PerformanceObserver (lightweight, doesn't require webRequest perms)
 */
(function (root) {
  const D = root.SNFlowDom;
  const R = root.SNFlowRetry;

  const IMG_EXT = /\.(png|jpe?g|webp|gif)(\?|$)/i;
  const VID_EXT = /\.(mp4|webm|mov|m4v)(\?|$)/i;

  function getAllMediaUrls() {
    const out = new Set();
    for (const el of D.queryAllDeep("img")) {
      const src = el.currentSrc || el.src;
      if (src) out.add(src);
    }
    for (const el of D.queryAllDeep("video")) {
      const src = el.currentSrc || el.src;
      if (src) out.add(src);
      el.querySelectorAll && el.querySelectorAll("source").forEach((s) => { if (s.src) out.add(s.src); });
    }
    return out;
  }

  function pickMode(url) {
    if (!url) return null;
    if (VID_EXT.test(url) || url.startsWith("blob:") && url.includes("video")) return "video";
    if (IMG_EXT.test(url)) return "image";
    return null;
  }

  function snapshot() {
    return getAllMediaUrls();
  }

  /**
   * Wait for a new media URL to appear (post-generation).
   * @param {Set<string>} before — snapshot taken before clicking Generate.
   * @param {"image"|"video"} mode
   * @param {{ timeout?: number, signal?: AbortSignal }} opts
   * @returns {Promise<{ url: string, mode: string, element: Element|null } | null>}
   */
  async function waitForNewMedia(before, mode, { timeout = 5 * 60 * 1000, signal } = {}) {
    const wantedRe = mode === "video" ? VID_EXT : IMG_EXT;
    const wantedTag = mode === "video" ? "video" : "img";

    // Track urls from PerformanceObserver too (cross-origin-safe).
    const newPerfUrls = new Set();
    let perfObs;
    try {
      perfObs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const u = entry.name;
          if (!u || before.has(u)) continue;
          if (wantedRe.test(u)) newPerfUrls.add(u);
          else if (u.startsWith("blob:")) newPerfUrls.add(u);
          else if (mode === "video" && /(video|mp4|m4s|seg)/i.test(u)) newPerfUrls.add(u);
          else if (mode === "image" && /(image|render|generated)/i.test(u)) newPerfUrls.add(u);
        }
      });
      perfObs.observe({ type: "resource", buffered: true });
    } catch (_) { /* not supported */ }

    try {
      const result = await R.waitFor(() => {
        // 1) DOM-based candidate: look for the largest visible new media element
        const elCandidates = [];
        for (const el of D.queryAllDeep(wantedTag)) {
          const src = el.currentSrc || el.src
            || (el.querySelector && el.querySelector("source") && el.querySelector("source").src)
            || "";
          if (!src) continue;
          if (before.has(src)) continue;
          if (!D.isVisible(el)) continue;
          const r = el.getBoundingClientRect();
          // ignore tiny thumbs (icons, avatars)
          if (Math.min(r.width, r.height) < 64) continue;
          elCandidates.push({ el, url: src, area: r.width * r.height });
        }
        if (elCandidates.length) {
          elCandidates.sort((a, b) => b.area - a.area);
          const best = elCandidates[0];
          return { url: best.url, mode, element: best.el };
        }

        // 2) Performance-observer URL fallback (no DOM element yet)
        for (const url of newPerfUrls) {
          // Pick the one that best matches the requested mode
          if ((mode === "video" && (VID_EXT.test(url) || url.startsWith("blob:") || /(mp4|m4s|video)/i.test(url)))
              || (mode === "image" && (IMG_EXT.test(url) || /(image|render|generated)/i.test(url)))) {
            return { url, mode, element: null };
          }
        }
        return null;
      }, { timeout, interval: 750, signal });
      return result;
    } finally {
      try { perfObs && perfObs.disconnect(); } catch (_) {}
    }
  }

  root.SNFlowResultWatcher = { snapshot, waitForNewMedia, pickMode, getAllMediaUrls };
})(typeof self !== "undefined" ? self : this);
