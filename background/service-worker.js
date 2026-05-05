/* background/service-worker.js — orchestrates the queue across the active Google Flow tab.
 *
 * Responsibilities:
 *   - persist queue + run state in chrome.storage.local
 *   - drive the run loop: pick next pending → ask content script to RUN_ITEM
 *     → on success kick chrome.downloads.download → mark completed
 *   - handle PAUSE / RESUME / STOP commands from popup or floating monitor
 *   - service worker may be evicted at any time; we keep state in storage and
 *     resume the loop whenever an action arrives.
 */
self.importScripts(
  "../core/logger.js",
  "../core/retry.js",
  "../core/filename-template.js",
  "../core/download-path.js",
  "../core/storage.js",
  "../core/queue-manager.js",
  "../core/prompt-parser.js",
  "../core/pacing.js",
  "./network-sniffer.js",
);

const Log = self.SNFlowLogger;
const Retry = self.SNFlowRetry;
const Storage = self.SNFlowStorage;
const Queue = self.SNFlowQueue;
const Filename = self.SNFlowFilename;
const DownloadPath = self.SNFlowDownloadPath;
const Pacing = self.SNFlowPacing;
const Sniffer = self.SNFlowSniffer;

// in-memory loop guard (per worker lifetime) and shared pacer
let loopRunning = false;
let pacer = null; // lazily created from current settings
let lastFlowTabId = null; // last known tab the run loop talked to

async function getOrMakePacer() {
  const settings = await Storage.getSettings();
  if (!pacer) {
    pacer = Pacing.makePacer(settings);
  } else {
    pacer.updateSettings(settings);
  }
  return pacer;
}

// Wire the network sniffer once per service-worker lifetime. The listener
// stays subscribed across run/stop cycles — the run loop reads the pacer
// state lazily, so signals always have an effect regardless of timing.
Sniffer.start();
Sniffer.onSignal(async (sig) => {
  try {
    if (sig.kind === "rate-limit") {
      Log.warn("network rate-limit signal", { status: sig.status, url: sig.url });
      const p = await getOrMakePacer();
      p.onRateLimited(sig.reason || `HTTP ${sig.status}`);
      await maybePauseOnStreak(p);
    } else if (sig.kind === "auth-lost") {
      Log.warn("auth-lost signal", { status: sig.status });
      // do nothing automatic — let the user re-login. We surface a status.
      await Storage.setRunState({ paused: true });
    }
  } catch (e) {
    Log.error("sniffer handler error", String(e && e.message || e));
  }
});

async function maybePauseOnStreak(p) {
  const settings = await Storage.getSettings();
  if (!settings.pauseOnRateLimit) return;
  const limit = settings.rateLimitPauseAfterStreak || 3;
  const st = p.getState();
  if (st.errorStreak >= limit) {
    Log.warn("pausing queue after rate-limit streak", st.errorStreak);
    await Storage.setRunState({ paused: true });
  }
}

const FLOW_URL_MATCH = /(^|\.)(labs\.google|flow\.google|aitestkitchen\.withgoogle\.com)/i;

// ---------------- helpers ----------------
async function findFlowTab() {
  const tabs = await new Promise((res) => chrome.tabs.query({}, (t) => res(t || [])));
  // prefer active focused tab if it's Flow
  const active = tabs.find((t) => t.active && t.url && FLOW_URL_MATCH.test(new URL(t.url).hostname));
  if (active) return active;
  return tabs.find((t) => t.url && FLOW_URL_MATCH.test(new URL(t.url).hostname)) || null;
}

function sendToTab(tabId, msg, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; reject(new Error("tab message timeout")); } }, timeoutMs);
    try {
      chrome.tabs.sendMessage(tabId, msg, (resp) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const err = chrome.runtime && chrome.runtime.lastError;
        if (err) return reject(new Error(err.message));
        resolve(resp);
      });
    } catch (e) { clearTimeout(timer); reject(e); }
  });
}

