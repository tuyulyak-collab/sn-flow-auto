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
        "core/pacing.js",
        "content/flow-detector.js",
        "content/flow-settings.js",
        "content/prompt-input.js",
        "content/generate-button.js",
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
      const next = Queue.nextPending(queue);
      if (!next) {
        Log.log("queue done");
        await Storage.setRunState({ running: false, paused: false, currentId: null });
        break;
      }

      const settings = await Storage.getSettings();
      await Storage.setRunState({ currentId: next.id });
      await Storage.updateItem(next.id, { status: "sending", attempts: (next.attempts || 0) + 1 });

      const tab = await findFlowTab();
      if (!tab) {
        Log.error("no Flow tab open");
        await Storage.updateItem(next.id, { status: "failed", error: "Open https://labs.google/flow first" });
        // soft-stop: keep the queue intact but stop the loop
        await Storage.setRunState({ running: false, paused: false, currentId: null });
        break;
      }
      lastFlowTabId = tab.id;

      const ready = await ensureContentInjected(tab.id);
      if (!ready) {
        Log.error("content script unavailable in Flow tab", { tabId: tab.id });
        await Storage.updateItem(next.id, { status: "failed", error: "Content script unavailable" });
        await Storage.setRunState({ running: false, paused: false, currentId: null });
        break;
      }

      const p = await getOrMakePacer();
      let succeeded = false;
      try {
        const resp = await sendToTab(tab.id, {
          type: "SN_FLOW_RUN_ITEM",
          payload: { item: next, settings },
        }, (settings.waitTimeoutMs || 300_000) + 60_000);

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
          // Treat heuristic rate-limit-y errors from content as a sniff signal too.
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
      } catch (e) {
        const errMsg = String((e && e.message) || e);
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
  await Storage.setRunState({ running: true, paused: false });
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
  // mark currentId item back to pending (best-effort)
  const run = await Storage.getRunState();
  if (run && run.currentId) {
    await Storage.updateItem(run.currentId, { status: "pending" });
  }
  // Reset any other in-flight statuses
  const queue = await Storage.getQueue();
  await Storage.setQueue(Queue.resetActive(queue));
  await Storage.setRunState({ running: false, paused: false, currentId: null });
  // Reset pacer too — fresh streak/cooldown on next Start
  if (pacer) pacer.reset();
  return { ok: true };
}

async function retryFailed() {
  const queue = await Storage.getQueue();
  await Storage.setQueue(Queue.resetFailed(queue));
  return { ok: true };
}

async function clearQueue() {
  await Storage.setQueue([]);
  await Storage.setRunState({ running: false, paused: false, currentId: null });
  return { ok: true };
}

// ---------------- downloads ----------------
async function downloadUrl(url, filename) {
  return new Promise((resolve) => {
    try {
      chrome.downloads.download({
        url,
        filename: `SN_Flow_Auto/${filename}`,
        saveAs: false,
        conflictAction: "uniquify",
      }, (id) => {
        const err = chrome.runtime && chrome.runtime.lastError;
        if (err || !id) resolve({ ok: false, error: (err && err.message) || "download failed" });
        else resolve({ ok: true, id });
      });
    } catch (e) { resolve({ ok: false, error: String(e && e.message || e) }); }
  });
}

// ---------------- message router ----------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "SN_FLOW_DOWNLOAD") {
    const { url, filename } = msg.payload || {};
    if (!url || !filename) { sendResponse({ ok: false, error: "missing url/filename" }); return false; }
    downloadUrl(url, filename).then((r) => sendResponse(r));
    return true;
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

  if (msg.type === "SN_FLOW_PACING") {
    // popup/floating-monitor: read pacer state for live UI
    getOrMakePacer().then((p) => {
      sendResponse({ ok: true, state: p.getState() });
    }).catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
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
chrome.tabs && chrome.tabs.onRemoved && chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (lastFlowTabId !== tabId) return;
  Log.warn("Flow tab closed mid-run", { tabId });
  const run = await Storage.getRunState();
  if (run && run.running) {
    if (run.currentId) {
      await Storage.updateItem(run.currentId, { status: "pending", error: "Flow tab closed" });
    }
    await Storage.setRunState({ running: false, paused: false, currentId: null });
  }
  lastFlowTabId = null;
});

chrome.tabs && chrome.tabs.onUpdated && chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (lastFlowTabId !== tabId) return;
  if (!tab || !tab.url) return;
  let stillFlow = false;
  try { stillFlow = FLOW_URL_MATCH.test(new URL(tab.url).hostname); } catch (_) {}
  if (stillFlow) return;
  Log.warn("Flow tab navigated away mid-run", { tabId, url: tab.url });
  const run = await Storage.getRunState();
  if (run && run.running) {
    if (run.currentId) {
      await Storage.updateItem(run.currentId, { status: "pending", error: "Flow tab navigated away" });
    }
    await Storage.setRunState({ running: false, paused: false, currentId: null });
  }
  lastFlowTabId = null;
});
