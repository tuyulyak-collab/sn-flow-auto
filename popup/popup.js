/* popup/popup.js — popup UI logic.
 * Reads/writes queue + settings via core/storage.js.
 * Sends commands (START/PAUSE/RESUME/STOP/RETRY_FAILED/CLEAR) to background.
 * Subscribes to chrome.storage.onChanged for live updates while popup is open.
 */
(function () {
  const {
    SNFlowStorage: Storage,
    SNFlowQueue: Queue,
    SNFlowPromptParser: Parser,
    SNFlowDownloadPath: DownloadPath,
  } = self;

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

    // Empty state
    if (!queue.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 5;
      td.className = "snf-meta";
      td.style.textAlign = "center";
      td.style.padding = "18px 8px";
      td.textContent = "No prompts in queue. Type prompts above or import a .txt file.";
      tr.appendChild(td);
      els.queueBody.appendChild(tr);
    }

    // Pre-compute id -> queue position so chain video rows can show
    // "from #N" pointing at their parent image row.
    const idToPos = new Map();
    queue.forEach((it, i) => idToPos.set(it.id, i + 1));

    queue.forEach((item, idx) => {
      const tr = document.createElement("tr");
      if (item.chainStep === "video") tr.classList.add("snf-chain-row");
      if (item.chainStep === "image") tr.classList.add("snf-chain-parent-row");

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
        // Show "from #N" linkage so users see which image feeds this video.
        const parentPos = item.parentId ? idToPos.get(item.parentId) : null;
        if (parentPos) {
          const link = document.createElement("span");
          link.className = "snf-chain-parent-link";
          link.textContent = ` from #${parentPos}`;
          link.title = "Parent image step row";
          tdPrompt.appendChild(link);
        }
      } else {
        tdPrompt.textContent = trim(item.prompt, 80);
      }

      const tdMode = document.createElement("td");
      const ratio = item.aspectRatio ? ` · ${item.aspectRatio}` : "";
      const count = item.outputCount && item.outputCount > 1 ? ` · x${item.outputCount}` : "";
      const chainTag = item.chainStep === "image" ? ` · chain·img` :
                        item.chainStep === "video" ? ` · chain·vid` : "";
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

    // Run completion summary: show a clear message when all items are done
    if (sum.total > 0 && sum.done === sum.total) {
      const all = sum.counts.completed === sum.total;
      const msg = all
        ? `All ${sum.total} item${sum.total === 1 ? "" : "s"} completed.`
        : `Run finished: ${sum.counts.completed} done, ${sum.counts.failed} failed, ${sum.counts.skipped} skipped.`;
      els.progressStatus.textContent = msg;
    }
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
    syncDownloadInputs(settings);
    renderLogs(all[Storage.KEYS.LOGS] || []);
    refreshPacerState();
  }

  // Download Settings (PR #15 + PR #16 UX polish) — progressive disclosure.
  // Defaults always apply when the toggles are OFF; when a toggle is ON we
  // expose the underlying input and write the user's value to the active
  // settings keys. Defaults remain SN_flow_{random5}_{ddmmyyyy} / SN Flow Auto.
  const DEFAULT_FILENAME_TEMPLATE = "SN_flow_{random5}_{ddmmyyyy}";
  const DEFAULT_OUTPUT_FOLDER = "SN Flow Auto";

  // Validation should not flash red on first popup open. We only show
  // inline errors once the user has actually interacted with that field
  // (typed something / blurred), or after they pressed Start with bad
  // settings. See validateAllForStart() below.
  const hasInteracted = { filenameTemplate: false, outputFolder: false };

  function syncDownloadInputs(settings) {
    // Toggle states drive which inputs are visible and whether the
    // active filenameTemplate / outputFolder keys come from the user's
    // customisation or the safe defaults.
    const onFile = !!settings.customizeFileName;
    const onFolder = !!settings.customizeFolder;

    if (els.toggleFilename && els.toggleFilename.checked !== onFile) {
      els.toggleFilename.checked = onFile;
    }
    if (els.toggleFolder && els.toggleFolder.checked !== onFolder) {
      els.toggleFolder.checked = onFolder;
    }

    // When customisation is ON, populate the input from the user's saved
    // customisation; when OFF, reflect the default so an open-and-toggle-ON
    // shows the user where they're starting from. Don't stomp on the user
    // mid-edit.
    if (els.filenameTemplate && document.activeElement !== els.filenameTemplate) {
      const v = onFile
        ? (settings.filenameTemplateCustom || settings.filenameTemplate || DEFAULT_FILENAME_TEMPLATE)
        : DEFAULT_FILENAME_TEMPLATE;
      if (els.filenameTemplate.value !== v) els.filenameTemplate.value = v;
    }
    if (els.outputFolder && document.activeElement !== els.outputFolder) {
      const v = onFolder
        ? (typeof settings.outputFolderCustom === "string" ? settings.outputFolderCustom : DEFAULT_OUTPUT_FOLDER)
        : DEFAULT_OUTPUT_FOLDER;
      if (els.outputFolder.value !== v) els.outputFolder.value = v;
    }

    // Conflict policy lives inside Advanced Download Options now; default
    // = keep both files (uniquify). Anything that isn't "overwrite" is
    // treated as keep-both for forward-compat.
    if (els.conflictKeep) {
      const keep = settings.conflictAction !== "overwrite";
      if (els.conflictKeep.checked !== keep) els.conflictKeep.checked = keep;
    }

    refreshDownloadVisibility(onFile, onFolder);
    refreshFilenamePreview();
  }

  function refreshDownloadVisibility(onFile, onFolder) {
    if (els.filenameFields) els.filenameFields.hidden = !onFile;
    if (els.folderFields) els.folderFields.hidden = !onFolder;
    if (els.filenameToggleHelper) {
      els.filenameToggleHelper.hidden = onFile;
    }
    if (els.folderToggleHelper) {
      els.folderToggleHelper.hidden = onFolder;
    }
    // Clear any stale errors when the user hides the field again.
    if (!onFile) {
      hasInteracted.filenameTemplate = false;
      setFieldError(els.filenameTemplate, els.filenameError, null);
    }
    if (!onFolder) {
      hasInteracted.outputFolder = false;
      setFieldError(els.outputFolder, els.folderError, null);
    }
  }

  function refreshDefaultPreview() {
    if (!DownloadPath) return;
    const sample = DownloadPath.buildDownloadPath({
      outputFolder: DEFAULT_OUTPUT_FOLDER,
      filenameTemplate: DEFAULT_FILENAME_TEMPLATE,
      ext: "png",
      ctx: { mode: "image", index: 1, prompt: "A cinematic sunrise over Bali" },
    });
    // sample looks like "SN Flow Auto/SN_flow_A7K2Q_05052026.png"
    const slash = sample.lastIndexOf("/");
    const folder = slash >= 0 ? sample.slice(0, slash) : "";
    const name = slash >= 0 ? sample.slice(slash + 1) : sample;
    if (els.defaultPreviewName) els.defaultPreviewName.textContent = name;
    if (els.defaultPreviewFolder) {
      els.defaultPreviewFolder.textContent = folder ? `Downloads/${folder}` : "Downloads";
    }
  }

  function refreshFilenamePreview() {
    if (!els.filenamePreview || !DownloadPath) return;
    // Only show the live preview when the user is actively customising.
    const onFile = els.toggleFilename ? els.toggleFilename.checked : false;
    const onFolder = els.toggleFolder ? els.toggleFolder.checked : false;
    if (!onFile && !onFolder) {
      els.filenamePreview.hidden = true;
      els.filenamePreview.textContent = "";
      return;
    }
    const tplRaw = onFile && els.filenameTemplate ? els.filenameTemplate.value : DEFAULT_FILENAME_TEMPLATE;
    const folderRaw = onFolder && els.outputFolder ? els.outputFolder.value : DEFAULT_OUTPUT_FOLDER;
    const tplCheck = DownloadPath.validateFilenameTemplate(tplRaw);
    const folderCheck = DownloadPath.validateOutputFolder(folderRaw);
    if (!tplCheck.ok || !folderCheck.ok) {
      els.filenamePreview.hidden = true;
      els.filenamePreview.textContent = "";
      return;
    }
    const sample = DownloadPath.buildDownloadPath({
      outputFolder: folderRaw,
      filenameTemplate: tplRaw,
      ext: "png",
      ctx: { mode: "image", index: 1, prompt: "A cinematic sunrise over Bali" },
    });
    els.filenamePreview.hidden = false;
    els.filenamePreview.textContent = `Preview: Downloads/${sample}`;
  }

  function setFieldError(inputEl, errorEl, msg) {
    if (!inputEl || !errorEl) return;
    if (msg) {
      errorEl.textContent = msg;
      errorEl.hidden = false;
      inputEl.classList.add("snf-input-error");
    } else {
      errorEl.textContent = "";
      errorEl.hidden = true;
      inputEl.classList.remove("snf-input-error");
    }
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
    if (els.chainCustom && typeof settings.chainPromptCustom === "string" && els.chainCustom.value !== settings.chainPromptCustom) {
      els.chainCustom.value = settings.chainPromptCustom;
    }
    const ps = settings.chainPromptSource || "same";
    if (els.chainSuffixRow) els.chainSuffixRow.hidden = ps !== "suffix";
    if (els.chainCustomRow) els.chainCustomRow.hidden = ps !== "custom";
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
      chainPromptCustom: els.chainCustom ? els.chainCustom.value : "",
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
    // Reset the target item back to pending. If the item is a chain image
    // step, also cascade-reset all of its chain video children so they can
    // re-run against the freshly generated image. Without the cascade, a
    // child whose previous status was "skipped" (because the old image
    // failed) would never re-fire.
    const queue = await Storage.getQueue();
    const target = queue.find((q) => q.id === id);
    const updated = queue.map((q) => {
      if (q.id === id) {
        return { ...q, status: "pending", error: undefined, attempts: 0,
                 filename: undefined, mediaUrl: undefined, updatedAt: Date.now() };
      }
      if (target && target.chainStep === "image" && q.parentId === id) {
        // Reset the child only if it's already in a terminal state — leaves
        // a still-running child alone.
        if (q.status === "completed" || q.status === "failed" || q.status === "skipped") {
          return { ...q, status: "pending", error: undefined, attempts: 0,
                   filename: undefined, mediaUrl: undefined, inputMediaUrl: undefined,
                   updatedAt: Date.now() };
        }
      }
      return q;
    });
    await Storage.setQueue(updated);
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
    els.start.addEventListener("click", async () => {
      // PR #16: surface inline errors when the user presses Start with bad
      // download settings, then bail out so we don't queue against broken
      // sanitisation. Defaults pass trivially.
      const validate = self.SNFlowValidateDownloadSettingsForStart;
      if (typeof validate === "function") {
        const ok = await validate();
        if (!ok) {
          if (els.settingsPanel && els.settingsPanel.hidden) openSettings();
          return;
        }
      }
      await sendCmd("START");
      refresh();
    });
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
        if (els.chainCustomRow) els.chainCustomRow.hidden = v !== "custom";
        saveChain({ chainPromptSource: v });
      });
    }
    if (els.chainSuffix) {
      els.chainSuffix.addEventListener("change", () => saveChain({ chainPromptSuffix: els.chainSuffix.value }));
    }
    if (els.chainCustom) {
      els.chainCustom.addEventListener("change", () => saveChain({ chainPromptCustom: els.chainCustom.value }));
      // also save on blur for textareas — change can fire late
      els.chainCustom.addEventListener("blur", () => saveChain({ chainPromptCustom: els.chainCustom.value }));
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
          "Fast mode removes all delays between prompts.\n\n" +
          "This is not recommended — it may cause more errors or hit usage limits.\n\n" +
          "Continue?"
        )) {
          els.aggressive.checked = false;
          return;
        }
        await savePacing();
      });
    }

    // ---- Download Settings (PR #15) ----
    bindDownloadSettings();

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes[Storage.KEYS.QUEUE] || changes[Storage.KEYS.RUN] || changes[Storage.KEYS.LOGS] || changes[Storage.KEYS.SETTINGS]) {
        refresh();
      }
    });
  }

  function bindDownloadSettings() {
    if (!DownloadPath) return;

    // Lazy validation: only show inline errors after the user has actually
    // interacted with the field, or after they pressed Start with bad
    // settings (handled by validateDownloadSettingsForStart below).
    const validateAndSaveFilename = async () => {
      if (!els.filenameTemplate) return;
      const raw = els.filenameTemplate.value;
      const result = DownloadPath.validateFilenameTemplate(raw);
      if (!result.ok) {
        if (hasInteracted.filenameTemplate) {
          setFieldError(els.filenameTemplate, els.filenameError, result.error);
        }
        // Persist whatever they typed to *Custom so toggling preserves it,
        // but don't write the broken value into the active filenameTemplate
        // key — keep the SW on the last known-good template.
        await Storage.setSettings({ filenameTemplateCustom: raw });
        return;
      }
      setFieldError(els.filenameTemplate, els.filenameError, null);
      await Storage.setSettings({
        filenameTemplate: result.value,
        filenameTemplateCustom: result.value,
      });
      refreshFilenamePreview();
    };

    const validateAndSaveFolder = async () => {
      if (!els.outputFolder) return;
      const raw = els.outputFolder.value;
      const result = DownloadPath.validateOutputFolder(raw);
      if (!result.ok) {
        if (hasInteracted.outputFolder) {
          setFieldError(els.outputFolder, els.folderError, result.error);
        }
        await Storage.setSettings({ outputFolderCustom: raw });
        return;
      }
      setFieldError(els.outputFolder, els.folderError, null);
      await Storage.setSettings({
        outputFolder: result.value,
        outputFolderCustom: result.value,
      });
      refreshFilenamePreview();
    };

    // Toggle handlers — flip customise* flags and mirror the active
    // template/folder keys to either the user's last customisation or the
    // safe defaults so the SW stays on whichever the user just chose.
    //
    // If the saved custom value is invalid (e.g. user typed "bad<file>?"
    // and toggled OFF before fixing it), keep the active key on the safe
    // default so the SW never sees a broken value, surface the inline
    // error so the user notices, and preserve the bad text in the input
    // so they can fix it without retyping.
    if (els.toggleFilename) {
      els.toggleFilename.addEventListener("change", async (e) => {
        const on = !!e.target.checked;
        const cur = await Storage.getSettings();
        if (on) {
          const raw = cur.filenameTemplateCustom || DEFAULT_FILENAME_TEMPLATE;
          const check = DownloadPath.validateFilenameTemplate(raw);
          await Storage.setSettings({
            customizeFileName: true,
            filenameTemplate: check.ok ? check.value : DEFAULT_FILENAME_TEMPLATE,
            filenameTemplateCustom: raw,
          });
          if (!check.ok) {
            hasInteracted.filenameTemplate = true;
            setFieldError(els.filenameTemplate, els.filenameError, check.error);
          }
        } else {
          await Storage.setSettings({
            customizeFileName: false,
            filenameTemplate: DEFAULT_FILENAME_TEMPLATE,
            // preserve filenameTemplateCustom for restore on next toggle ON
          });
        }
        // refresh() is already wired to chrome.storage.onChanged, but
        // call it directly to make the toggle feel instant.
        refresh();
      });
    }
    if (els.toggleFolder) {
      els.toggleFolder.addEventListener("change", async (e) => {
        const on = !!e.target.checked;
        const cur = await Storage.getSettings();
        if (on) {
          const raw = typeof cur.outputFolderCustom === "string" ? cur.outputFolderCustom : DEFAULT_OUTPUT_FOLDER;
          const check = DownloadPath.validateOutputFolder(raw);
          await Storage.setSettings({
            customizeFolder: true,
            outputFolder: check.ok ? check.value : DEFAULT_OUTPUT_FOLDER,
            outputFolderCustom: raw,
          });
          if (!check.ok) {
            hasInteracted.outputFolder = true;
            setFieldError(els.outputFolder, els.folderError, check.error);
          }
        } else {
          await Storage.setSettings({
            customizeFolder: false,
            outputFolder: DEFAULT_OUTPUT_FOLDER,
          });
        }
        refresh();
      });
    }

    if (els.filenameTemplate) {
      // Mark interacted on first input/change so subsequent invalid edits
      // surface the inline error. We do NOT mark interacted on focus —
      // tabbing into the field shouldn't trip a red error.
      els.filenameTemplate.addEventListener("input", () => {
        hasInteracted.filenameTemplate = true;
        refreshFilenamePreview();
      });
      els.filenameTemplate.addEventListener("change", validateAndSaveFilename);
      els.filenameTemplate.addEventListener("blur", validateAndSaveFilename);
    }
    if (els.outputFolder) {
      els.outputFolder.addEventListener("input", () => {
        hasInteracted.outputFolder = true;
        refreshFilenamePreview();
      });
      els.outputFolder.addEventListener("change", validateAndSaveFolder);
      els.outputFolder.addEventListener("blur", validateAndSaveFolder);
    }
    if (els.conflictKeep) {
      els.conflictKeep.addEventListener("change", async () => {
        await Storage.setSettings({
          conflictAction: els.conflictKeep.checked ? "uniquify" : "overwrite",
        });
      });
    }
    if (els.openLastDownload) {
      els.openLastDownload.addEventListener("click", () => {
        try {
          chrome.runtime.sendMessage({ type: "SN_FLOW_OPEN_LAST_DOWNLOAD" }, () => {
            // ignore lastError; the SW falls back to opening the default
            // Downloads folder when no lastDownloadId is recorded yet.
            void chrome.runtime.lastError;
          });
        } catch (_) { /* noop */ }
      });
    }
    if (els.openDownloadsFolder) {
      els.openDownloadsFolder.addEventListener("click", () => {
        try {
          chrome.runtime.sendMessage({ type: "SN_FLOW_OPEN_DOWNLOADS_FOLDER" }, () => {
            void chrome.runtime.lastError;
          });
        } catch (_) { /* noop */ }
      });
    }
  }

  // Called from the Start button handler — surfaces inline errors if the
  // user is currently customising and has bad settings, so they don't try
  // to start a batch with invalid filename / folder values.
  async function validateDownloadSettingsForStart() {
    if (!DownloadPath) return true;
    const settings = await Storage.getSettings();
    let ok = true;
    if (settings.customizeFileName && els.filenameTemplate) {
      const r = DownloadPath.validateFilenameTemplate(els.filenameTemplate.value);
      if (!r.ok) {
        hasInteracted.filenameTemplate = true;
        setFieldError(els.filenameTemplate, els.filenameError, r.error);
        ok = false;
      }
    }
    if (settings.customizeFolder && els.outputFolder) {
      const r = DownloadPath.validateOutputFolder(els.outputFolder.value);
      if (!r.ok) {
        hasInteracted.outputFolder = true;
        setFieldError(els.outputFolder, els.folderError, r.error);
        ok = false;
      }
    }
    return ok;
  }
  // expose to start handler if present elsewhere; harmless otherwise.
  self.SNFlowValidateDownloadSettingsForStart = validateDownloadSettingsForStart;

  // ---- header actions (gear / floating) ----
  // Gear: toggle the in-popup Settings overlay (slide-in panel that hosts
  // the 'Safe Speed & Delays' controls). Floating: forward an
  // SN_FLOW_OPEN_FLOATING command to the active Flow tab so its
  // floating-monitor expands, then close the popup so the user can
  // interact with the floating panel.
  function openSettings() {
    if (!els.settingsPanel) return;
    els.settingsPanel.hidden = false;
    els.settingsPanel.setAttribute("aria-hidden", "false");
    refreshPacerState();
  }
  function closeSettings() {
    if (!els.settingsPanel) return;
    els.settingsPanel.hidden = true;
    els.settingsPanel.setAttribute("aria-hidden", "true");
  }
  async function findFlowTab() {
    return new Promise((resolve) => {
      const patterns = [
        "https://labs.google/*",
        "https://*.labs.google/*",
        "https://flow.google/*",
        "https://*.flow.google/*",
        "https://aitestkitchen.withgoogle.com/*",
      ];
      try {
        chrome.tabs.query({ url: patterns }, (tabs) => {
          if (!tabs || !tabs.length) { resolve(null); return; }
          // Prefer the active tab in the current window if it matches; else first.
          const active = tabs.find((t) => t.active);
          resolve(active || tabs[0]);
        });
      } catch (_) { resolve(null); }
    });
  }
  async function openFloatingPanel() {
    const tab = await findFlowTab();
    if (!tab) {
      els.importInfo.textContent = "open a Flow tab first";
      return;
    }
    try {
      chrome.tabs.sendMessage(
        tab.id,
        { type: "SN_FLOW_OPEN_FLOATING" },
        () => {
          // Even if the content script isn't ready, focus the Flow tab so
          // the user lands there. Then close the popup.
          try { chrome.tabs.update(tab.id, { active: true }); } catch (_) {}
          try { chrome.windows.update(tab.windowId, { focused: true }); } catch (_) {}
          window.close();
        },
      );
    } catch (_) {
      window.close();
    }
  }
  function bindHeaderActions() {
    if (els.openSettings) els.openSettings.addEventListener("click", openSettings);
    if (els.settingsBack) els.settingsBack.addEventListener("click", closeSettings);
    if (els.settingsClose) els.settingsClose.addEventListener("click", closeSettings);
    if (els.openFloating) els.openFloating.addEventListener("click", openFloatingPanel);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && els.settingsPanel && !els.settingsPanel.hidden) {
        closeSettings();
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
      chainCustomRow: $("snf-chain-custom-row"),
      chainCustom: $("snf-chain-custom"),
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
      // header action buttons (gear / floating) + settings overlay
      openSettings: $("snf-open-settings"),
      openFloating: $("snf-open-floating"),
      settingsPanel: $("snf-settings-panel"),
      settingsBack: $("snf-settings-back"),
      settingsClose: $("snf-settings-close"),
      // download settings (PR #15 + PR #16 UX polish — progressive disclosure)
      defaultPreviewName: $("snf-default-preview-name"),
      defaultPreviewFolder: $("snf-default-preview-folder"),
      toggleFilename: $("snf-toggle-filename"),
      toggleFolder: $("snf-toggle-folder"),
      filenameToggleHelper: $("snf-filename-toggle-helper"),
      folderToggleHelper: $("snf-folder-toggle-helper"),
      filenameFields: $("snf-filename-fields"),
      folderFields: $("snf-folder-fields"),
      filenameTemplate: $("snf-filename-template"),
      filenameError: $("snf-filename-error"),
      filenamePreview: $("snf-filename-preview"),
      outputFolder: $("snf-output-folder"),
      folderError: $("snf-folder-error"),
      conflictKeep: $("snf-conflict-keep"),
      openLastDownload: $("snf-open-last-download"),
      openDownloadsFolder: $("snf-open-downloads-folder"),
    });
    bind();
    bindHeaderActions();
    refreshDefaultPreview();
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
