/* background/network-sniffer.js — observe Flow's tRPC traffic from the SW.
 *
 * Why: the content script already watches the DOM for new media tiles, but
 * the service worker has a wider view. chrome.webRequest fires for every
 * Flow request the user's tab makes, even when the SW restarts and even
 * across tab navigations. We use it for two jobs:
 *
 *   1) Rate-limit detection — Flow returns 429/503 (or specific 4xx with a
 *      throttling body) when it thinks the user is automating. The SW
 *      forwards these to the pacer (-> longer delay) and to the popup/
 *      monitor (-> "Cooling down" UI state).
 *
 *   2) Media URL capture — we record every media.getMediaUrlRedirect URL
 *      so the SW can correlate downloads even if the content script's
 *      MutationObserver missed the tile (e.g. Flow refactored CSS).
 *
 * This module exposes its observations through self.SNFlowSniffer:
 *   start(): attach the listeners (idempotent).
 *   stop():  detach.
 *   getRecentMediaUrls(sinceMs): {url,timestamp,tabId}[] within a window.
 *   onSignal(cb): subscribe to {kind: 'rate-limit' | 'media' | 'request',
 *                              status, url, tabId, timestamp, reason}.
 */
(function (self) {
  const FLOW_HOST_RE = /(^|\.)(labs\.google|flow\.google|aitestkitchen\.withgoogle\.com)$/i;
  const MEDIA_URL_RE = /\/api\/(?:trpc\/)?media\.getMediaUrlRedirect\?/i;

  const subs = new Set();
  // Keep a small ring buffer of recent media URLs (max 64 entries, ≤ 30 min).
  const mediaLog = [];
  const MEDIA_LOG_MAX = 64;
  const MEDIA_LOG_TTL_MS = 30 * 60_000;

  let attached = false;
  let onCompletedListener = null;
  let onErrorListener = null;

  function emit(signal) {
    for (const cb of subs) {
      try { cb(signal); } catch (_) {}
    }
  }

  function trim() {
    const cutoff = Date.now() - MEDIA_LOG_TTL_MS;
    while (mediaLog.length && mediaLog[0].timestamp < cutoff) mediaLog.shift();
    while (mediaLog.length > MEDIA_LOG_MAX) mediaLog.shift();
  }

  function isFlowRequest(details) {
    try {
      const u = new URL(details.url);
      return FLOW_HOST_RE.test(u.hostname);
    } catch (_) { return false; }
  }

  function looksLikeRateLimit(status) {
    return status === 429 || status === 503;
  }

  function looksLikeAuthLost(status) {
    return status === 401 || status === 403;
  }

  function start() {
    if (attached) return;
    if (!self.chrome || !chrome.webRequest) {
      // service workers in MV3 should always have webRequest, but be defensive
      return;
    }
    const filter = {
      urls: [
        "*://labs.google/*",
        "*://*.labs.google/*",
        "*://flow.google/*",
        "*://*.flow.google/*",
        "*://aitestkitchen.withgoogle.com/*",
      ],
      types: ["xmlhttprequest", "fetch", "main_frame", "sub_frame"],
    };

    onCompletedListener = (details) => {
      if (!isFlowRequest(details)) return;
      const ts = Date.now();
      const status = details.statusCode || 0;
      const url = details.url || "";

      // record media redirects (we only care about the trpc redirect URL,
      // not the final blob — Flow returns a 302 to the blob on the redirect)
      if (MEDIA_URL_RE.test(url)) {
        mediaLog.push({ url, timestamp: ts, tabId: details.tabId, status });
        trim();
        emit({ kind: "media", url, status, tabId: details.tabId, timestamp: ts });
      }

      if (looksLikeRateLimit(status)) {
        emit({
          kind: "rate-limit",
          status,
          url,
          tabId: details.tabId,
          timestamp: ts,
          reason: `HTTP ${status} ${url.replace(/^[^?]+/, m => m.split("/").slice(-2).join("/"))}`,
        });
        return;
      }

      if (looksLikeAuthLost(status)) {
        emit({
          kind: "auth-lost",
          status,
          url,
          tabId: details.tabId,
          timestamp: ts,
          reason: `HTTP ${status} (auth)`,
        });
        return;
      }

      // generic request signal (used by tests + telemetry)
      emit({ kind: "request", url, status, tabId: details.tabId, timestamp: ts });
    };

    onErrorListener = (details) => {
      if (!isFlowRequest(details)) return;
      // network errors during a generation are also a signal — emit but
      // don't necessarily treat as rate-limit (could be plain offline).
      emit({
        kind: "network-error",
        url: details.url,
        tabId: details.tabId,
        timestamp: Date.now(),
        reason: details.error || "unknown network error",
      });
    };

    chrome.webRequest.onCompleted.addListener(onCompletedListener, filter);
    chrome.webRequest.onErrorOccurred.addListener(onErrorListener, filter);
    attached = true;
  }

  function stop() {
    if (!attached) return;
    try { chrome.webRequest.onCompleted.removeListener(onCompletedListener); } catch (_) {}
    try { chrome.webRequest.onErrorOccurred.removeListener(onErrorListener); } catch (_) {}
    attached = false;
  }

  function getRecentMediaUrls(sinceMs) {
    const cutoff = Date.now() - (sinceMs || 5 * 60_000);
    return mediaLog.filter((e) => e.timestamp >= cutoff).slice();
  }

  function onSignal(cb) {
    subs.add(cb);
    return () => subs.delete(cb);
  }

  self.SNFlowSniffer = { start, stop, getRecentMediaUrls, onSignal };
})(typeof self !== "undefined" ? self : this);
