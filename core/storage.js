/* core/storage.js — thin chrome.storage.local wrapper used by popup and service worker.
 *
 * Schema (kept flat & forward-compatible):
 *   snflow.queue     -> Array<QueueItem>
 *   snflow.settings  -> { mode, prefix, autoStart, downloadFolder, ... }
 *   snflow.runState  -> { running, paused, currentId }
 *   snflow.logs      -> last N log lines (written by logger.js)
 *
 * QueueItem shape:
 *   {
 *     id: string (uuid-ish),
 *     prompt: string,
 *     mode: "image" | "video",
 *     status: "pending" | "sending" | "generating" | "waiting"
 *           | "downloading" | "completed" | "failed" | "skipped",
 *     attempts: number,
 *     error?: string,
 *     filename?: string,
 *     downloadId?: number,
 *     mediaUrl?: string,
 *     createdAt: number,
 *     updatedAt: number,
 *   }
 */
(function (root) {
  const KEYS = {
    QUEUE: "snflow.queue",
    SETTINGS: "snflow.settings",
    RUN: "snflow.runState",
    LOGS: "snflow.logs",
  };

  const DEFAULT_SETTINGS = {
    mode: "image",
    autoStart: false,
    waitTimeoutMs: 5 * 60 * 1000, // 5 min per prompt for video
    perItemDelayMs: 1500,
    maxAttempts: 3,
    promptInputDelayMs: 250,
  };

  function get(keys) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.get(keys, (val) => {
          const err = chrome.runtime && chrome.runtime.lastError;
          if (err) reject(err);
          else resolve(val || {});
        });
      } catch (e) { reject(e); }
    });
  }

  function set(obj) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.set(obj, () => {
          const err = chrome.runtime && chrome.runtime.lastError;
          if (err) reject(err);
          else resolve();
        });
      } catch (e) { reject(e); }
    });
  }

  async function getQueue() {
    const v = await get(KEYS.QUEUE);
    return Array.isArray(v[KEYS.QUEUE]) ? v[KEYS.QUEUE] : [];
  }

  async function setQueue(queue) {
    await set({ [KEYS.QUEUE]: queue });
  }

  async function updateItem(id, patch) {
    const queue = await getQueue();
    const idx = queue.findIndex((q) => q.id === id);
    if (idx === -1) return null;
    queue[idx] = { ...queue[idx], ...patch, updatedAt: Date.now() };
    await setQueue(queue);
    return queue[idx];
  }

  async function getSettings() {
    const v = await get(KEYS.SETTINGS);
    return { ...DEFAULT_SETTINGS, ...(v[KEYS.SETTINGS] || {}) };
  }

  async function setSettings(patch) {
    const cur = await getSettings();
    const next = { ...cur, ...patch };
    await set({ [KEYS.SETTINGS]: next });
    return next;
  }

  async function getRunState() {
    const v = await get(KEYS.RUN);
    return v[KEYS.RUN] || { running: false, paused: false, currentId: null };
  }

  async function setRunState(patch) {
    const cur = await getRunState();
    const next = { ...cur, ...patch };
    await set({ [KEYS.RUN]: next });
    return next;
  }

  root.SNFlowStorage = {
    KEYS,
    DEFAULT_SETTINGS,
    get,
    set,
    getQueue, setQueue, updateItem,
    getSettings, setSettings,
    getRunState, setRunState,
  };
})(typeof self !== "undefined" ? self : this);
