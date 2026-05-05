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

  let fabEl, monitorEl, confirmEl;
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
    if (!confirmEl) {
      confirmEl = buildConfirmDialog();
      document.body.appendChild(confirmEl);
    }
    return true;
  }

  // In-page <dialog> we use instead of native window.confirm(). MV3 popups
  // (and some Chromium configurations like --enable-automation) suppress
  // the native confirm modal, which silently returns false. Using
  // HTMLDialogElement.showModal() keeps focus inside the page and works
  // reliably regardless of the surrounding browser flags.
  function buildConfirmDialog() {
    const d = makeEl("dialog", { id: "snflow-confirm" });
    const body = makeEl("div", { class: "snflow-confirm-body" });
    const title = makeEl("h3", { class: "snflow-confirm-title", text: "Confirm" });
    const msg = makeEl("p", { class: "snflow-confirm-message", text: "" });
    body.appendChild(title);
    body.appendChild(msg);
    const actions = makeEl("div", { class: "snflow-confirm-actions" });
    const cancel = makeEl("button", { type: "button", class: "snflow-btn", text: "Cancel" });
    const ok = makeEl("button", { type: "button", class: "snflow-btn snflow-primary", text: "OK" });
    actions.appendChild(cancel);
    actions.appendChild(ok);
    d.appendChild(body);
    d.appendChild(actions);
    d._snflow = { title, msg, cancel, ok };
    return d;
  }

  // Promise-based confirm. Returns true on OK, false on Cancel / dismiss.
  function snfConfirm(message, opts) {
    if (!ensureInjected()) return Promise.resolve(false);
    const o = opts || {};
    const { title, msg, cancel, ok } = confirmEl._snflow;
    title.textContent = o.title || "Confirm";
    msg.textContent = String(message || "");
    cancel.textContent = o.cancelText || "Cancel";
    ok.textContent = o.okText || "OK";
    return new Promise((resolve) => {
      const cleanup = (v) => {
        cancel.removeEventListener("click", onCancel);
        ok.removeEventListener("click", onOk);
        confirmEl.removeEventListener("close", onClose);
        try { confirmEl.close(); } catch (_) {}
        resolve(v);
      };
      const onCancel = () => cleanup(false);
      const onOk = () => cleanup(true);
      const onClose = () => cleanup(false);
      cancel.addEventListener("click", onCancel);
      ok.addEventListener("click", onOk);
      confirmEl.addEventListener("close", onClose);
      try { confirmEl.showModal(); } catch (_) {
        // older browsers / dialog already open — fall back to non-modal show
        try { confirmEl.show(); } catch (__) { resolve(false); }
      }
    });
  }

  // Build the floating panel. Layout mirrors the popup (header + body),
  // but compact and self-contained for in-page use:
  //   - Header: brand + dynamic mode badge + minimize + close
  //     - Close (X): hides the floating panel AND asks the SW to open the
  //       chrome.action popup (per Tuyul's PR #14 spec). If openPopup is
  //       not supported by this browser, we fall back to flashing the
  //       toolbar badge so the user notices and clicks the icon manually.
  //   - Status row: pill (RUNNING/PAUSED/COMPLETED/IDLE) + caption.
  //   - 3 stat cards: Done / Fail / Current.
  //   - Progress bar with percentage.
  //   - 5 actions: Start / Stop / Resume / Retry / Skip current item.
  //   - 1-line log tail (latest entry).
  function buildMonitor() {
    const head = makeEl("div", { class: "snflow-head" });
    const title = makeEl("div", { class: "snflow-title", text: "SN Flow Auto" });
    bodyEls.modeBadge = makeEl("div", { class: "snflow-mode-badge", text: "—" });
    const minBtn = makeEl("button", { class: "snflow-iconbtn", title: "Minimize", text: "—" });
    const closeBtn = makeEl("button", { class: "snflow-iconbtn snflow-close-btn", title: "Close (return to extension popup)", text: "×" });
    minBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleMinimize(); });
    closeBtn.addEventListener("click", (e) => { e.stopPropagation(); closeAndOpenPopup(); });
    head.appendChild(title);
    head.appendChild(bodyEls.modeBadge);
    head.appendChild(minBtn);
    head.appendChild(closeBtn);

    const body = makeEl("div", { class: "snflow-body" });

    // Status row — large pill + caption ("All tasks complete" etc.)
    const statusRow = makeEl("div", { class: "snflow-status-row" });
    bodyEls.pill = makeEl("div", { class: "snflow-pill snflow-pill-lg", text: "IDLE" });
    bodyEls.statusCaption = makeEl("div", { class: "snflow-status-caption", text: "No active run." });
    statusRow.appendChild(bodyEls.pill);
    statusRow.appendChild(bodyEls.statusCaption);

    // Three stat cards: Done / Fail / Current
    const statsRow = makeEl("div", { class: "snflow-stats" });
    function makeStat(key, label, glyph, glyphClass) {
      const card = makeEl("div", { class: "snflow-stat" });
      const left = makeEl("span", { class: "snflow-stat-glyph " + glyphClass, text: glyph });
      const right = makeEl("div", { class: "snflow-stat-rt" });
      const lbl = makeEl("div", { class: "snflow-stat-label", text: label });
      const val = makeEl("div", { class: "snflow-stat-value", text: "0" });
      right.appendChild(lbl);
      right.appendChild(val);
      card.appendChild(left);
      card.appendChild(right);
      bodyEls[key] = val;
      return card;
    }
    statsRow.appendChild(makeStat("statDone", "Done", "✓", "snflow-stat-done"));
    statsRow.appendChild(makeStat("statFail", "Fail", "✕", "snflow-stat-fail"));
    statsRow.appendChild(makeStat("statCurrent", "Current", "▶", "snflow-stat-current"));

    // Progress bar with percentage
    const progRow = makeEl("div", { class: "snflow-progress-row" });
    bodyEls.bar = makeEl("div", { class: "snflow-progress" });
    bodyEls.barFill = makeEl("span");
    bodyEls.bar.appendChild(bodyEls.barFill);
    bodyEls.progressLabel = makeEl("div", { class: "snflow-progress-label", text: "0%" });
    progRow.appendChild(bodyEls.bar);
    progRow.appendChild(bodyEls.progressLabel);

    body.appendChild(statusRow);
    body.appendChild(statsRow);
    body.appendChild(progRow);

    // Footer — 5 action buttons (Start / Stop / Resume / Retry / Skip)
    const foot = makeEl("div", { class: "snflow-foot" });
    bodyEls.btnStart = makeEl("button", { class: "snflow-btn snflow-primary", text: "Start" });
    bodyEls.btnStop = makeEl("button", { class: "snflow-btn snflow-stop", text: "Stop" });
    bodyEls.btnResume = makeEl("button", { class: "snflow-btn", text: "Resume" });
    bodyEls.btnRetry = makeEl("button", { class: "snflow-btn", text: "Retry" });
    bodyEls.btnSkip = makeEl("button", { class: "snflow-btn", text: "Skip" });
    bodyEls.btnStart.addEventListener("click", () => sendCmd("START"));
    bodyEls.btnResume.addEventListener("click", () => sendCmd("RESUME"));
    bodyEls.btnRetry.addEventListener("click", () => sendCmd("RETRY_FAILED"));
    bodyEls.btnSkip.addEventListener("click", () => sendCmd("SKIP"));
    // Stop on the floating panel = soft halt (PAUSE) per Tuyul's spec:
    // user clicks Stop → Start disabled, only Resume continues. Queue and
    // state are preserved; the SW pauses the run loop after the current
    // item finishes (mid-flight items aren't aborted — use Skip for that).
    bodyEls.btnStop.addEventListener("click", () => sendCmd("PAUSE"));
    foot.appendChild(bodyEls.btnStart);
    foot.appendChild(bodyEls.btnStop);
    foot.appendChild(bodyEls.btnResume);
    foot.appendChild(bodyEls.btnRetry);
    foot.appendChild(bodyEls.btnSkip);

    // Single-line log tail (latest entry only — mirrors mockup)
    bodyEls.log = makeEl("div", { class: "snflow-log snflow-log-line", text: "Waiting…" });

    const wrap = makeEl("div", { id: "snflow-monitor" });
    wrap.appendChild(head);
    wrap.appendChild(body);
    wrap.appendChild(foot);
    wrap.appendChild(bodyEls.log);

    enableDrag(wrap, head);
    return wrap;
  }

  // Close X: hide the floating panel + ask the SW to open the chrome.action
  // popup. The SW will use chrome.action.openPopup() (Chrome 127+); if that
  // fails (older browser, no user-gesture window, or non-Chrome browser),
  // it flashes the toolbar badge so the user notices and clicks the icon.
  function closeAndOpenPopup() {
    toggleOpen(false);
    try {
      chrome.runtime.sendMessage({ type: "SN_FLOW_OPEN_POPUP" }, () => {
        const err = chrome.runtime && chrome.runtime.lastError;
        if (err && root.SNFlowLogger) root.SNFlowLogger.warn("openPopup error", err.message);
      });
    } catch (_) {}
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
    if (STATE.open) refresh();
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

  // Compute the dynamic mode badge from the current item or first pending
  // item: "Image ×4", "Video ×1", "Chain I→V", or "—" if queue is empty
  // or fully done.
  function computeModeBadge(queue, currentItem) {
    const ref = currentItem || (queue || []).find((q) => q.status === "pending");
    if (!ref) return "—";
    if (ref.chainStep) return "Chain I→V";
    const mode = (ref.mode || "image").toLowerCase();
    const cnt = ref.outputCount && ref.outputCount > 1 ? ` ×${ref.outputCount}` : "";
    if (mode === "video") return `Video${cnt}`;
    if (mode === "chain") return "Chain I→V";
    return `Image${cnt}`;
  }

  function render({ runState, queue, currentItem, lastLog }) {
    if (!ensureInjected()) return;
    const sum = (root.SNFlowQueue || {}).summarize
      ? root.SNFlowQueue.summarize(queue || [])
      : { total: (queue || []).length, done: 0, counts: {} };
    const total = sum.total || 0;
    const done = sum.done || 0;
    const counts = sum.counts || {};
    const pct = total ? Math.round((done / total) * 100) : 0;

    // Pill state: RUNNING / PAUSED / COMPLETED / IDLE
    let pillText = "IDLE";
    let pillClass = "snflow-pill-idle";
    let caption = total === 0 ? "No prompts queued." : "Ready.";
    if (runState && runState.running) {
      if (runState.paused) { pillText = "PAUSED"; pillClass = "snflow-pill-paused"; caption = "Run paused."; }
      else { pillText = "RUNNING"; pillClass = "snflow-pill-running"; caption = currentItem ? trim(currentItem.prompt, 80) : "Running queue…"; }
    } else if (total > 0 && done === total) {
      const allOk = counts.completed === total;
      pillText = allOk ? "COMPLETED" : "FINISHED";
      pillClass = allOk ? "snflow-pill-done" : "snflow-pill-mixed";
      caption = allOk
        ? `All ${total} item${total === 1 ? "" : "s"} complete.`
        : `${counts.completed || 0} ok, ${counts.failed || 0} failed, ${counts.skipped || 0} skipped.`;
    }
    bodyEls.pill.textContent = pillText;
    bodyEls.pill.className = "snflow-pill snflow-pill-lg " + pillClass;
    bodyEls.statusCaption.textContent = caption;

    // Mode badge in the header
    bodyEls.modeBadge.textContent = computeModeBadge(queue, currentItem);

    // Stat cards
    bodyEls.statDone.textContent = String(counts.completed || 0);
    bodyEls.statFail.textContent = String(counts.failed || 0);
    const inFlight = (counts.sending || 0) + (counts.generating || 0)
      + (counts.waiting || 0) + (counts.downloading || 0);
    bodyEls.statCurrent.textContent = String(inFlight);

    // Progress bar
    bodyEls.barFill.style.width = pct + "%";
    bodyEls.progressLabel.textContent = pct + "%";

    // Action enable/disable.
    // Per Tuyul's PR #14 spec: Stop = soft halt (PAUSE). After Stop, Start
    // stays disabled; user must click Resume to continue. So Start is
    // gated on (!running OR !paused-after-Stop = paused) — i.e. only when
    // the queue is fully idle.
    const running = !!(runState && runState.running);
    const paused = !!(runState && runState.paused);
    const fullyIdle = !running; // running:false means stopped/never-started
    bodyEls.btnStart.disabled = !fullyIdle || total === 0 || done === total;
    bodyEls.btnStop.disabled = !running || paused; // disable after Stop click
    bodyEls.btnResume.disabled = !running || !paused;
    bodyEls.btnRetry.disabled = !(counts.failed > 0);
    bodyEls.btnSkip.disabled = !running || paused || !currentItem;

    // Single-line log tail — mirrors mockup's `[18:37:53] Item #10: completed`
    if (lastLog) bodyEls.log.textContent = lastLog;

    // Pacer state — if backend reports a streak, swap pill to a cooling tag
    try {
      chrome.runtime.sendMessage({ type: "SN_FLOW_PACING" }, (resp) => {
        if (!resp || !resp.ok || !bodyEls.pill) return;
        const st = resp.state || {};
        if (st.errorStreak && st.errorStreak > 0 && running) {
          bodyEls.pill.textContent = `COOLING ×${st.errorStreak}`;
          bodyEls.pill.className = "snflow-pill snflow-pill-lg snflow-pill-cooling";
          bodyEls.statusCaption.textContent = "Slowing down after rate-limit signals…";
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
