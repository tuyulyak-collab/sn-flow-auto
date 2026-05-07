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

  // Stringify the optional `extra` argument so it never shows up as
  // "[object Object]" in Chrome's extension Errors panel. The Errors panel
  // string-concatenates console.warn args, so passing the raw object loses
  // every field. We expand here once, then pass a single string downstream
  // to console.* below — keep this in sync with consoleArgs() so the live
  // DevTools log and the persisted log both stay readable.
  function stringifyExtra(extra) {
    if (extra === undefined || extra === null) return "";
    if (typeof extra === "string") return extra;
    if (extra instanceof Error) {
      const parts = [extra.name || "Error", extra.message || String(extra)];
      if (extra.stack) parts.push(String(extra.stack).split("\n").slice(0, 4).join(" | "));
      return parts.filter(Boolean).join(": ");
    }
    try {
      return JSON.stringify(extra, (_k, v) => {
        if (v instanceof Error) return { name: v.name, message: v.message };
        if (typeof v === "function") return "[function]";
        if (typeof v === "undefined") return "[undefined]";
        return v;
      });
    } catch (_) {
      try { return String(extra); } catch (__) { return "[unstringifiable]"; }
    }
  }

  function fmt(level, msg, extra) {
    let line = `[${nowIso()}] [${level.toUpperCase()}] ${msg}`;
    const s = stringifyExtra(extra);
    if (s) line += " " + s;
    return line;
  }

  // Collapse the message + extra into a single string before forwarding to
  // console.* so Chrome's Errors panel (and any aggregated logging surface)
  // shows "[SN Flow] <msg> {json}" instead of "[SN Flow] <msg> [object Object]".
  function consoleArgs(msg, extra) {
    const s = stringifyExtra(extra);
    return s ? [`[SN Flow] ${msg} ${s}`] : [`[SN Flow] ${msg}`];
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
    if (typeof console !== "undefined") console.log(...consoleArgs(msg, extra));
    emit(line, "info");
  }

  function warn(msg, extra) {
    const line = fmt("warn", msg, extra);
    if (typeof console !== "undefined") console.warn(...consoleArgs(msg, extra));
    emit(line, "warn");
  }

  function error(msg, extra) {
    const line = fmt("error", msg, extra);
    if (typeof console !== "undefined") console.error(...consoleArgs(msg, extra));
    emit(line, "error");
  }

  function debug(msg, extra) {
    const line = fmt("debug", msg, extra);
    if (typeof console !== "undefined" && console.debug) console.debug(...consoleArgs(msg, extra));
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
