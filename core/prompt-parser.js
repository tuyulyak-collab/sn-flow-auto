/* core/prompt-parser.js — parse manual textarea / TXT file into prompts.
 * Rule: one non-empty line = one prompt. Strips BOM, trims, ignores comment lines (#).
 */
(function (root) {
  const COMMENT_RE = /^\s*(#|\/\/)/;

  function parsePrompts(text) {
    if (!text) return [];
    // strip UTF-8 BOM
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    // normalize newlines
    const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      if (COMMENT_RE.test(line)) continue;
      out.push(line);
    }
    return out;
  }

  function uuid() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return "id-" + Math.random().toString(36).slice(2, 10) + "-" + Date.now().toString(36);
  }

  function buildItems(prompts, mode) {
    const now = Date.now();
    return prompts.map((p) => ({
      id: uuid(),
      prompt: p,
      mode: mode || "image",
      status: "pending",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    }));
  }

  root.SNFlowPromptParser = { parsePrompts, buildItems, uuid };
})(typeof self !== "undefined" ? self : this);
