/* content/dom-error-watcher.js — watches Flow's toast / alert containers
 * for rate-limit / capacity / generation-failed messages and forwards them
 * to the service worker via { type: "SN_FLOW_RATE_LIMIT" }.
 *
 * Inspected from a logged-in Flow tab on labs.google/fx/tools/flow:
 *   - Toast/alert containers identified as live regions:
 *     • <section aria-live="polite">
 *     • <div role="status" aria-live="assertive">
 *     • <p role="alert"   aria-live="assertive">
 *   - Generation errors and rate-limits get rendered into the
 *     [aria-live="assertive"] region; capacity messages may appear as a
 *     non-modal toast in the polite region.
 *
 * Strategy: wait for any live region that exists in the DOM, attach a
 * MutationObserver, and inspect each new text node against the regex set
 * provided by core/pacing.js (kept centralised so background and content
 * agree on what counts as a rate-limit signal). Throttle reports so a
 * single toast that re-renders 5 times only sends 1 signal per 30 s.
 */
(function (root) {
  const Pacing = root.SNFlowPacing;
  if (!Pacing) {
    // pacing.js wasn't loaded — skip gracefully (some load orders during
    // dev may run this script first).
    return;
  }

  // throttle: max 1 signal per kind per window
  const lastEmit = new Map(); // key -> timestamp
  const EMIT_WINDOW_MS = 30_000;

  function shouldEmit(text) {
    const key = text.slice(0, 80);
    const now = Date.now();
    const last = lastEmit.get(key) || 0;
    if (now - last < EMIT_WINDOW_MS) return false;
    lastEmit.set(key, now);
    return true;
  }

  function reportRateLimit(text, source) {
    if (!shouldEmit(text)) return;
    try {
      chrome.runtime.sendMessage({
        type: "SN_FLOW_RATE_LIMIT",
        payload: { reason: text.slice(0, 200), source, timestamp: Date.now() },
      }, () => { /* no-op */ });
    } catch (_) { /* SW may be restarting */ }
  }

  function inspectNode(node, source) {
    if (!node) return;
    let text = "";
    if (node.nodeType === Node.TEXT_NODE) text = node.textContent || "";
    else if (node.querySelectorAll) {
      // join all visible text children (live regions are usually small)
      text = (node.textContent || "").trim();
    }
    if (!text || text.length < 5) return;
    if (Pacing.isRateLimitMessage(text)) reportRateLimit(text, source);
  }

  function attachObserverTo(el, source) {
    if (!el || el.__snflowObserved) return;
    el.__snflowObserved = true;
    const obs = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === "characterData") {
          inspectNode(m.target, source);
        } else if (m.type === "childList") {
          for (const n of m.addedNodes) inspectNode(n, source);
        }
      }
    });
    obs.observe(el, { childList: true, characterData: true, subtree: true });
    // also inspect any text already present
    inspectNode(el, source);
  }

  function findLiveRegions() {
    const out = [];
    for (const sel of ["[role='alert']", "[role='status']", "[aria-live='assertive']", "[aria-live='polite']"]) {
      for (const el of document.querySelectorAll(sel)) out.push(el);
    }
    return out;
  }

  function startScanning() {
    for (const el of findLiveRegions()) {
      const role = el.getAttribute("role") || el.getAttribute("aria-live") || "live";
      attachObserverTo(el, role);
    }
    // Also watch for new live regions being added later (Flow lazy-mounts toasts)
    const docObs = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const n of m.addedNodes) {
          if (!n.querySelectorAll) continue;
          if (n.matches && (n.matches("[role='alert']") || n.matches("[role='status']") || n.matches("[aria-live]"))) {
            attachObserverTo(n, n.getAttribute("role") || n.getAttribute("aria-live") || "live");
          }
          for (const sub of n.querySelectorAll("[role='alert'], [role='status'], [aria-live]")) {
            attachObserverTo(sub, sub.getAttribute("role") || sub.getAttribute("aria-live") || "live");
          }
        }
      }
    });
    docObs.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startScanning, { once: true });
  } else {
    startScanning();
  }

  root.SNFlowDomErrorWatcher = {
    findLiveRegions,
    isRateLimitMessage: Pacing.isRateLimitMessage,
  };
})(typeof self !== "undefined" ? self : this);
