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

  // Build the prompt that the chained video step should send to Flow.
  //   "same"   → reuse the image prompt verbatim.
  //   "suffix" → append `chainPromptSuffix` to the image prompt with a
  //              comma-or-space separator.
  //   "custom" → use `chainPromptCustom` verbatim. Supports `{prompt}` as
  //              a placeholder for the image prompt. If `chainPromptCustom`
  //              is empty, falls back to "same".
  function buildVideoPrompt(imagePrompt, opts) {
    const source = (opts && opts.chainPromptSource) || "same";
    const suffix = (opts && opts.chainPromptSuffix) || "";
    const custom = (opts && opts.chainPromptCustom) || "";
    if (source === "suffix" && suffix) {
      const sep = /[.!?]$/.test(imagePrompt.trim()) ? " " : ", ";
      return imagePrompt + sep + suffix;
    }
    if (source === "custom" && custom.trim()) {
      // Replace {prompt} (case-insensitive) with the image prompt.
      return custom.replace(/\{prompt\}/gi, imagePrompt);
    }
    return imagePrompt;
  }

  function buildItems(prompts, opts) {
    const now = Date.now();
    // Backward-compat: buildItems(prompts, "image"|"video") — promote to opts
    if (typeof opts === "string") opts = { mode: opts };
    const o = opts || {};
    const mode = o.mode || "image";

    if (mode !== "chain") {
      // Plain image / video mode — one item per prompt, unchanged.
      return prompts.map((p) => ({
        id: uuid(),
        prompt: p,
        mode,
        aspectRatio: o.aspectRatio || "16:9",
        outputCount: parseInt(o.outputCount, 10) || 1,
        status: "pending",
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      }));
    }

    // ---- Chain mode: 1 prompt → image step + N video steps ----
    // chainStrategy === "all" produces one video step per image variant
    // (so x2 images = 2 videos per prompt). Default "first" produces a
    // single video step that consumes the first image variant only.
    const strategy = o.chainStrategy || "first";
    const imageOutputCount = parseInt(o.outputCount, 10) || 1;
    const videoCount = strategy === "all" ? imageOutputCount : 1;
    const videoAspectRatio = o.chainVideoAspectRatio || o.aspectRatio || "16:9";

    const out = [];
    for (const p of prompts) {
      const imageId = uuid();
      out.push({
        id: imageId,
        prompt: p,
        mode: "image",
        chainStep: "image",
        aspectRatio: o.aspectRatio || "16:9",
        outputCount: imageOutputCount,
        status: "pending",
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      });
      const videoPrompt = buildVideoPrompt(p, o);
      for (let i = 0; i < videoCount; i++) {
        out.push({
          id: uuid(),
          prompt: videoPrompt,
          mode: "video",
          chainStep: "video",
          parentId: imageId,
          chainVariantIndex: i,
          aspectRatio: videoAspectRatio,
          outputCount: 1,
          status: "pending",
          attempts: 0,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
    return out;
  }

  root.SNFlowPromptParser = { parsePrompts, buildItems, buildVideoPrompt, uuid };
})(typeof self !== "undefined" ? self : this);
