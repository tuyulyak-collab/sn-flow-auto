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
      if (item.chainStep === "video") tr.classList.add("snf-chain-row");

      const tdIdx = document.createElement("td");
      tdIdx.textContent = String(idx + 1);

      const tdPrompt = document.createElement("td");
      tdPrompt.className = "snf-prompt-cell";
      tdPrompt.title = item.prompt;
      if (item.chainStep === "video") {
        const arrow = document.createElement("span");
        arrow.className = "snf-chain-arrow";
        arrow.textContent = "↳";
        tdPrompt.appendChild(arrow);
        tdPrompt.appendChild(document.createTextNode(trim(item.prompt, 80)));
      } else {
        tdPrompt.textContent = trim(item.prompt, 80);
      }

      const tdMode = document.createElement("td");
      const ratio = item.aspectRatio ? ` · ${item.aspectRatio}` : "";
      const count = item.outputCount && item.outputCount > 1 ? ` · x${item.outputCount}` : "";
      const chainTag = item.chainStep ? ` · chain` : "";
      tdMode.textContent = `${item.mode || "image"}${ratio}${count}${chainTag}`;

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
    if (els.aspect && settings.aspectRatio && els.aspect.value !== settings.aspectRatio) {
      els.aspect.value = settings.aspectRatio;
    }
    if (els.count && settings.outputCount && els.count.value !== String(settings.outputCount)) {
      els.count.value = String(settings.outputCount);
    }
    syncChainInputs(settings);
    syncPacingInputs(settings);
    renderLogs(all[Storage.KEYS.LOGS] || []);
    refreshPacerState();
  }

  function syncChainInputs(settings) {
    if (els.chainPanel) {
      const isChain = (settings.mode || "image") === "chain";
      els.chainPanel.hidden = !isChain;
    }
    if (els.chainStrategy && settings.chainStrategy && els.chainStrategy.value !== settings.chainStrategy) {
      els.chainStrategy.value = settings.chainStrategy;
    }
    if (els.chainPromptSource && settings.chainPromptSource && els.chainPromptSource.value !== settings.chainPromptSource) {
      els.chainPromptSource.value = settings.chainPromptSource;
    }
    if (els.chainRunOrder && settings.chainRunOrder && els.chainRunOrder.value !== settings.chainRunOrder) {
      els.chainRunOrder.value = settings.chainRunOrder;
    }
    if (els.chainVideoAspect) {
      const v = settings.chainVideoAspectRatio || "";
      if (els.chainVideoAspect.value !== v) els.chainVideoAspect.value = v;
    }
    if (els.chainVideoModel && settings.chainVideoModel && els.chainVideoModel.value !== settings.chainVideoModel) {
      els.chainVideoModel.value = settings.chainVideoModel;
    }
    if (els.chainSuffix && typeof settings.chainPromptSuffix === "string" && els.chainSuffix.value !== settings.chainPromptSuffix) {
      els.chainSuffix.value = settings.chainPromptSuffix;
    }
    if (els.chainSuffixRow) {
      els.chainSuffixRow.hidden = !((settings.chainPromptSource || "same") === "suffix");
    }
  }

  function syncPacingInputs(settings) {
    if (els.minDelay && els.minDelay.value !== String(Math.round(settings.minDelayMs / 1000))) {
      els.minDelay.value = String(Math.round(settings.minDelayMs / 1000));
    }
    if (els.maxDelay && els.maxDelay.value !== String(Math.round(settings.maxDelayMs / 1000))) {
      els.maxDelay.value = String(Math.round(settings.maxDelayMs / 1000));
    }
    if (els.cooldownEvery && els.cooldownEvery.value !== String(settings.cooldownEvery)) {
      els.cooldownEvery.value = String(settings.cooldownEvery);
    }
    if (els.cooldownMs && els.cooldownMs.value !== String(Math.round(settings.cooldownMs / 1000))) {
      els.cooldownMs.value = String(Math.round(settings.cooldownMs / 1000));
    }
    if (els.adaptive) els.adaptive.checked = !!settings.adaptiveBackoff;
    if (els.pauseRl) els.pauseRl.checked = !!settings.pauseOnRateLimit;
    if (els.aggressive) els.aggressive.checked = !!settings.aggressiveMode;
  }

  function refreshPacerState() {
    if (!els.pacerMeta) return;
    try {
      chrome.runtime.sendMessage({ type: "SN_FLOW_PACING" }, (resp) => {
        if (!resp || !resp.ok) {
          els.pacerMeta.textContent = "—";
          return;
        }
        const st = resp.state || {};
        const parts = [];
        parts.push(`${st.total || 0} done`);
        if (st.errorStreak) parts.push(`${st.errorStreak} consecutive blocks`);
        if (st.lastReason) parts.push(`last: ${trim(st.lastReason, 40)}`);
        els.pacerMeta.textContent = parts.join(" · ");
        if (st.errorStreak && st.errorStreak > 0) {
          els.pacerMeta.style.color = "#b6322f";
        } else {
          els.pacerMeta.style.color = "";
        }
      });
    } catch (_) { els.pacerMeta.textContent = "—"; }
  }

  function currentBuildOpts() {
    return {
      mode: els.mode.value,
      aspectRatio: els.aspect ? els.aspect.value : "16:9",
      outputCount: els.count ? parseInt(els.count.value, 10) || 1 : 1,
      // Chain fields are only meaningful when mode === "chain", but we
      // include them unconditionally so downstream code (buildItems) can
      // make consistent decisions without re-reading settings.
      chainStrategy: els.chainStrategy ? els.chainStrategy.value : "first",
      chainPromptSource: els.chainPromptSource ? els.chainPromptSource.value : "same",
      chainPromptSuffix: els.chainSuffix ? els.chainSuffix.value : "",
      chainRunOrder: els.chainRunOrder ? els.chainRunOrder.value : "interleave",
      chainVideoAspectRatio: els.chainVideoAspect && els.chainVideoAspect.value ? els.chainVideoAspect.value : null,
      chainVideoModel: els.chainVideoModel ? els.chainVideoModel.value : "auto",
    };
  }

  // ---- queue mutations ----
  async function addPrompts() {
    const text = els.prompts.value;
    const opts = currentBuildOpts();
    const parsed = Parser.parsePrompts(text);
    if (!parsed.length) {
      els.importInfo.textContent = "no prompts";
      return;
    }
    const items = Parser.buildItems(parsed, opts);
    const cur = await Storage.getQueue();
    await Storage.setQueue(cur.concat(items));
    els.prompts.value = "";
    els.importInfo.textContent = `+${items.length} added`;
    await Storage.setSettings(opts);
    await refresh();
  }

  async function importTxt(file) {
    const text = await file.text();
    const parsed = Parser.parsePrompts(text);
    const opts = currentBuildOpts();
    const items = Parser.buildItems(parsed, opts);
    const cur = await Storage.getQueue();
    await Storage.setQueue(cur.concat(items));
    els.importInfo.textContent = `+${items.length} from ${file.name}`;
    await Storage.setSettings(opts);
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

  // Custom in-popup confirm modal. Native window.confirm() in MV3 popups
  // closes the popup on focus-loss, which kills any post-await code (so e.g.
  // a Stop click never actually sends STOP). Using HTMLDialogElement keeps
  // the popup focused so the click handler can resume normally.
  function snfConfirm(message, { title = "Confirm", okText = "OK", cancelText = "Cancel" } = {}) {
    return new Promise((resolve) => {
      const dlg = $("snf-confirm");
      const titleEl = $("snf-confirm-title");
      const msgEl = $("snf-confirm-message");
      const okBtn = $("snf-confirm-ok");
      const cancelBtn = $("snf-confirm-cancel");
      // Fall back to native confirm() if <dialog> is somehow unavailable, so
      // we never silently lose a confirmation.
      if (!dlg || typeof dlg.showModal !== "function") {
        resolve(window.confirm(message));
        return;
      }
      titleEl.textContent = title;
      msgEl.textContent = message;
      okBtn.textContent = okText;
      cancelBtn.textContent = cancelText;
      const finish = (val) => {
        okBtn.removeEventListener("click", onOk);
        cancelBtn.removeEventListener("click", onCancel);
        dlg.removeEventListener("close", onClose);
        if (dlg.open) dlg.close();
        resolve(val);
      };
      const onOk = () => finish(true);
      const onCancel = () => finish(false);
      // Esc / backdrop close → treat as cancel.
      const onClose = () => finish(false);
      okBtn.addEventListener("click", onOk);
      cancelBtn.addEventListener("click", onCancel);
      dlg.addEventListener("close", onClose);
      dlg.showModal();
      cancelBtn.focus();
    });
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
    els.stop.addEventListener("click", async () => {
      const ok = await snfConfirm(
        "Stop will halt all processing immediately and reset every queue item back to Pending.\n\n" +
        "Next Start will begin again from item 1.\n\n" +
        "(Pause/Resume preserves state — use Pause if you want to keep position.)\n\n" +
        "Continue?",
        { title: "Stop & reset queue?", okText: "Stop & reset", cancelText: "Cancel" },
      );
      if (!ok) return;
      // Reset storage directly from the popup so the reset is guaranteed even
      // if the MV3 popup closes mid-flight after the modal dismisses (which
      // would otherwise cancel an in-flight chrome.runtime.sendMessage and
      // its callback, leaving the SW's stopQueue response un-awaited and the
      // popup's refresh() never called). The SW STOP message is still sent
      // fire-and-forget to reset pacer / loop state in the SW.
      try {
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
        await Storage.setRunState({ running: false, paused: false, currentId: null });
      } catch (_) {}
      try { chrome.runtime.sendMessage({ type: "SN_FLOW_CMD", payload: { cmd: "STOP" } }); } catch (_) {}
      refresh();
    });
    els.retry.addEventListener("click", async () => { await sendCmd("RETRY_FAILED"); refresh(); });
    els.clear.addEventListener("click", async () => {
      const ok = await snfConfirm("Clear the entire queue?", {
        title: "Clear queue?",
        okText: "Clear",
        cancelText: "Cancel",
      });
      if (!ok) return;
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
      const mode = els.mode.value;
      if (els.chainPanel) els.chainPanel.hidden = mode !== "chain";
      await Storage.setSettings({ mode });
    });
    if (els.aspect) {
      els.aspect.addEventListener("change", async () => {
        await Storage.setSettings({ aspectRatio: els.aspect.value });
      });
    }
    if (els.count) {
      els.count.addEventListener("change", async () => {
        await Storage.setSettings({ outputCount: parseInt(els.count.value, 10) || 1 });
      });
    }

    // ---- Chain dropdowns ----
    const saveChain = async (patch) => { await Storage.setSettings(patch); };
    if (els.chainStrategy) {
      els.chainStrategy.addEventListener("change", () => saveChain({ chainStrategy: els.chainStrategy.value }));
    }
    if (els.chainPromptSource) {
      els.chainPromptSource.addEventListener("change", () => {
        const v = els.chainPromptSource.value;
        if (els.chainSuffixRow) els.chainSuffixRow.hidden = v !== "suffix";
        saveChain({ chainPromptSource: v });
      });
    }
    if (els.chainSuffix) {
      els.chainSuffix.addEventListener("change", () => saveChain({ chainPromptSuffix: els.chainSuffix.value }));
    }
    if (els.chainRunOrder) {
      els.chainRunOrder.addEventListener("change", () => saveChain({ chainRunOrder: els.chainRunOrder.value }));
    }
    if (els.chainVideoAspect) {
      els.chainVideoAspect.addEventListener("change", () => saveChain({ chainVideoAspectRatio: els.chainVideoAspect.value || null }));
    }
    if (els.chainVideoModel) {
      els.chainVideoModel.addEventListener("change", () => saveChain({ chainVideoModel: els.chainVideoModel.value }));
    }

    // ---- pacing settings ----
    const savePacing = async () => {
      const min = Math.max(0, parseInt(els.minDelay.value, 10) || 0) * 1000;
      const max = Math.max(min, parseInt(els.maxDelay.value, 10) || 0) * 1000;
      await Storage.setSettings({
        minDelayMs: min,
        maxDelayMs: max,
        cooldownEvery: Math.max(0, parseInt(els.cooldownEvery.value, 10) || 0),
        cooldownMs: Math.max(0, parseInt(els.cooldownMs.value, 10) || 0) * 1000,
        adaptiveBackoff: !!els.adaptive.checked,
        pauseOnRateLimit: !!els.pauseRl.checked,
        aggressiveMode: !!els.aggressive.checked,
      });
    };
    if (els.minDelay) els.minDelay.addEventListener("change", savePacing);
    if (els.maxDelay) els.maxDelay.addEventListener("change", savePacing);
    if (els.cooldownEvery) els.cooldownEvery.addEventListener("change", savePacing);
    if (els.cooldownMs) els.cooldownMs.addEventListener("change", savePacing);
    if (els.adaptive) els.adaptive.addEventListener("change", savePacing);
    if (els.pauseRl) els.pauseRl.addEventListener("change", savePacing);
    if (els.aggressive) {
      els.aggressive.addEventListener("change", async () => {
        if (els.aggressive.checked && !confirm(
          "Aggressive mode collapses ALL delays to 0.\n\n" +
          "Flow may rate-limit or temporarily block this account if it detects automation.\n\n" +
          "Use only for testing. Continue?"
        )) {
          els.aggressive.checked = false;
          return;
        }
        await savePacing();
      });
    }

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
      aspect: $("snf-aspect"),
      count: $("snf-count"),
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
      // chain (Image → Video) settings
      chainPanel: $("snf-chain-panel"),
      chainStrategy: $("snf-chain-strategy"),
      chainPromptSource: $("snf-chain-prompt-source"),
      chainSuffixRow: $("snf-chain-suffix-row"),
      chainSuffix: $("snf-chain-suffix"),
      chainRunOrder: $("snf-chain-run-order"),
      chainVideoAspect: $("snf-chain-video-aspect"),
      chainVideoModel: $("snf-chain-video-model"),
      // pacing
      minDelay: $("snf-min-delay"),
      maxDelay: $("snf-max-delay"),
      cooldownEvery: $("snf-cooldown-every"),
      cooldownMs: $("snf-cooldown-ms"),
      adaptive: $("snf-adaptive"),
      pauseRl: $("snf-pause-rl"),
      aggressive: $("snf-aggressive"),
      pacerMeta: $("snf-pacer-meta"),
    });
    bind();
    refresh();
    // Refresh pacer state every 3 s while popup is open
    setInterval(refreshPacerState, 3000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
