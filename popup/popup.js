/* popup/popup.js — popup UI logic.
 * Reads/writes queue + settings via core/storage.js.
 * Sends commands (START/PAUSE/RESUME/STOP/RETRY_FAILED/CLEAR) to background.
 * Subscribes to chrome.storage.onChanged for live updates while popup is open.
 */
(function () {
  const { SNFlowStorage: Storage, SNFlowQueue: Queue, SNFlowPromptParser: Parser } = self;

  const els = {};
  function $(id) { return document.getElementById(id); }

  function trim(s, n = 120) {
    if (!s) return "";
    s = String(s).replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }

  function statusTag(status) {
    const span = document.createElement("span");
    span.className = `snf-status-tag snf-status-${status || "pending"}`;
    span.textContent = (status || "pending").replace(/_/g, " ");
    return span;
  }

  function renderQueue(queue) {
    els.queueBody.innerHTML = "";
    queue.forEach((item, idx) => {
      const tr = document.createElement("tr");

      const tdIdx = document.createElement("td");
      tdIdx.textContent = String(idx + 1);

      const tdPrompt = document.createElement("td");
      tdPrompt.className = "snf-prompt-cell";
      tdPrompt.title = item.prompt;
      tdPrompt.textContent = trim(item.prompt, 80);

      const tdMode = document.createElement("td");
      tdMode.textContent = item.mode || "image";

      const tdStatus = document.createElement("td");
      tdStatus.appendChild(statusTag(item.status));
      if (item.error) {
        const e = document.createElement("div");
        e.className = "snf-meta";
        e.style.color = "#b6322f";
        e.textContent = trim(item.error, 80);
        tdStatus.appendChild(e);
      }
      if (item.filename) {
        const f = document.createElement("div");
        f.className = "snf-meta";
        f.textContent = item.filename;
        tdStatus.appendChild(f);
      }

      const tdActions = document.createElement("td");
      tdActions.className = "snf-row-actions";
      const retryBtn = document.createElement("button");
      retryBtn.className = "snf-icon-btn";
      retryBtn.title = "Retry";
      retryBtn.textContent = "⟳";
      retryBtn.addEventListener("click", () => retryItem(item.id));
      const skipBtn = document.createElement("button");
      skipBtn.className = "snf-icon-btn";
      skipBtn.title = "Skip";
      skipBtn.textContent = "↷";
      skipBtn.addEventListener("click", () => skipItem(item.id));
      const delBtn = document.createElement("button");
      delBtn.className = "snf-icon-btn";
      delBtn.title = "Remove";
      delBtn.textContent = "✕";
      delBtn.addEventListener("click", () => removeItem(item.id));
      tdActions.appendChild(retryBtn);
      tdActions.appendChild(skipBtn);
      tdActions.appendChild(delBtn);

      tr.appendChild(tdIdx);
      tr.appendChild(tdPrompt);
      tr.appendChild(tdMode);
      tr.appendChild(tdStatus);
      tr.appendChild(tdActions);
      els.queueBody.appendChild(tr);
    });

    const sum = Queue.summarize(queue);
    els.queueCount.textContent = `${sum.total} item${sum.total === 1 ? "" : "s"}`;
    const pct = sum.total ? Math.round((sum.done / sum.total) * 100) : 0;
    els.progressFill.style.width = pct + "%";
    els.progressText.textContent = `${sum.done} / ${sum.total}`;
    const parts = [];
    if (sum.counts.completed) parts.push(`${sum.counts.completed} done`);
    if (sum.counts.failed) parts.push(`${sum.counts.failed} failed`);
    if (sum.counts.skipped) parts.push(`${sum.counts.skipped} skipped`);
    els.progressStatus.textContent = parts.length ? parts.join(" · ") : "—";
  }

  function renderRunState(run) {
    let label = "idle";
    if (run.running) label = run.paused ? "paused" : "running";
    els.status.textContent = label;
    els.start.disabled = run.running;
    els.pause.disabled = !run.running || run.paused;
    els.resume.disabled = !run.running || !run.paused;
    els.stop.disabled = !run.running;
  }

  function renderLogs(logs) {
    if (!logs || !logs.length) { els.log.textContent = ""; return; }
    els.log.textContent = logs.slice(-100).join("\n");
    els.log.scrollTop = els.log.scrollHeight;
  }

  async function refresh() {
    const [queue, run, settings, all] = await Promise.all([
      Storage.getQueue(),
      Storage.getRunState(),
      Storage.getSettings(),
      Storage.get([Storage.KEYS.LOGS]),
    ]);
    renderQueue(queue);
    renderRunState(run);
    if (els.mode.value !== settings.mode) els.mode.value = settings.mode;
    renderLogs(all[Storage.KEYS.LOGS] || []);
  }

  // ---- queue mutations ----
  async function addPrompts() {
    const text = els.prompts.value;
    const mode = els.mode.value;
    const parsed = Parser.parsePrompts(text);
    if (!parsed.length) {
      els.importInfo.textContent = "no prompts";
      return;
    }
    const items = Parser.buildItems(parsed, mode);
    const cur = await Storage.getQueue();
    await Storage.setQueue(cur.concat(items));
    els.prompts.value = "";
    els.importInfo.textContent = `+${items.length} added`;
    await Storage.setSettings({ mode });
    await refresh();
  }

  async function importTxt(file) {
    const text = await file.text();
    const parsed = Parser.parsePrompts(text);
    const mode = els.mode.value;
    const items = Parser.buildItems(parsed, mode);
    const cur = await Storage.getQueue();
    await Storage.setQueue(cur.concat(items));
    els.importInfo.textContent = `+${items.length} from ${file.name}`;
    await refresh();
  }

  async function retryItem(id) {
    await Storage.updateItem(id, { status: "pending", error: undefined, attempts: 0 });
    await refresh();
  }
  async function skipItem(id) {
    await Storage.updateItem(id, { status: "skipped" });
    await refresh();
  }
  async function removeItem(id) {
    const queue = await Storage.getQueue();
    await Storage.setQueue(queue.filter((q) => q.id !== id));
    await refresh();
  }

  function sendCmd(cmd) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "SN_FLOW_CMD", payload: { cmd } }, (resp) => {
          const err = chrome.runtime && chrome.runtime.lastError;
          if (err) resolve({ ok: false, error: err.message });
          else resolve(resp || { ok: false });
        });
      } catch (e) { resolve({ ok: false, error: String(e && e.message || e) }); }
    });
  }

  function bind() {
    els.add.addEventListener("click", addPrompts);
    els.start.addEventListener("click", async () => { await sendCmd("START"); refresh(); });
    els.pause.addEventListener("click", async () => { await sendCmd("PAUSE"); refresh(); });
    els.resume.addEventListener("click", async () => { await sendCmd("RESUME"); refresh(); });
    els.stop.addEventListener("click", async () => { await sendCmd("STOP"); refresh(); });
    els.retry.addEventListener("click", async () => { await sendCmd("RETRY_FAILED"); refresh(); });
    els.clear.addEventListener("click", async () => {
      if (!confirm("Clear the entire queue?")) return;
      await sendCmd("CLEAR"); refresh();
    });
    els.logClear.addEventListener("click", async () => {
      await Storage.set({ [Storage.KEYS.LOGS]: [] });
      refresh();
    });
    els.file.addEventListener("change", () => {
      const f = els.file.files && els.file.files[0];
      if (f) importTxt(f).catch((e) => { els.importInfo.textContent = "error: " + (e.message || e); });
      els.file.value = "";
    });
    els.mode.addEventListener("change", async () => {
      await Storage.setSettings({ mode: els.mode.value });
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes[Storage.KEYS.QUEUE] || changes[Storage.KEYS.RUN] || changes[Storage.KEYS.LOGS] || changes[Storage.KEYS.SETTINGS]) {
        refresh();
      }
    });
  }

  function init() {
    Object.assign(els, {
      mode: $("snf-mode"),
      prompts: $("snf-prompts"),
      file: $("snf-file"),
      importInfo: $("snf-import-info"),
      add: $("snf-add"),
      start: $("snf-start"),
      pause: $("snf-pause"),
      resume: $("snf-resume"),
      stop: $("snf-stop"),
      retry: $("snf-retry"),
      clear: $("snf-clear"),
      status: $("snf-status"),
      progressFill: $("snf-progress-fill"),
      progressText: $("snf-progress-text"),
      progressStatus: $("snf-progress-status"),
      queueBody: $("snf-queue-body"),
      queueCount: $("snf-queue-count"),
      log: $("snf-log"),
      logClear: $("snf-log-clear"),
    });
    bind();
    refresh();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
