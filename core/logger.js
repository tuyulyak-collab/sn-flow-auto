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

  function nowHHMMSS() {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  }

  // Render the `extra` payload of a log call in a human-friendly, terse way.
  // Strings are passed through. Objects are flattened into `key=value` pairs
  // (max 4 keys, values truncated to 32 chars) so the popup log never gets
  // a wall of JSON like `{cooldownEvery:5,cooldownMs:180000,adaptiveBackoff
  // :true,backoffMultiplier:2,...}`.
  function fmtExtra(extra) {
    if (extra === undefined || extra === null || extra === "") return "";
    if (typeof extra === "string") return extra;
    if (typeof extra !== "object") return String(extra);
    try {
      const parts = [];
      const keys = Object.keys(extra).slice(0, 4);
      for (const k of keys) {
        let v = extra[k];
        if (v === null || v === undefined) continue;
        if (typeof v === "object") {
          // one level deep — just count keys / array length
          if (Array.isArray(v)) v = `[${v.length}]`;
          else v = `{${Object.keys(v).length}}`;
        } else {
          v = String(v);
          if (v.length > 32) v = v.slice(0, 29) + "…";
        }
        parts.push(`${k}=${v}`);
      }
      const remainder = Object.keys(extra).length - keys.length;
      if (remainder > 0) parts.push(`+${remainder}…`);
      return parts.join(" ");
    } catch (_) {
      return "";
    }
  }

  function fmt(level, msg, extra) {
    // For info-level lines we omit the level tag so the log reads as a
    // simple `HH:MM:SS msg …` stream. Warn / error / debug keep their
    // tag so problems still stand out.
    const tag = level === "info" ? "" : `[${level.toUpperCase()}] `;
    let line = `[${nowHHMMSS()}] ${tag}${msg}`;
    const tail = fmtExtra(extra);
    if (tail) line += " \u2014 " + tail;
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