async function pingContent(tabId) {
  try {
    const resp = await sendToTab(tabId, { type: "SN_FLOW_PING" }, 4_000);
    return resp && resp.ok ? resp : null;
  } catch (_) { return null; }
}

async function ensureContentInjected(tabId) {
  const ok = await pingContent(tabId);
  if (ok) return true;
  // try programmatic injection as a fallback
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [
        "core/logger.js",
        "core/retry.js",
        "core/filename-template.js",
        "core/download-path.js",
        "core/pacing.js",
        "content/flow-detector.js",
        "content/flow-settings.js",
        "content/prompt-input.js",
        "content/generate-button.js",
        "content/flow-add-media.js",
        "content/result-watcher.js",
        "content/downloader.js",
        "content/dom-error-watcher.js",
        "content/floating-monitor.js",
        "content/content.js",
      ],
    });
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["content/floating-monitor.css"] });
  } catch (e) {
    Log.warn("ensureContentInjected: scripting.executeScript failed", String(e && e.message || e));
    return false;
  }
  await Retry.sleep(500);
  return !!(await pingContent(tabId));
}

// ---------------- run loop ----------------
async function runLoop() {
  if (loopRunning) return;
  loopRunning = true;
  try {
    while (true) {
      const run = await Storage.getRunState();
      if (!run.running) break;
      if (run.paused) { await Retry.sleep(500); continue; }

      const queue = await Storage.getQueue();
      const settings = await Storage.getSettings();

      // Auto-skip chained video items whose parent failed/skipped — they
      // can never produce a valid input image, so we don't want them to
      // block the queue or flap as "pending" forever. We do this BEFORE
      // nextPending() so the skipped state is persistent and visible.
      let mutated = false;
      const updated = queue.map((q) => {
        if (Queue.shouldAutoSkip(queue, q) && q.status === "pending") {
          mutated = true;
          return {
            ...q,
            status: "skipped",
            error: "parent image step did not complete",
            updatedAt: Date.now(),
          };
        }
        return q;
      });
      if (mutated) {
        await Storage.setQueue(updated);
        continue; // re-read queue with auto-skips applied
      }

      let next = Queue.nextPending(queue, { chainRunOrder: settings.chainRunOrder });
      if (!next) {
        Log.log("queue done");
        await Storage.setRunState({ running: false, paused: false, currentId: null, skipRequestedFor: null });
        break;
      }

      // Stamp the queue position (1-based) onto the dispatched item so the
      // content script can substitute it into the {index} filename token.
      // We compute it here (against the current queue snapshot) rather
      // than in content/content.js because the SW is the only place that
      // sees the canonical queue ordering.
      const queueIndex = queue.findIndex((q) => q.id === next.id) + 1;
      next = { ...next, queueIndex };

      // Chain video step: copy the parent image's mediaUrl onto the
      // outgoing item as inputMediaUrl so the content script can attach
      // it as the video input. PR #6 sets the field but content/content.js
      // doesn't yet use it (PR #7 wires attachInputImage). The defaulting
      // is defensive — Queue.nextPending already gates on parent.completed.
      if (next.chainStep === "video" && next.parentId) {
        const parent = queue.find((q) => q.id === next.parentId);
        if (parent && parent.status === "completed" && (parent.mediaUrl || parent.filename)) {
          next = {
            ...next,
            inputMediaUrl: parent.mediaUrl || null,
            inputFilename: parent.filename || null,
          };
        }
      }

      await Storage.setRunState({ currentId: next.id });
      await Storage.updateItem(next.id, { status: "sending", attempts: (next.attempts || 0) + 1 });

      const tab = await findFlowTab();
      if (!tab) {
        Log.error("no Flow tab open");
        await Storage.updateItem(next.id, { status: "failed", error: "Open https://labs.google/flow first" });
        // soft-stop: keep the queue intact but stop the loop
        await Storage.setRunState({ running: false, paused: false, currentId: null, skipRequestedFor: null });
        break;
      }
      lastFlowTabId = tab.id;

      const ready = await ensureContentInjected(tab.id);
      if (!ready) {
        Log.error("content script unavailable in Flow tab", { tabId: tab.id });
        await Storage.updateItem(next.id, { status: "failed", error: "Content script unavailable" });
        await Storage.setRunState({ running: false, paused: false, currentId: null, skipRequestedFor: null });
        break;
      }

      const p = await getOrMakePacer();
      let succeeded = false;

      // Helper: was this item skipped by the user since we set currentId?
      // skipCurrent() writes runState.skipRequestedFor=id when the user
      // hits Skip. We poll this so long awaits (waitForBatch's 5-min
      // timeout) don't block the run loop.
      const wasSkipped = async () => {
        const r = await Storage.getRunState();
        return r && r.skipRequestedFor === next.id;
      };
      const waitForSkip = (signal) => new Promise((resolve) => {
        const tick = async () => {
          if (signal && signal.aborted) return;
          if (await wasSkipped()) { resolve({ skipped: true }); return; }
          setTimeout(tick, 500);
        };
        tick();
      });

      try {
        const ac = { aborted: false };
        // The content script's runItem awaits result-watcher with a per-item
        // timeout that depends on item type — chain video uses a longer
        // chainVideoTimeoutMs (default 8 min). The SW must wait at least as
        // long as the content script, otherwise it kills the message channel
        // mid-generation and marks an in-flight item failed even when Flow
        // eventually finishes successfully.
        const contentTimeout = next.chainStep === "video"
          ? (settings.chainVideoTimeoutMs || 480_000)
          : (settings.waitTimeoutMs || 300_000);
        const respPromise = sendToTab(tab.id, {
          type: "SN_FLOW_RUN_ITEM",
          payload: { item: next, settings },
        }, contentTimeout + 60_000)
          .then((resp) => ({ resp }))
          .catch((e) => ({ err: e }));
        const skipPromise = waitForSkip(ac).then(() => ({ skipped: true }));
        const winner = await Promise.race([respPromise, skipPromise]);
        ac.aborted = true; // stop the skip poller

        if (winner.skipped || (await wasSkipped())) {
          // User skipped this item. The runItem promise may still be
          // pending in the content script — best-effort, we already sent
          // SN_FLOW_SKIP from skipCurrent() so it'll abort soon. The
          // queue item is already marked 'skipped' by skipCurrent(); we
          // just clear the flag and advance.
          await Storage.setRunState({ skipRequestedFor: null });
          Log.log("item skipped (user)", { id: next.id });
          // Don't await respPromise — it'll resolve later but we ignore it
        } else if (winner.err) {
          throw winner.err;
        } else {
          const resp = winner.resp;
          if (resp && resp.ok) {
            await Storage.updateItem(next.id, {
              status: "completed",
              error: undefined,
              filename: resp.filename,
              mediaUrl: resp.mediaUrl,
            });
            p.onItemCompleted();
            succeeded = true;
            Log.log("item completed", { id: next.id, filename: resp.filename, pacer: p.getState() });
          } else {
            const errMsg = (resp && resp.error) || "unknown error";
            // user-skipped from the content script: do nothing — already marked
            if (/user.?skipped/i.test(errMsg)) {
              await Storage.setRunState({ skipRequestedFor: null });
              Log.log("item skipped (content)", { id: next.id });
            } else {
              if (Pacing.isRateLimitMessage(errMsg)) {
                p.onRateLimited(errMsg);
                await maybePauseOnStreak(p);
              }
              const attempts = (next.attempts || 0) + 1;
              if (attempts < (settings.maxAttempts || 3)) {
                await Storage.updateItem(next.id, { status: "pending", error: errMsg });
                Log.warn("item retrying", { id: next.id, attempts, errMsg });
              } else {
                await Storage.updateItem(next.id, { status: "failed", error: errMsg });
                Log.error("item failed", { id: next.id, errMsg });
              }
            }
          }
        }
      } catch (e) {
        const errMsg = String((e && e.message) || e);
        // If user skipped during the in-flight call, treat as skipped, not error
        if (await wasSkipped()) {
          await Storage.setRunState({ skipRequestedFor: null });
          Log.log("item skipped (during error)", { id: next.id, errMsg });
        } else {
          if (Pacing.isRateLimitMessage(errMsg)) {
            p.onRateLimited(errMsg);
            await maybePauseOnStreak(p);
          }
          const attempts = (next.attempts || 0) + 1;
          if (attempts < (settings.maxAttempts || 3)) {
            await Storage.updateItem(next.id, { status: "pending", error: errMsg });
          } else {
            await Storage.updateItem(next.id, { status: "failed", error: errMsg });
          }
          Log.error("runLoop send error", errMsg);
        }
      }

      await Storage.setRunState({ currentId: null });

      // Pacing — replace the old fixed perItemDelayMs with adaptive delay.
      // We still respect pause/stop while sleeping by polling.
      const delayMs = p.nextDelayMs();
      Log.log("pacing next", {
        delayMs,
        succeeded,
        state: p.getState(),
      });
      await sleepWithControl(delayMs);
    }
  } finally {
    loopRunning = false;
  }
}

