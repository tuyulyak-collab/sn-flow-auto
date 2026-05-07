/* core/diagnostics.js — shared diagnostics helpers used by:
 *   - background/service-worker.js  (collectBackground / SN_FLOW_DIAGNOSE)
 *   - content/content.js             (collectPage / SN_FLOW_DIAGNOSE_PAGE)
 *   - popup/popup.js                 (orchestrates both halves)
 *
 * Cross-PC compatibility report
 * -----------------------------
 * The extension runs the same code on every PC, but Google Flow's UI is
 * highly dynamic: a different account, locale, A/B bucket, or Chrome
 * version can change the prompt-bar markup, the submit button glyph, or
 * the menu container. When the extension fails on a different PC than the
 * one we developed it on, we want a single button the user can click that
 * captures *exactly* which check failed — not a wall of console output.
 *
 * Each check returns a uniform shape:
 *   { id, label, status: "ok" | "warn" | "fail" | "info", detail }
 *
 * Statuses:
 *   ok   — feature is working
 *   warn — feature works but degraded (e.g. fallback selector matched)
 *   fail — blocking issue, the extension cannot run normally
 *   info — purely informational (URL, version, tab title)
 */
(function (root) {
  // Shorthand bag — the modules we depend on may not be loaded yet in
  // every context (e.g. SW doesn't have window.SNFlowDom). Each collector
  // checks for what it needs and degrades gracefully.

  // ---------------- helpers ----------------
  function check(id, label, status, detail) {
    return { id, label, status, detail: detail == null ? "" : String(detail) };
  }

  function safeStr(v, max) {
    if (v === undefined || v === null) return "";
    let s = typeof v === "string" ? v : (function () {
      try { return JSON.stringify(v); } catch (_) { try { return String(v); } catch (__) { return "[?]"; } }
    })();
    s = s.replace(/\s+/g, " ").trim();
    if (max && s.length > max) s = s.slice(0, max - 1) + "…";
    return s;
  }

  // ---------------- page (content-script) checks ----------------
  // Caller passes its module bag so we don't depend on global names that
  // might be shadowed mid-test.
  function collectPage(deps) {
    const out = [];
    const Dom = deps && deps.Dom;
    const PromptInput = deps && deps.PromptInput;
    const Generate = deps && deps.Generate;
    const ResultWatcher = deps && deps.ResultWatcher;
    const Settings = deps && deps.Settings;

    // Page identity (info-only)
    let url = "";
    let title = "";
    let host = "";
    try { url = (typeof location !== "undefined" && location.href) || ""; } catch (_) {}
    try { title = (typeof document !== "undefined" && document.title) || ""; } catch (_) {}
    try { host = (typeof location !== "undefined" && location.hostname) || ""; } catch (_) {}
    out.push(check("page.url", "Current Tab URL", "info", url));
    out.push(check("page.title", "Tab Title", "info", title));
    out.push(check("page.host", "Hostname", "info", host));

    // Supported Flow URL
    let isFlow = false;
    try { isFlow = !!(Dom && Dom.looksLikeFlow && Dom.looksLikeFlow()); } catch (_) {}
    out.push(check(
      "page.is_flow",
      "Supported Google Flow URL",
      isFlow ? "ok" : "fail",
      isFlow ? `host=${host}` : `host=${host} — open https://labs.google/fx/tools/flow first`,
    ));

    // Document readyState (slow PCs may still be loading)
    let ready = "";
    try { ready = (typeof document !== "undefined" && document.readyState) || ""; } catch (_) {}
    out.push(check(
      "page.ready",
      "Document Ready State",
      ready === "complete" ? "ok" : "warn",
      ready,
    ));

    // Viewport (some Flow surfaces only render the prompt bar above a
    // certain width; report it so we can spot zoomed-in / narrow windows).
    try {
      out.push(check(
        "page.viewport",
        "Viewport",
        "info",
        `${window.innerWidth}x${window.innerHeight} dpr=${window.devicePixelRatio || 1}`,
      ));
    } catch (_) {}

    // Module presence (content scripts loaded in correct order)
    out.push(check(
      "modules.loaded",
      "Content Modules Loaded",
      (Dom && PromptInput && Generate && ResultWatcher) ? "ok" : "fail",
      `Dom=${!!Dom} PromptInput=${!!PromptInput} Generate=${!!Generate} ResultWatcher=${!!ResultWatcher} Settings=${!!Settings}`,
    ));

    // Prompt input detection
    if (PromptInput && PromptInput.findPromptInput) {
      let el = null;
      try { el = PromptInput.findPromptInput(); } catch (_) {}
      if (el) {
        const slate = el.getAttribute && el.getAttribute("data-slate-editor") === "true";
        const role = (el.getAttribute && el.getAttribute("role")) || "";
        const tag = el.tagName || "";
        const ce = el.getAttribute && el.getAttribute("contenteditable");
        const r = (() => { try { return el.getBoundingClientRect(); } catch (_) { return null; } })();
        const rect = r ? `${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.left)},${Math.round(r.top)}` : "?";
        out.push(check(
          "prompt.found",
          "Prompt Input Detected",
          "ok",
          `tag=${tag} slate=${slate} role=${role} ce=${ce} rect=${rect}`,
        ));
      } else {
        out.push(check(
          "prompt.found",
          "Prompt Input Detected",
          "fail",
          "no element matched any prompt-input strategy (Slate / contenteditable / role=textbox / textarea / input)",
        ));
      }
    } else {
      out.push(check("prompt.found", "Prompt Input Detected", "fail", "PromptInput module missing"));
    }

    // Generate button detection
    if (Generate && Generate.findGenerateButton) {
      let promptEl = null;
      try { promptEl = PromptInput && PromptInput.findPromptInput && PromptInput.findPromptInput(); } catch (_) {}
      let btn = null;
      try { btn = Generate.findGenerateButton(promptEl); } catch (_) {}
      if (btn) {
        const desc = (Generate.describeButton && Generate.describeButton(btn)) || {};
        out.push(check(
          "generate.found",
          "Generate / Create Button Detected",
          "ok",
          `tag=${desc.tag || btn.tagName} type=${desc.type || ""} aria=${safeStr(desc.aria, 40)} icons=${safeStr(desc.icons, 60)} text=${safeStr(desc.text, 40)}`,
        ));
      } else {
        out.push(check(
          "generate.found",
          "Generate / Create Button Detected",
          "fail",
          "no submit/Generate button matched (looked for arrow_forward icon, submit type, Generate/Create text)",
        ));
      }
    } else {
      out.push(check("generate.found", "Generate / Create Button Detected", "fail", "Generate module missing"));
    }

    // Settings trigger (the chip with Mode / Aspect / Output count)
    if (Settings && Settings.findSettingsTrigger) {
      let trigger = null;
      try { trigger = Settings.findSettingsTrigger(); } catch (_) {}
      out.push(check(
        "settings.trigger",
        "Flow Settings Chip Detected",
        trigger ? "ok" : "warn",
        trigger
          ? `text=${safeStr((trigger.innerText || trigger.textContent || "").trim(), 60)}`
          : "the chip next to Generate (model/aspect/count) was not found — the run will skip applying mode/aspect/count to Flow",
      ));
    }

    // Result area detection — we look for image/video tiles with a Flow
    // media URL or any visible image candidate. On a fresh tab there may
    // be no results yet (info), but if we can find at least the result
    // grid container we report ok.
    if (ResultWatcher) {
      try {
        const snap = ResultWatcher.snapshot ? ResultWatcher.snapshot() : new Set();
        const flowUrls = [];
        for (const u of snap) {
          if (ResultWatcher.isFlowMediaUrl && ResultWatcher.isFlowMediaUrl(u)) flowUrls.push(u);
        }
        out.push(check(
          "result.snapshot",
          "Result Area Snapshot",
          "info",
          `images/videos in DOM=${snap.size}, flow-media urls=${flowUrls.length}`,
        ));
        // imgs / videos visible right now (rough proxy for "result area exists")
        let imgs = 0, vids = 0;
        if (Dom && Dom.queryAllDeep) {
          try { imgs = Dom.queryAllDeep("img").filter((e) => Dom.isVisible(e)).length; } catch (_) {}
          try { vids = Dom.queryAllDeep("video").filter((e) => Dom.isVisible(e)).length; } catch (_) {}
        }
        out.push(check(
          "result.containers",
          "Result Containers (img / video)",
          (imgs + vids) > 0 ? "ok" : "warn",
          `visible img=${imgs} video=${vids} — 0 is normal on a freshly opened tab with no generations yet`,
        ));
      } catch (e) {
        out.push(check("result.snapshot", "Result Area Snapshot", "warn", "snapshot threw: " + safeStr(e, 80)));
      }
    }

    // chrome.storage probe (content scripts can read storage too)
    out.push(check(
      "chrome.storage.api",
      "chrome.storage Available (page)",
      (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) ? "ok" : "fail",
      typeof chrome !== "undefined" ? "chrome.storage.local present" : "chrome global not exposed in this context",
    ));

    // Navigator info — useful for cross-PC comparisons (Chrome version,
    // platform, language, hardware concurrency = a rough perf proxy).
    try {
      const ua = (navigator && navigator.userAgent) || "";
      const platform = (navigator && navigator.platform) || "";
      const lang = (navigator && navigator.language) || "";
      const hc = (navigator && navigator.hardwareConcurrency) || 0;
      out.push(check("env.ua", "User Agent", "info", ua));
      out.push(check("env.platform", "Platform / Language / CPU", "info", `${platform} · ${lang} · ${hc} cores`));
    } catch (_) {}

    return out;
  }

  // ---------------- background (service-worker) checks ----------------
  async function collectBackground() {
    const out = [];
    // Manifest version + permissions
    let manifest = {};
    try { manifest = (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getManifest && chrome.runtime.getManifest()) || {}; } catch (_) {}
    out.push(check(
      "ext.version",
      "Extension Version",
      "info",
      `${manifest.name || "?"} v${manifest.version || "?"} (mv${manifest.manifest_version || "?"})`,
    ));
    out.push(check(
      "ext.permissions",
      "Declared Permissions",
      "info",
      safeStr(manifest.permissions || [], 200),
    ));
    out.push(check(
      "ext.host_permissions",
      "Declared Host Permissions",
      "info",
      safeStr(manifest.host_permissions || [], 200),
    ));

    // chrome.downloads
    out.push(check(
      "downloads.api",
      "chrome.downloads API",
      (typeof chrome !== "undefined" && chrome.downloads && typeof chrome.downloads.download === "function") ? "ok" : "fail",
      typeof chrome !== "undefined" && chrome.downloads
        ? "chrome.downloads.download present"
        : "chrome.downloads not granted — re-load the unpacked extension",
    ));

    // chrome.storage write probe (round-trip a sentinel value)
    let storageDetail = "not tested";
    let storageStatus = "fail";
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        const KEY = "snflow.diag.probe";
        const value = "ok-" + Date.now();
        await new Promise((res, rej) => {
          chrome.storage.local.set({ [KEY]: value }, () => {
            const e = chrome.runtime && chrome.runtime.lastError;
            e ? rej(e) : res();
          });
        });
        const got = await new Promise((res, rej) => {
          chrome.storage.local.get(KEY, (v) => {
            const e = chrome.runtime && chrome.runtime.lastError;
            e ? rej(e) : res(v && v[KEY]);
          });
        });
        await new Promise((res) => chrome.storage.local.remove(KEY, () => res()));
        if (got === value) {
          storageStatus = "ok";
          storageDetail = "round-trip ok";
        } else {
          storageStatus = "fail";
          storageDetail = "round-trip mismatch (expected=" + value + " got=" + safeStr(got, 30) + ")";
        }
      } else {
        storageDetail = "chrome.storage.local not available";
      }
    } catch (e) {
      storageStatus = "fail";
      storageDetail = "storage threw: " + safeStr(e && e.message ? e.message : e, 120);
    }
    out.push(check("storage.write", "chrome.storage Write Probe", storageStatus, storageDetail));

    // chrome.scripting (used to reinject content scripts)
    out.push(check(
      "scripting.api",
      "chrome.scripting API",
      (typeof chrome !== "undefined" && chrome.scripting && typeof chrome.scripting.executeScript === "function") ? "ok" : "warn",
      "needed for content-script reinjection from the popup",
    ));

    // Last download id (if any) — informational, helps spot stale state
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        const got = await new Promise((res) => chrome.storage.local.get("snflow.settings", (v) => res(v && v["snflow.settings"])));
        const lastId = got && got.lastDownloadId;
        out.push(check(
          "downloads.last",
          "Last Download Id",
          "info",
          lastId ? String(lastId) : "(none yet — no completed download tracked)",
        ));
      }
    } catch (_) {}

    return out;
  }

  // ---------------- formatters ----------------
  // Render the report as a copy-friendly plain-text block. Includes a
  // header so users can paste this into a chat / issue without us asking
  // for the version separately.
  function formatText(report) {
    const lines = [];
    lines.push("=== SN Flow Auto — Compatibility Report ===");
    if (report.generatedAt) lines.push("Generated: " + report.generatedAt);
    if (report.summary) lines.push("Summary: " + report.summary);
    lines.push("");
    const sections = report.sections || [];
    for (const sec of sections) {
      lines.push("--- " + (sec.title || "Section") + " ---");
      for (const c of (sec.checks || [])) {
        const tag = (c.status || "info").toUpperCase().padEnd(4, " ");
        lines.push("[" + tag + "] " + (c.label || c.id) + ": " + (c.detail || ""));
      }
      lines.push("");
    }
    return lines.join("\n").trim() + "\n";
  }

  function summarize(allChecks) {
    let ok = 0, warn = 0, fail = 0, info = 0;
    for (const c of allChecks) {
      if (c.status === "ok") ok++;
      else if (c.status === "warn") warn++;
      else if (c.status === "fail") fail++;
      else info++;
    }
    let verdict;
    if (fail > 0) verdict = "FAIL — " + fail + " blocking issue(s) detected";
    else if (warn > 0) verdict = "WARN — " + warn + " degraded check(s)";
    else verdict = "OK — all checks passed";
    return { ok, warn, fail, info, verdict };
  }

  root.SNFlowDiagnostics = {
    check, safeStr,
    collectPage,
    collectBackground,
    formatText,
    summarize,
  };
})(typeof self !== "undefined" ? self : this);
