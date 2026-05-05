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
 *
 *     // Chain-mode (Image → Video) linkage. Set when an item was created
 *     // from a "chain" prompt — one user-typed prompt expands into one
 *     // image step + one video step that depends on the image's mediaUrl.
 *     chainStep?: "image" | "video",
 *     parentId?: string,         // present on chainStep="video" items
 *     inputMediaUrl?: string,    // populated by run loop just before dispatch
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
    aspectRatio: "16:9",  // 16:9 / 4:3 / 1:1 / 3:4 / 9:16
    outputCount: 1,        // 1..4 — Flow's "x1" / "x2" / "x3" / "x4" tabs
    autoStart: false,
    waitTimeoutMs: 5 * 60 * 1000, // 5 min per prompt for video
    perItemDelayMs: 1500,           // legacy minimum baseline (kept for back-compat)
    maxAttempts: 3,
    promptInputDelayMs: 250,
    // ---- anti-bot pacing ----
    // Flow rate-limits aggressive automation. These settings drive the
    // pacer in core/pacing.js. The defaults aim to look like a focused
    // human (≈30–60 s between prompts) with periodic longer breaks.
    minDelayMs: 30_000,
    maxDelayMs: 60_000,
    jitterMs: 4_000,
    cooldownEvery: 5,           // every N prompts, take a longer pause
    cooldownMs: 180_000,        // 3 min cooldown
    adaptiveBackoff: true,
    backoffMultiplier: 2,
    backoffMaxMs: 15 * 60_000,
    backoffFloorMs: 90_000,
    aggressiveMode: false,      // dangerous: collapses all delays to 0
    pauseOnRateLimit: true,     // pause queue after 3 consecutive blocks
    rateLimitPauseAfterStreak: 3,

    // ---- Chain (Image → Video) mode ----
    // When mode === "chain", each user-typed prompt is expanded into
    // two queue items: an image step and a video step that depends on
    // the image's mediaUrl. These three settings control how the chain
    // behaves; all three are exposed as dropdowns in the popup.
    //
    // chainStrategy
    //   "first"  — chain only the FIRST image variant into a single video
    //              (1 prompt → 1 image batch + 1 video). Default.
    //   "all"    — chain EVERY image variant (1 prompt → x2 images + 2 videos).
    chainStrategy: "first",
    // chainPromptSource
    //   "same"   — video step reuses the image prompt verbatim. Default.
    //   "suffix" — append a fixed suffix to the prompt for the video step
    //              (uses chainPromptSuffix below).
    //   "custom" — user supplies a fully separate prompt per chain (UI for
    //              this is added in PR #8; treated as "same" for now).
    chainPromptSource: "same",
    chainPromptSuffix: "",
    // chainRunOrder
    //   "interleave" — image1 → video1 → image2 → video2 (default; finish
    //                  each prompt's chain before starting the next).
    //   "batch"      — image1 → image2 → ... → video1 → video2 (do all
    //                  images first, then all videos).
    chainRunOrder: "interleave",
    // chainVideoModel — best-effort model to select for the video step.
    // "auto" leaves whatever Flow currently has selected when the video
    // step starts. PR #7 adds explicit model-picker support (Veo, Veo-2).
    chainVideoModel: "auto",
    // chainVideoAspectRatio — let video step have its own ratio (e.g. image
    // 16:9 + video 9:16). null = follow image aspect ratio.
    chainVideoAspectRatio: null,
    // chainVideoTimeoutMs — video gen takes much longer than image; bump
    // the per-item wait timeout for chained video items only.
    chainVideoTimeoutMs: 8 * 60 * 1000, // 8 min
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