// sleepWithControl: like Retry.sleep but exits early if running flips off.
// Polls every 500 ms so Stop / Pause feel snappy regardless of delay length.
async function sleepWithControl(totalMs) {
  if (!totalMs || totalMs <= 0) return;
  const start = Date.now();
  const STEP = 500;
  while (Date.now() - start < totalMs) {
    const run = await Storage.getRunState();
    if (!run.running) return;
    if (run.paused) {
      await Retry.sleep(STEP);
      continue;
    }
    const remaining = totalMs - (Date.now() - start);
    await Retry.sleep(Math.min(STEP, Math.max(0, remaining)));
  }
}

// ---------------- commands ----------------
async function startQueue() {
  const queue = await Storage.getQueue();
  if (!queue.some((q) => q.status === "pending")) {
    Log.warn("startQueue called with no pending items");
    return { ok: false, error: "no pending items" };
  }
  // Always clear any stale skip flag from a previous Skip→Stop race
  // (otherwise the run loop could silently auto-skip the first matching
  // re-queued item).
  await Storage.setRunState({ running: true, paused: false, skipRequestedFor: null });
  runLoop();
  return { ok: true };
}

async function pauseQueue() {
  await Storage.setRunState({ paused: true });
  return { ok: true };
}

async function resumeQueue() {
  await Storage.setRunState({ running: true, paused: false });
  runLoop();
  return { ok: true };
}

