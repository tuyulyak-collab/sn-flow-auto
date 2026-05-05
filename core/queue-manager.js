/* core/queue-manager.js — pure utility helpers for queue manipulation.
 * The actual run loop lives in background/service-worker.js (which orchestrates
 * the active tab via chrome.tabs.sendMessage). This module just provides
 * deterministic helpers usable from popup + service worker + tests.
 */
(function (root) {
  const TERMINAL = new Set(["completed", "failed", "skipped"]);
  const ACTIVE = new Set(["sending", "generating", "waiting", "downloading"]);

  function isTerminal(status) { return TERMINAL.has(status); }
  function isActive(status) { return ACTIVE.has(status); }

  function nextPending(queue) {
    return queue.find((q) => q.status === "pending") || null;
  }

  function summarize(queue) {
    const total = queue.length;
    const counts = { pending: 0, sending: 0, generating: 0, waiting: 0, downloading: 0, completed: 0, failed: 0, skipped: 0 };
    for (const item of queue) {
      if (counts[item.status] !== undefined) counts[item.status] += 1;
    }
    const done = counts.completed + counts.failed + counts.skipped;
    return { total, done, counts };
  }

  function resetFailed(queue) {
    return queue.map((q) => (q.status === "failed" ? { ...q, status: "pending", attempts: 0, error: undefined, updatedAt: Date.now() } : q));
  }

  function resetActive(queue) {
    // Used on extension restart/page reload — anything that was mid-flight goes back to pending.
    return queue.map((q) => (ACTIVE.has(q.status) ? { ...q, status: "pending", updatedAt: Date.now() } : q));
  }

  function clearQueue() { return []; }

  root.SNFlowQueue = { isTerminal, isActive, nextPending, summarize, resetFailed, resetActive, clearQueue, TERMINAL, ACTIVE };
})(typeof self !== "undefined" ? self : this);
