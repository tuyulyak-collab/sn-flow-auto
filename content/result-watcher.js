/* content/result-watcher.js — wait for freshly generated image / video result tiles.
 *
 * DOM contract observed on labs.google/fx/tools/flow:
 *
 *   Image tile:
 *     <a class="sc-3ab8616e-0 ...">
 *       <img alt="Generated image"
 *            src="https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=<UUID>"
 *            naturalWidth="1376" naturalHeight="768" />
 *     </a>
 *
 *   Video tile (via Flow's "Animate" path or Veo):
 *     <video src="https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=<UUID>"
 *            ... ></video>
 *
 *   The same media.getMediaUrlRedirect endpoint serves both image and video,
 *   redirecting to the actual storage URL (not directly fetchable cross-origin
 *   without auth, but chrome.downloads handles cookies).
 *
 *   While loading, Flow shows a placeholder tile (low naturalWidth, often
 *   a pinhole flower-placeholder.webp). We filter those out with a min-size
 *   threshold and a known-placeholder URL list.
 *
 * Public API:
 *   ResultWatcher.snapshot() -> Set<string>
 *   ResultWatcher.waitForNewMedia(before, mode, opts)
 *     -> { url, mode, element, all: [{ url, element }] }
 *   ResultWatcher.waitForBatch(before, mode, expectedCount, opts)
 *     -> { items: [{ url, element }], mode }
 */
