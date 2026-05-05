/* content/content.js — bridge between background service worker and the page.
 * Receives RUN_ITEM from background, drives the page (prompt input → generate →
 * wait for media → trigger download), reports back via sendResponse.
 */
(function (root) {
  const Log = root.SNFlowLogger;
  const Retry = root.SNFlowRetry;
  const Filename = root.SNFlowFilename;
  const Dom = root.SNFlowDom;
  const PromptInput = root.SNFlowPromptInput;
  const Generate = root.SNFlowGenerate;
  const ResultWatcher = root.SNFlowResultWatcher;
  const Downloader = root.SNFlowDownloader;

  if (!Dom || !PromptInput || !Generate || !ResultWatcher || !Downloader) {
    console.error("[SN Flow] missing module(s); content scripts not loaded in correct order");
    return;
  }

  function ping() {
    return {
      ok: true,
      flow: Dom.looksLikeFlow(),
      url: location.href,
      title: document.title,
    };
  }

  async function runItem({ item, settings }) {
    if (!item || !item.prompt) throw new Error("invalid item");
    Log.log("runItem start", { id: item.id, mode: item.mode, promptLen: item.prompt.length });

    // 1) sending prompt
    await reportStatus(item.id, "sending");
    const promptEl = await Retry.waitFor(() => PromptInput.findPromptInput(), { timeout: 12_000, interval: 350 });
    if (!promptEl) throw new Error("prompt input not found");
    await PromptInput.setPromptText(promptEl, item.prompt);
    await Retry.sleep(settings.promptInputDelayMs || 250);

    // snapshot media URLs before generation
    const before = ResultWatcher.snapshot();

    // 2) click generate
    const clicked = await Generate.clickGenerate(promptEl);
    if (!clicked) throw new Error("generate button not found");
    await reportStatus(item.id, "generating");

    // 3) wait for new media
    await reportStatus(item.id, "waiting");
    const result = await ResultWatcher.waitForNewMedia(before, item.mode || "image", {
      timeout: settings.waitTimeoutMs || 5 * 60 * 1000,
    });
    if (!result || !result.url) throw new Error("timed out waiting for media");
    Log.log("media detected", { url: result.url.slice(0, 120), mode: result.mode });

    // 4) download
    await reportStatus(item.id, "downloading");
    const filename = Filename.buildFilename({
      mode: result.mode || item.mode,
      media: { url: result.url, ext: Filename.extFor(result.url, result.mode === "video" ? "mp4" : "png") },
    });
    const dl = await Downloader.downloadResult(result.element, result.url, filename);
    Log.log("download triggered", dl);

    return {
      ok: true,
      filename: dl.filename || filename,
      mediaUrl: result.url,
      mode: result.mode || item.mode,
      method: dl.method,
      downloadId: dl.downloadId || null,
    };
  }

  function reportStatus(id, status) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: "SN_FLOW_STATUS", payload: { id, status } },
          () => resolve(),
        );
      } catch (_) { resolve(); }
    });
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "SN_FLOW_PING") {
      sendResponse(ping());
      return false;
    }
    if (msg.type === "SN_FLOW_TOGGLE_MONITOR") {
      try { root.SNFlowMonitor && root.SNFlowMonitor.toggleOpen(); } catch (_) {}
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === "SN_FLOW_RUN_ITEM") {
      runItem(msg.payload || {})
        .then((res) => sendResponse({ ok: true, ...res }))
        .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
      return true; // async
    }
    return false;
  });

  Log.log("content script ready", { flow: Dom.looksLikeFlow(), url: location.href });
})(typeof self !== "undefined" ? self : this);
