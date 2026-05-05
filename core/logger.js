/* core/logger.js
 * Lightweight logger shared by content scripts, popup, and service worker.
 * - keeps the most recent N lines in memory (and mirrors to chrome.storage.local
 *   when available so the popup can read history)
 * - exposes both a global (window.SNFlowLogger / self.SNFlowLogger) and a
 *   commonJS-style getter so other modules can reuse it.
 */
(function (root) {
  const MAX_LINES = 200;
  const STORAGE_KEY = "snflow.logs";

  const state = {
    lines: [],
    listeners: new Set(),
  };

  function nowIso() {
    return new Date().toISOString();
  }

  function fmt(level, msg, extra) {
    let line = `[${nowIso()}] [${level.toUpperCase()}] ${msg}`;
    if (extra !== undefined) {
      try {
        line += " " + (typeof extra === "string" ? extra : JSON.stringify(extra));
      } catch (_) {
        // ignore circular structures
      }
    }
    return line;
  }

  function persist() {
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ [STORAGE_KEY]: state.lines.slice(-MAX_LINES) });
      }
    } catch (_) {
      // best-effort
    }
  }

  function emit(line, level) {
    state.lines.push(line);
    if (state.lines.length > MAX_LINES) state.lines.splice(0, state.lines.length - MAX_LINES);
    persist();
    for (const cb of state.listeners) {
      try { cb({ line, level }); } catch (_) {}
    }
  }

  function log(msg, extra) {
    const line = fmt("info", msg, extra);
    if (typeof console !== "undefined") console.log("[SN Flow]", msg, extra ?? "");
    emit(line, "info");
  }

  function warn(msg, extra) {
    const line = fmt("warn", msg, extra);
    if (typeof console !== "undefined") console.warn("[SN Flow]", msg, extra ?? "");
    emit(line, "warn");
  }

  function error(msg, extra) {
    const line = fmt("error", msg, extra);
    if (typeof console !== "undefined") console.error("[SN Flow]", msg, extra ?? "");
    emit(line, "error");
  }

  function debug(msg, extra) {
    const line = fmt("debug", msg, extra);
    if (typeof console !== "undefined" && console.debug) console.debug("[SN Flow]", msg, extra ?? "");
    emit(line, "debug");
  }

  function getLines() {
    return state.lines.slice();
  }

  function clear() {
    state.lines.length = 0;
    persist();
  }

  function subscribe(cb) {
    state.listeners.add(cb);
    return () => state.listeners.delete(cb);
  }

  root.SNFlowLogger = { log, warn, error, debug, getLines, clear, subscribe };
})(typeof self !== "undefined" ? self : this);