(function (root) {
  const D = root.SNFlowDom;
  const R = root.SNFlowRetry;

  const IMG_EXT = /\.(png|jpe?g|webp|gif)(\?|$)/i;
  const VID_EXT = /\.(mp4|webm|mov|m4v)(\?|$)/i;

  // Flow's redirect endpoint that serves the final media (image or video).
  const FLOW_MEDIA_URL_RE = /labs\.google\/fx\/api\/trpc\/media\.getMediaUrlRedirect/i;
  // Lower-confidence patterns from older Flow / aitestkitchen surfaces.
  const FLOW_FALLBACK_URL_RE = /(googleusercontent\.com\/.*generated|aitestkitchen|fxstorage|mediaresult)/i;

  const KNOWN_PLACEHOLDERS_RE = /(flower-placeholder|pinhole|empty-state|skeleton|loading)/i;

  function isFlowMediaUrl(url) {
    if (!url) return false;
    if (FLOW_MEDIA_URL_RE.test(url)) return true;
    return false;
  }

  function isProbablyMediaUrl(url, mode) {
    if (!url) return false;
    if (KNOWN_PLACEHOLDERS_RE.test(url)) return false;
    if (isFlowMediaUrl(url)) return true;
    if (mode === "video") return VID_EXT.test(url) || /\b(mp4|m4s|video)\b/i.test(url);
    return IMG_EXT.test(url) || FLOW_FALLBACK_URL_RE.test(url);
  }

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
    if (VID_EXT.test(url) || (typeof url === "string" && url.startsWith("blob:") && url.includes("video"))) return "video";
    if (IMG_EXT.test(url)) return "image";
    if (isFlowMediaUrl(url)) return null; // ambiguous (Flow redirect serves both)
    return null;
  }

  function snapshot() {
    return getAllMediaUrls();
  }

  function isFinishedImage(img) {
    if (!img) return false;
    if (img.naturalWidth < 200 || img.naturalHeight < 200) return false;
    const src = img.currentSrc || img.src || "";
    if (!src) return false;
    if (KNOWN_PLACEHOLDERS_RE.test(src)) return false;
    return true;
  }

  function isFinishedVideo(video) {
    if (!video) return false;
    const src = video.currentSrc || video.src
      || (video.querySelector && video.querySelector("source") && video.querySelector("source").src)
      || "";
    if (!src) return false;
    if (KNOWN_PLACEHOLDERS_RE.test(src)) return false;
    // Wait for video metadata if possible
    if (video.readyState !== undefined && video.readyState >= 1) return true;
    if (video.videoWidth >= 200 || (video.duration && !isNaN(video.duration))) return true;
    // If we at least have a src, accept it; downloader will handle bytes.
    return true;
  }

  function newMediaCandidates(before, mode) {
    const wantedTag = mode === "video" ? "video" : "img";
    const candidates = [];

    for (const el of D.queryAllDeep(wantedTag)) {
      const src = el.currentSrc || el.src
        || (el.querySelector && el.querySelector("source") && el.querySelector("source").src)
        || "";
      if (!src) continue;
      if (before.has(src)) continue;
      if (KNOWN_PLACEHOLDERS_RE.test(src)) continue;
      if (!D.isVisible(el)) continue;

      // Hard filter: ignore tiny thumbs (avatars / icons)
      const r = el.getBoundingClientRect();
      if (Math.min(r.width, r.height) < 64) continue;

      // Strong Flow signal: alt="Generated image" / explicit Flow redirect URL.
      const isGenAlt = (el.tagName === "IMG" && (el.getAttribute("alt") || "") === "Generated image");
      const isFlowUrl = isFlowMediaUrl(src);
      const finished = wantedTag === "img" ? isFinishedImage(el) : isFinishedVideo(el);

      // For mode="image" we require either Flow redirect URL or alt match or
      // an image-extension URL plus a finished load.
      // For mode="video" we accept video elements with a flow URL or a video
      // extension URL.
      const accepted =
        (wantedTag === "img" && (isGenAlt || isFlowUrl || (IMG_EXT.test(src) && finished))) ||
        (wantedTag === "video" && (isFlowUrl || VID_EXT.test(src) || finished));
      if (!accepted) continue;

      candidates.push({ el, url: src, area: r.width * r.height });
    }

    candidates.sort((a, b) => b.area - a.area);
    return candidates;
  }

  /**
   * Wait for at least one new media to appear. Returns the largest visible
   * candidate plus the full list of new ones discovered in this batch.
   */
  async function waitForNewMedia(before, mode, { timeout = 5 * 60 * 1000, signal } = {}) {
    const newPerfUrls = new Set();
    const wantedRe = mode === "video" ? VID_EXT : IMG_EXT;
    let perfObs;
    try {
      perfObs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const u = entry.name;
          if (!u || before.has(u)) continue;
          if (KNOWN_PLACEHOLDERS_RE.test(u)) continue;
          if (isFlowMediaUrl(u) || wantedRe.test(u)) { newPerfUrls.add(u); continue; }
          if (u.startsWith("blob:")) newPerfUrls.add(u);
        }
      });
      perfObs.observe({ type: "resource", buffered: true });
    } catch (_) { /* not supported */ }

    try {
      const result = await R.waitFor(() => {
        const cands = newMediaCandidates(before, mode);
        if (cands.length) {
          const best = cands[0];
          return {
            url: best.url,
            mode,
            element: best.el,
            all: cands.map((c) => ({ url: c.url, element: c.el })),
          };
        }
        // PerformanceObserver fallback (URL only, no DOM element yet).
        for (const url of newPerfUrls) {
          if (mode === "video"
            ? (VID_EXT.test(url) || isFlowMediaUrl(url) || url.startsWith("blob:"))
            : (IMG_EXT.test(url) || isFlowMediaUrl(url))) {
            return { url, mode, element: null, all: [{ url, element: null }] };
          }
        }
        return null;
      }, { timeout, interval: 750, signal });
      return result;
    } finally {
      try { perfObs && perfObs.disconnect(); } catch (_) {}
    }
  }

  /**
   * Variation that waits for `expectedCount` distinct new media tiles, useful
   * when the user picked output count = 2/3/4. Falls back to whatever has
   * appeared by the timeout.
   */
  async function waitForBatch(before, mode, expectedCount, { timeout = 5 * 60 * 1000, signal } = {}) {
    expectedCount = Math.max(1, parseInt(expectedCount, 10) || 1);
    let last = [];
    try {
      await R.waitFor(() => {
        const cands = newMediaCandidates(before, mode);
        // dedupe by url
        const seen = new Set();
        last = cands.filter((c) => {
          if (seen.has(c.url)) return false;
          seen.add(c.url);
          return true;
        });
        return last.length >= expectedCount ? true : null;
      }, { timeout, interval: 750, signal });
    } catch (_) {
      // fall through with whatever we have
    }
    return {
      mode,
      items: last.map((c) => ({ url: c.url, element: c.el })),
    };
  }

  root.SNFlowResultWatcher = {
    snapshot, waitForNewMedia, waitForBatch,
    pickMode, getAllMediaUrls,
    isFlowMediaUrl, isProbablyMediaUrl,
  };
})(typeof self !== "undefined" ? self : this);