async function stopQueue() {
  // Stop = halt + full reset.
  // Every item (including completed/failed/skipped) goes back to pending so the
  // next Start begins again from item 1. Pacer state is reset so streak/cooldown
  // is forgotten. Pause/Resume are intentionally NOT this — they preserve state.
  const queue = await Storage.getQueue();
  const reset = queue.map((q) => ({
    ...q,
    status: "pending",
    attempts: 0,
    error: undefined,
    filename: undefined,
    filenames: undefined,
    mediaUrl: undefined,
    downloadId: undefined,
    updatedAt: Date.now(),
  }));
  await Storage.setQueue(reset);
  // Clear skip flag too: stopQueue resets all items to pending with the same
  // ids, so any leftover skipRequestedFor would silently auto-skip on Start.
  await Storage.setRunState({ running: false, paused: false, currentId: null, skipRequestedFor: null });
  if (pacer) pacer.reset();
  Log.log("queue stopped + fully reset", { count: reset.length });
  return { ok: true, resetCount: reset.length };
}

async function retryFailed() {
  const queue = await Storage.getQueue();
  await Storage.setQueue(Queue.resetFailed(queue));
  return { ok: true };
}

async function clearQueue() {
  await Storage.setQueue([]);
  await Storage.setRunState({ running: false, paused: false, currentId: null, skipRequestedFor: null });
  return { ok: true };
}

