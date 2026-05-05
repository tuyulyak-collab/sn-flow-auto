/* content/floating-monitor.js — draggable, minimizable monitor injected into Google Flow.
 * Reads queue/run state from chrome.storage.local; sends pause/resume/stop messages
 * to the background service worker.
 */
(function (root) {
  const STATE = {
    open: false,
    minimized: false,
    pos: null, // { left, top }
  };

  let fabEl, monitorEl;
  let bodyEls = {}; // cached DOM refs

  function makeEl(tag, attrs = {}, children = []) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else el.setAttribute(k, v);
    }
    for (const c of children) el.appendChild(c);
    return el;
  }

  function ensureInjected() {
    if (!document.body) return false;
    if (!fabEl) {
      fabEl = makeEl("div", { id: "snflow-fab", title: "SN Flow Auto" });
      fabEl.textContent = "SN";
      fabEl.addEventListener("click", toggleOpen);
      document.body.appendChild(fabEl);
    }
    if (!monitorEl) {
      monitorEl = buildMonitor();
      document.body.appendChild(monitorEl);
    }
    return true;
  }

  function buildMonitor() {
    const head = makeEl("div", { class: "snflow-head" });
    const title = makeEl("div", { class: "snflow-title", text: "SN Flow Auto" });
    const pill = makeEl("div", { class: "snflow-pill", text: "idle" });
    const minBtn = makeEl("button", { class: "snflow-iconbtn", title: "Minimize", text: "—" });
    const closeBtn = makeEl("button", { class: "snflow-iconbtn", title: "Close", text: "×" });
    minBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleMinimize(); });
    closeBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleOpen(false); });
    head.appendChild(title); head.appendChild(pill);
    head.appendChild(minBtn); head.appendChild(closeBtn);
    bodyEls.pill = pill;

    const body = makeEl("div", { class: "snflow-body" });
    const rowStatus = makeEl("div", { class: "snflow-row" });
    rowStatus.appendChild(makeEl("div", { class: "snflow-key", text: "Status" }));
    bodyEls.status = makeEl("div", { class: "snflow-val", text: "idle" });
    rowStatus.appendChild(bodyEls.status);

    const rowProgress = makeEl("div", { class: "snflow-row" });
    rowProgress.appendChild(makeEl("div", { class: "snflow-key", text: "Progress" }));
    bodyEls.progress = makeEl("div", { class: "snflow-val", text: "0 / 0" });
    rowProgress.appendChild(bodyEls.progress);

    bodyEls.bar = makeEl("div", { class: "snflow-progress" });
    bodyEls.barFill = makeEl("span");
    bodyEls.bar.appendChild(bodyEls.barFill);

    const rowCurrent = makeEl("div", { class: "snflow-row" });
    rowCurrent.appendChild(makeEl("div", { class: "snflow-key", text: "Current" }));
    bodyEls.current = makeEl("div", { class: "snflow-val", text: "—" });
    rowCurrent.appendChild(bodyEls.current);

    bodyEls.prompt = makeEl("div", { class: "snflow-prompt", text: "—" });
    bodyEls.log = makeEl("div", { class: "snflow-log", text: "Waiting…" });

    body.appendChild(rowStatus);
    body.appendChild(rowProgress);
    body.appendChild(bodyEls.bar);
    body.appendChild(rowCurrent);
    body.appendChild(bodyEls.prompt);
    body.appendChild(bodyEls.log);

    const foot = makeEl("div", { class: "snflow-foot" });
    bodyEls.btnPause = makeEl("button", { class: "snflow-btn", text: "Pause" });
    bodyEls.btnResume = makeEl("button", { class: "snflow-btn snflow-primary", text: "Resume" });
    bodyEls.btnStop = makeEl("button", { class: "snflow-btn", text: "Stop" });
    bodyEls.btnPause.addEventListener("click", () => sendCmd("PAUSE"));
    bodyEls.btnResume.addEventListener("click", () => sendCmd("RESUME"));
    bodyEls.btnStop.addEventListener("click", () => {
      // Stop halts and resets every queue item to Pending — confirm first.
      // Pause/Resume preserves state, so users who want that should use Pause.
      const ok = window.confirm(
        "Stop will halt all processing immediately and reset every queue item back to Pending.\n\n" +
        "Next Start will begin again from item 1.\n\n" +
        "(Pause/Resume preserves state — use Pause if you want to keep position.)\n\n" +
        "Continue?",
      );
      if (!ok) return;
      sendCmd("STOP");
    });
    foot.appendChild(bodyEls.btnPause);
    foot.appendChild(bodyEls.btnResume);
    foot.appendChild(bodyEls.btnStop);

    const wrap = makeEl("div", { id: "snflow-monitor" });
    wrap.appendChild(head);
    wrap.appendChild(body);
    wrap.appendChild(foot);

    enableDrag(wrap, head);
    return wrap;
  }

  function enableDrag(panel, handle) {
    let dragging = false;
    let startX = 0, startY = 0;
    let origLeft = 0, origTop = 0;
    handle.addEventListener("mousedown", (e) => {
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      const rect = panel.getBoundingClientRect();
      origLeft = rect.left; origTop = rect.top;
      panel.style.transition = "none";
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const left = Math.max(8, Math.min(window.innerWidth - 80, origLeft + dx));
      const top = Math.max(8, Math.min(window.innerHeight - 40, origTop + dy));
      panel.style.left = left + "px";
      panel.style.top = top + "px";
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      STATE.pos = { left, top };
    });
    window.addEventListener("mouseup", () => { dragging = false; });
  }

  function toggleOpen(force) {
    if (!ensureInjected()) return;
    STATE.open = (typeof force === "boolean") ? force : !STATE.open;
    monitorEl.classList.toggle("snflow-open", STATE.open);
  }

  function toggleMinimize() {
    if (!monitorEl) return;
    STATE.minimized = !STATE.minimized;
    monitorEl.classList.toggle("snflow-min", STATE.minimized);
  }

  function sendCmd(type) {
    try {
      chrome.runtime.sendMessage({ type: "SN_FLOW_CMD", payload: { cmd: type } }, () => {
        const err = chrome.runtime && chrome.runtime.lastError;
        if (err && root.SNFlowLogger) root.SNFlowLogger.warn("monitor cmd error", err.message);
      });
    } catch (_) {}
  }

  function trim(s, n = 140) {
    if (!s) return "—";
    s = String(s).replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }

  function render({ runState, queue, currentItem, lastLog }) {
    if (!ensureInjected()) return;
    const sum = (root.SNFlowQueue || {}).summarize ? root.SNFlowQueue.summarize(queue || []) : { total: (queue||[]).length, done: 0 };
    const total = sum.total || 0;
    const done = sum.done || 0;
    const pct = total ? Math.round((done / total) * 100) : 0;

    let status = "idle";
    if (runState && runState.running) status = runState.paused ? "paused" : "running";

    bodyEls.pill.textContent = status;
    bodyEls.progress.textContent = `${done} / ${total}`;
    bodyEls.barFill.style.width = pct + "%";
    if (currentItem) {
      bodyEls.status.textContent = status + ` · ${currentItem.status}`;
      const ratio = currentItem.aspectRatio ? ` · ${currentItem.aspectRatio}` : "";
      const cnt = currentItem.outputCount && currentItem.outputCount > 1 ? ` · x${currentItem.outputCount}` : "";
      bodyEls.current.textContent = `${currentItem.mode || "?"}${ratio}${cnt} · #${(queue || []).indexOf(currentItem) + 1}`;
      bodyEls.prompt.textContent = trim(currentItem.prompt, 240);
    } else if (total > 0 && done === total) {
      // Run finished summary
      const c = sum.counts || {};
      const allOk = c.completed === total;
      bodyEls.status.textContent = allOk ? "done" : `done · ${c.completed || 0} ok, ${c.failed || 0} failed`;
      bodyEls.current.textContent = allOk ? "All items completed" : `${c.failed || 0} failed — use Retry`;
      bodyEls.prompt.textContent = "—";
    } else {
      bodyEls.status.textContent = status;
      bodyEls.current.textContent = "—";
      bodyEls.prompt.textContent = total === 0 ? "No prompts queued" : "—";
    }
    if (lastLog) bodyEls.log.textContent = lastLog;

    bodyEls.btnPause.disabled = !(runState && runState.running) || (runState && runState.paused);
    bodyEls.btnResume.disabled = !(runState && runState.running) || !(runState && runState.paused);
    bodyEls.btnStop.disabled = !(runState && runState.running);

    // Pacer state — show "cooling down" / streak count if backend reports one
    try {
      chrome.runtime.sendMessage({ type: "SN_FLOW_PACING" }, (resp) => {
        if (!resp || !resp.ok || !bodyEls.log) return;
        const st = resp.state || {};
        if (st.errorStreak && st.errorStreak > 0) {
          bodyEls.pill.textContent = `cooling × ${st.errorStreak}`;
          bodyEls.pill.style.background = "#fde2e2";
          bodyEls.pill.style.color = "#b6322f";
        } else {
          bodyEls.pill.style.background = "";
          bodyEls.pill.style.color = "";
        }
      });
    } catch (_) {}
  }

  async function refresh() {
    try {
      const got = await new Promise((resolve) => chrome.storage.local.get(
        ["snflow.queue", "snflow.runState", "snflow.logs"],
        (val) => resolve(val || {}),
      ));
      const queue = got["snflow.queue"] || [];
      const runState = got["snflow.runState"] || {};
      const logs = got["snflow.logs"] || [];
      const currentItem = runState.currentId ? queue.find((q) => q.id === runState.currentId) : null;
      render({ runState, queue, currentItem, lastLog: logs[logs.length - 1] });
    } catch (_) {}
  }

  function init() {
    if (!ensureInjected()) {
      // body might not be ready yet
      const obs = new MutationObserver(() => {
        if (document.body) { obs.disconnect(); ensureInjected(); refresh(); }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      return;
    }
    refresh();

    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        if (
          changes["snflow.queue"] ||
          changes["snflow.runState"] ||
          changes["snflow.logs"]
        ) refresh();
      });
    } catch (_) {}
  }

  // expose for content.js
  root.SNFlowMonitor = { init, toggleOpen, toggleMinimize, refresh };

  // auto-init when this script loads
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})(typeof self !== "undefined" ? self : this);
