/* content/content.js — bridge between background service worker and the page.
 * Receives RUN_ITEM from background, drives the page (apply settings → prompt
 * input → generate → wait for media → trigger download), reports back via
 * sendResponse.
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
  const Settings = root.SNFlowSettings; // optional, may be absent on legacy load order

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
      modules: {
        promptInput: !!PromptInput,
        generate: !!Generate,
        resultWatcher: !!ResultWatcher,
        downloader: !!Downloader,
        settings: !!Settings,
      },
    };
  }

  async function runItem({ item, settings }) {
    if (!item || !item.prompt) throw new Error("invalid item");
    const itemMode = item.mode || (settings && settings.mode) || "image";
    const itemRatio = item.aspectRatio || (settings && settings.aspectRatio) || "16:9";
    const itemCount = parseInt(item.outputCount || (settings && settings.outputCount) || 1, 10);
    Log.log("runItem start", {
      id: item.id,
      mode: itemMode,
      ratio: itemRatio,
      count: itemCount,
      promptLen: item.prompt.length,
    });

    // 0) apply Flow's native settings via the radix dropdown (best-effort).
    //   For chain video steps we additionally pick the configured Veo model
    //   (via settings.chainVideoModel) so Flow generates with image-to-video
    //   rather than the previously selected image model.
    const itemModel = (item.chainStep === "video" && settings && settings.chainVideoModel)
      ? settings.chainVideoModel
      : null;
    if (Settings && Settings.applySettings) {
      try {
        const applied = await Settings.applySettings({
          mode: itemMode,
          aspectRatio: itemRatio,
          outputCount: itemCount,
          model: itemModel,
        });
        Log.log("settings applied", applied);
      } catch (e) {
        Log.warn("settings apply failed", String(e && e.message || e));
      }
      await Retry.sleep(200);
    }

    // 0b) Chain mode — if this is a chained video step, the service worker
    // will have set item.inputMediaUrl to the parent image's mediaUrl. We
    // need to attach that image to Flow as input before typing the prompt.
    // The actual attachInputImage implementation lands in PR #7
    // (content/flow-add-media.js). For PR #6 we just log + warn so the run
    // doesn't silently skip the attachment step.
    if (item.chainStep === "video" && item.inputMediaUrl) {
      const FlowMedia = root.SNFlowAddMedia;
      if (FlowMedia && FlowMedia.attachInputImage) {
        try {
          const ok = await FlowMedia.attachInputImage(item.inputMediaUrl, {
            filename: item.inputFilename,
          });
          Log.log("chain input image attached", { ok });
        } catch (e) {
          throw new Error("attachInputImage failed: " + String(e && e.message || e));
        }
      } else {
        Log.warn("chain video step received inputMediaUrl but flow-add-media.js " +
                 "is not loaded yet (lands in PR #7) — generating video WITHOUT " +
                 "the input image attached");
      }
    }

    // 1) sending prompt
    await reportStatus(item.id, "sending");
    const promptEl = await Retry.waitFor(() => PromptInput.findPromptInput(), {
      timeout: 12_000, interval: 350,
    });
    if (!promptEl) throw new Error("prompt input not found");
    await PromptInput.setPromptText(promptEl, item.prompt);
    await Retry.sleep((settings && settings.promptInputDelayMs) || 250);

    // snapshot media URLs before generation
    const before = ResultWatcher.snapshot();

    // 2) click generate
    const clicked = await Generate.clickGenerate(promptEl);
    if (!clicked) throw new Error("generate button not found");
    await reportStatus(item.id, "generating");

    // 3) wait for new media. For outputCount > 1 we wait for the batch.
    //    Chain video steps run on Veo which is ~2-3x slower than image gen,
    //    so honor settings.chainVideoTimeoutMs when this is a chain video.
    await reportStatus(item.id, "waiting");
    const baseTimeout = (settings && settings.waitTimeoutMs) || 5 * 60 * 1000;
    const chainVideoTimeout = (settings && settings.chainVideoTimeoutMs) || 8 * 60 * 1000;
    const waitOpts = {
      timeout: (item.chainStep === "video") ? chainVideoTimeout : baseTimeout,
    };
    let result;
    if (itemCount > 1) {
      result = await ResultWatcher.waitForBatch(before, itemMode, itemCount, waitOpts);
      if (!result || !result.items || !result.items.length) throw new Error("timed out waiting for media");
    } else {
      const r = await ResultWatcher.waitForNewMedia(before, itemMode, waitOpts);
      if (!r || !r.url) throw new Error("timed out waiting for media");
      result = { mode: r.mode, items: r.all && r.all.length ? r.all : [{ url: r.url, element: r.element }] };
    }
    Log.log("media detected", { count: result.items.length, mode: result.mode });

    // 4) download each item
    await reportStatus(item.id, "downloading");
    const downloads = [];
    for (let i = 0; i < result.items.length; i++) {
      const m = result.items[i];
      const filename = Filename.buildFilename({
        mode: result.mode || itemMode,
        media: { url: m.url, ext: Filename.extFor(m.url, result.mode === "video" ? "mp4" : "png") },
      });
      try {
        const dl = await Downloader.downloadResult(m.element, m.url, filename);
        downloads.push({ ok: true, ...dl });
        Log.log("download triggered", { i, ...dl });
      } catch (e) {
        downloads.push({ ok: false, error: String((e && e.message) || e), filename });
        Log.error("download failed", { i, e: String((e && e.message) || e) });
      }
      // small gap between Flow's native menu clicks
      await Retry.sleep(300);
    }

    const okDls = downloads.filter((d) => d.ok);
    if (!okDls.length) {
      const firstErr = downloads.find((d) => !d.ok);
      throw new Error((firstErr && firstErr.error) || "all downloads failed");
    }

    return {
      ok: true,
      filename: (okDls[0] && okDls[0].filename) || null,
      filenames: okDls.map((d) => d.filename),
      mediaUrl: result.items[0] && result.items[0].url,
      mediaUrls: result.items.map((m) => m.url),
      mode: result.mode || itemMode,
      method: okDls[0] && okDls[0].method,
      downloadId: okDls[0] && okDls[0].downloadId || null,
      downloads,
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