// Skip the currently running item.
//   1. Mark it as 'skipped' in the queue immediately (so UI updates).
//   2. Set runState.skipRequestedFor = id so the run-loop knows to ignore
//      whatever the in-flight runItem eventually resolves with (instead of
//      overwriting 'skipped' with 'completed' or 'failed').
//   3. Best-effort: send SN_FLOW_SKIP to the Flow tab so its in-flight
//      `runItem` Promise rejects early with 'user-skipped'. If the content
//      script isn't wired for it (older build) or the tab is closed, the
//      skip still works — we just wait until runItem returns naturally and
//      drop its result.
async function skipCurrent() {
  const run = await Storage.getRunState();
  const id = run && run.currentId;
  if (!id) return { ok: false, error: "no current item" };
  // Race guard: the run loop may have already marked the item terminal
  // (completed/failed/skipped) but not yet cleared currentId (line ~322).
  // If we blindly write 'skipped' here we'd overwrite a real completion
  // and confuse the queue UI even though the download already happened.
  // In that case we just no-op the status update — the loop is about to
  // advance anyway, and there's nothing to abort in the content script.
  const queue = await Storage.getQueue();
  const cur = queue.find((q) => q.id === id);
  const terminal = cur && /^(completed|failed|skipped)$/.test(cur.status);
  if (terminal) {
    Log.log("skip ignored (item already terminal)", { id, status: cur.status });
    return { ok: false, error: `item already ${cur.status}` };
  }
  await Storage.updateItem(id, { status: "skipped", error: "user skipped" });
  await Storage.setRunState({ skipRequestedFor: id });
  if (lastFlowTabId) {
    try { chrome.tabs.sendMessage(lastFlowTabId, { type: "SN_FLOW_SKIP", payload: { id } }, () => void chrome.runtime.lastError); } catch (_) {}
  }
  Log.log("skip current", { id });
  return { ok: true, id };
}

// ---------------- downloads ----------------
// `filename` from the content script is just the body+ext (e.g.
// "SN_flow_A7K2Q_05052026.png"). The SW prepends the user's configured
// `outputFolder` (relative to Downloads/) and applies the user's chosen
// `conflictAction`. This way the popup is the single source of truth for
// folder + conflict policy, and the content script only worries about the
// file body. See core/download-path.js for sanitization rules.
async function downloadUrl(url, filename, opts) {
  const settings = await Storage.getSettings();
  const folder = DownloadPath.sanitizeOutputFolder(settings.outputFolder);
  // Expand tokens that may appear in folder segments (e.g. {ddmmyyyy}).
  // The filename body has already been expanded by the content script —
  // we don't re-expand it here.
  const ctx = (opts && opts.ctx) || {};
  const expandedFolder = folder
    ? folder.split("/").map((seg) => DownloadPath.expandTemplate(seg, ctx)).join("/")
    : "";
  const safeBody = DownloadPath.sanitizeFilenameBody(
    String(filename || "").replace(/^\/+/, "").split("/").pop() || "untitled",
  );
  const path = expandedFolder ? `${expandedFolder}/${safeBody}` : safeBody;
  const conflictAction = settings.conflictAction === "overwrite" ? "overwrite" : "uniquify";
  return new Promise((resolve) => {
    try {
      chrome.downloads.download({
        url,
        filename: path,
        saveAs: false,
        conflictAction,
      }, (id) => {
        const err = chrome.runtime && chrome.runtime.lastError;
        if (err || !id) resolve({ ok: false, error: (err && err.message) || "download failed", path });
        else {
          // Track the most recent download id so the popup's "Open Last
          // Download" button can call chrome.downloads.show(id). Best-effort.
          Storage.setSettings({ lastDownloadId: id }).catch(() => {});
          resolve({ ok: true, id, path });
        }
      });
    } catch (e) { resolve({ ok: false, error: String(e && e.message || e) }); }
  });
}

