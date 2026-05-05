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

  // nextPending picks the next runnable item.
  //
  // Chain-mode awareness: a video item with chainStep="video" + parentId
  // must wait for its parent image item to be `completed`. If the parent
  // is `failed` or `skipped`, the caller should mark this video item as
  // `skipped` (handled in service-worker.js); we don't auto-skip here so
  // the helper stays pure.
  //
  // Run order:
  //   - default ("interleave"): walk the queue in array order. A pending
  //     video step blocks until its parent's mediaUrl exists. This causes
  //     the natural per-prompt order image1→video1→image2→video2.
  //   - "batch": skip any pending chain video step until ALL pending
  //     chain image steps are exhausted. Then come back for videos in
  //     array order.
  function nextPending(queue, opts) {
    const order = (opts && opts.chainRunOrder) || "interleave";

    // Build a quick lookup so we can resolve parent.status without O(n²).
    const byId = new Map();
    for (const q of queue) byId.set(q.id, q);

    function isReady(item) {
      if (item.status !== "pending") return false;
      if (item.chainStep === "video" && item.parentId) {
        const parent = byId.get(item.parentId);
        if (!parent) return false;
        // parent must be terminal-completed AND have produced a mediaUrl
        if (parent.status !== "completed") return false;
        if (!parent.mediaUrl && !parent.filename) return false;
      }
      return true;
    }

    if (order === "batch") {
      // pass 1: prefer pending image / non-chain items
      for (const q of queue) {
        if (q.chainStep === "video") continue;
        if (isReady(q)) return q;
      }
      // pass 2: pending chained video items whose parent is ready
      for (const q of queue) {
        if (q.chainStep !== "video") continue;
        if (isReady(q)) return q;
      }
      return null;
    }

    // interleave: array order
    for (const q of queue) {
      if (isReady(q)) return q;
    }
    return null;
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

  // Resolve the parent of a chain-video item from a queue array.
  // Returns the parent QueueItem or null.
  function findParent(queue, item) {
    if (!item || !item.parentId) return null;
    return queue.find((q) => q.id === item.parentId) || null;
  }

  // Returns true if a chain-video item should be auto-skipped because its
  // parent finished without producing a usable mediaUrl (failed / skipped).
  function shouldAutoSkip(queue, item) {
    if (!item || item.chainStep !== "video" || !item.parentId) return false;
    const parent = findParent(queue, item);
    if (!parent) return false;
    if (parent.status === "failed" || parent.status === "skipped") return true;
    return false;
  }

  root.SNFlowQueue = {
    isTerminal, isActive, nextPending, summarize,
    resetFailed, resetActive, clearQueue,
    findParent, shouldAutoSkip,
    TERMINAL, ACTIVE,
  };
})(typeof self !== "undefined" ? self : this);