// ---------------- message router ----------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "SN_FLOW_DOWNLOAD") {
    const { url, filename, ctx } = msg.payload || {};
    if (!url || !filename) { sendResponse({ ok: false, error: "missing url/filename" }); return false; }
    downloadUrl(url, filename, { ctx }).then((r) => sendResponse(r));
    return true;
  }

  if (msg.type === "SN_FLOW_OPEN_LAST_DOWNLOAD") {
    // Open the location of the most recently downloaded file. Falls back
    // to opening the default Downloads folder if no id is recorded yet,
    // or if the id has been erased by the user.
    Storage.getSettings().then((settings) => {
      const id = settings && settings.lastDownloadId;
      if (id != null && chrome.downloads && typeof chrome.downloads.show === "function") {
        try {
          chrome.downloads.show(id);
          sendResponse({ ok: true, id });
          return;
        } catch (e) {
          // fall through to default folder
        }
      }
      try {
        if (chrome.downloads && typeof chrome.downloads.showDefaultFolder === "function") {
          chrome.downloads.showDefaultFolder();
        }
        sendResponse({ ok: true, fallback: "defaultFolder" });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    }).catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }

  if (msg.type === "SN_FLOW_OPEN_DOWNLOADS_FOLDER") {
    try {
      if (chrome.downloads && typeof chrome.downloads.showDefaultFolder === "function") {
        chrome.downloads.showDefaultFolder();
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: "showDefaultFolder not supported" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
    return false;
  }

  if (msg.type === "SN_FLOW_STATUS") {
    const { id, status } = msg.payload || {};
    if (id && status) Storage.updateItem(id, { status }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "SN_FLOW_RATE_LIMIT") {
    // From content/dom-error-watcher.js — Flow showed a rate-limit toast.
    const reason = (msg.payload && msg.payload.reason) || "rate-limit toast";
    Log.warn("DOM rate-limit signal", { reason });
    getOrMakePacer().then((p) => {
      p.onRateLimited(reason);
      return maybePauseOnStreak(p);
    }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "SN_FLOW_OPEN_POPUP") {
    // Floating panel → SW: programmatically open the chrome.action popup.
    // chrome.action.openPopup() is Chrome 127+. Older browsers (or non-
    // Chromium) don't have it; in that case we flash the toolbar badge
    // ("OPEN") for a few seconds so the user notices and clicks the icon
    // manually.
    const flashBadge = () => {
      try {
        chrome.action.setBadgeBackgroundColor({ color: "#f05053" });
        chrome.action.setBadgeText({ text: "OPEN" });
        setTimeout(() => {
          try { chrome.action.setBadgeText({ text: "" }); } catch (_) {}
        }, 4000);
      } catch (_) {}
    };
    if (chrome.action && typeof chrome.action.openPopup === "function") {
      try {
        const ret = chrome.action.openPopup();
        if (ret && typeof ret.then === "function") {
          ret.then(() => sendResponse({ ok: true, opened: true }))
             .catch((e) => {
               flashBadge();
               sendResponse({ ok: false, error: String((e && e.message) || e), badgeFlashed: true });
             });
          return true;
        }
        // Some browsers return undefined synchronously
        sendResponse({ ok: true, opened: true });
        return false;
      } catch (e) {
        flashBadge();
        sendResponse({ ok: false, error: String((e && e.message) || e), badgeFlashed: true });
        return false;
      }
    }
    flashBadge();
    sendResponse({ ok: false, error: "openPopup not supported", badgeFlashed: true });
    return false;
  }

  if (msg.type === "SN_FLOW_PACING") {
    // popup/floating-monitor: read pacer state for live UI
    getOrMakePacer().then((p) => {
      sendResponse({ ok: true, state: p.getState() });
    }).catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }

  if (msg.type === "SN_FLOW_FETCH_BLOB") {
    // CORS-fallback for content/flow-add-media.js: when the page-context
    // fetch is blocked, the SW fetches the URL (different origin context)
    // and returns the result as a data: URL the content script can rehydrate.
    const url = (msg.payload && msg.payload.url) || "";
    if (!url) { sendResponse({ ok: false, error: "missing url" }); return false; }
    (async () => {
      try {
        const r = await fetch(url, { credentials: "include" });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const buf = await r.arrayBuffer();
        const mime = r.headers.get("content-type") || "image/png";
        // Convert ArrayBuffer to base64 data URL (chunked to avoid stack overflow)
        const bytes = new Uint8Array(buf);
        let bin = "";
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        const b64 = btoa(bin);
        sendResponse({ ok: true, dataUrl: "data:" + mime + ";base64," + b64, bytes: bytes.length });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  if (msg.type === "SN_FLOW_CMD") {
    const cmd = (msg.payload && msg.payload.cmd) || "";
    let p;
    switch (cmd) {
      case "START": p = startQueue(); break;
      case "PAUSE": p = pauseQueue(); break;
      case "RESUME": p = resumeQueue(); break;
      case "STOP": p = stopQueue(); break;
      case "RETRY_FAILED": p = retryFailed(); break;
      case "CLEAR": p = clearQueue(); break;
      case "SKIP": p = skipCurrent(); break;
      default: sendResponse({ ok: false, error: "unknown cmd" }); return false;
    }
    p.then((r) => sendResponse(r)).catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }

  return false;
});

// Action button: open popup (default) or toggle monitor on Flow tabs.
// MV3 popup is set in manifest, so the user clicking the action opens popup.
// This handler is here for keyboard / future commands if added.
chrome.runtime.onInstalled.addListener(async () => {
  Log.log("SN Flow Auto installed");
  // initialize defaults on first install
  const settings = await Storage.getSettings();
  await Storage.setSettings(settings);
  const run = await Storage.getRunState();
  if (run.running) {
    // safer to mark not running on reinstall/upgrade
    await Storage.setRunState({ running: false, paused: false, currentId: null });
  }
});

// Recover: if browser restarts and a run was mid-flight, mark active items pending
chrome.runtime.onStartup && chrome.runtime.onStartup.addListener(async () => {
  const queue = await Storage.getQueue();
  await Storage.setQueue(Queue.resetActive(queue));
  await Storage.setRunState({ running: false, paused: false, currentId: null });
});

// ---------------- tab lifecycle: stop run cleanly when Flow tab vanishes ----------------
//
// If the user closes the Flow tab or navigates it to a non-Flow URL while a
// run is in progress, the content script disappears and chrome.tabs.sendMessage
// hangs / errors. We watch tabs.onRemoved and tabs.onUpdated to:
//   - mark the in-flight item back to pending (so Retry Failed picks it up)
//   - pause the run with a clear error state so the popup tells the user
async function revertInFlightAndStop(reason) {
  // Best-effort: revert the in-flight item to pending so it isn't lost, then
  // also defensively reset any other active-status items (only one item runs
  // at a time today, but this guards against stale state). Stops the run.
  const run = await Storage.getRunState();
  if (!run || !run.running) return;
  const queue = await Storage.getQueue();
  const reset = Queue.resetActive(queue);
  if (run.currentId) {
    const idx = reset.findIndex((q) => q.id === run.currentId);
    if (idx !== -1) {
      reset[idx] = { ...reset[idx], status: "pending", error: reason, updatedAt: Date.now() };
    }
  }
  await Storage.setQueue(reset);
  await Storage.setRunState({ running: false, paused: false, currentId: null });
}

chrome.tabs && chrome.tabs.onRemoved && chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (lastFlowTabId !== tabId) return;
  Log.warn("Flow tab closed mid-run", { tabId });
  await revertInFlightAndStop("Flow tab closed");
  lastFlowTabId = null;
});

chrome.tabs && chrome.tabs.onUpdated && chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (lastFlowTabId !== tabId) return;
  if (!tab || !tab.url) return;
  let stillFlow = false;
  try { stillFlow = FLOW_URL_MATCH.test(new URL(tab.url).hostname); } catch (_) {}
  if (stillFlow) return;
  Log.warn("Flow tab navigated away mid-run", { tabId, url: tab.url });
  await revertInFlightAndStop("Flow tab navigated away");
  lastFlowTabId = null;
});
