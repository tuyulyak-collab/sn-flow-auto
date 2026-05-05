/* core/download-path.js — sanitization + template expansion for the
 * "Download Settings" feature (PR #15).
 *
 * Two user-controlled inputs feed `chrome.downloads.download({ filename })`:
 *
 *   1) outputFolder      — relative subfolder under the user's Chrome
 *                          Downloads directory. Default "SN Flow Auto".
 *   2) filenameTemplate  — file name pattern with token shortcuts:
 *                            {random5}    random 5 alphanumeric chars
 *                            {ddmmyyyy}   today's date (local)
 *                            {mode}       image | video | chain
 *                            {index}      queue position (1-based)
 *                            {promptSlug} short safe slug of the prompt
 *
 * Chrome Extension limitation: chrome.downloads.download can only write to
 * the user's Downloads directory or relative subfolders inside it. Absolute
 * paths and `..` traversal are rejected by this module *and* by Chrome
 * itself (Chrome silently fails the download otherwise).
 *
 * Public API:
 *   SNFlowDownloadPath.expandTemplate(template, ctx)        -> string
 *   SNFlowDownloadPath.slugifyPrompt(prompt, max=24)        -> string
 *   SNFlowDownloadPath.validateFilenameTemplate(raw)        -> { ok, error?, value? }
 *   SNFlowDownloadPath.validateOutputFolder(raw)            -> { ok, error?, value? }
 *   SNFlowDownloadPath.sanitizeFilenameBody(name)           -> string
 *   SNFlowDownloadPath.sanitizeOutputFolder(raw)            -> string ("" allowed)
 *   SNFlowDownloadPath.buildDownloadPath({outputFolder, filenameTemplate, ext, ctx})
 *     -> string  (final value passed to chrome.downloads.download.filename)
 */
(function (root) {
  // Forbidden characters in a filename PART (segment) — i.e. anything between
  // path separators. `/` is intentionally NOT in this set because outputFolder
  // is allowed to contain `/` (subfolders), but filenames are not.
  const FORBIDDEN_FILE = /[<>:"|?*\\]/g;
  const FORBIDDEN_FILE_TEST = /[<>:"|?*\\]/;

  // Forbidden characters in a folder PART (segment between slashes).
  // Same as filename forbidden chars (no leading slash already enforced
  // separately). `/` IS allowed in the overall outputFolder string.
  const FORBIDDEN_FOLDER_SEG = /[<>:"|?*\\]/;

  // Reserved Windows filenames — Chrome rejects these regardless of OS.
  const RESERVED_WIN = new Set([
    "CON", "PRN", "AUX", "NUL",
    "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
  ]);

  const MAX_FILENAME_LEN = 120;
  const MAX_FOLDER_SEG_LEN = 80;
  const MAX_TOTAL_PATH_LEN = 240;

  // Detect absolute paths across OSes. Examples blocked:
  //   /Users/name/Desktop
  //   \Users\name
  //   C:\Users\Name\Desktop
  //   D:/Flow Output
  //   ~/Downloads
  //   //server/share
  function isAbsolutePath(s) {
    if (!s) return false;
    if (/^[\/\\]/.test(s)) return true;          // POSIX or Windows root
    if (/^[a-zA-Z]:[\/\\]/.test(s)) return true; // Windows drive letter
    if (/^~[\/\\]?/.test(s)) return true;         // home dir alias
    return false;
  }

  // ---------------- token expansion ----------------

  function alpha5() {
    // Reuse SNFlowFilename.random5 if available (keeps the same alphabet
    // — skip 0/O/1/I — used by the legacy SN_flow_* names). Fall back to
    // a local generator so this module also works in unit-test contexts.
    const F = root.SNFlowFilename;
    if (F && typeof F.random5 === "function") return F.random5();
    const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let out = "";
    for (let i = 0; i < 5; i++) out += ALPHA[Math.floor(Math.random() * ALPHA.length)];
    return out;
  }

  function todayDDMMYYYY(date) {
    const F = root.SNFlowFilename;
    if (F && typeof F.ddmmyyyy === "function") return F.ddmmyyyy(date);
    const d = date || new Date();
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = String(d.getFullYear());
    return `${dd}${mm}${yyyy}`;
  }

  /**
   * Produce a short, filename-safe slug from a prompt. Lowercase ASCII +
   * digits + hyphens. Collapses runs of separators. Truncates at `max`
   * characters (default 24). Empty / non-string input -> "prompt".
   */
  function slugifyPrompt(prompt, max) {
    if (max == null) max = 24;
    if (typeof prompt !== "string") return "prompt";
    const ascii = prompt
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!ascii) return "prompt";
    return ascii.length > max ? ascii.slice(0, max).replace(/-+$/, "") : ascii;
  }

  /**
   * Replace template tokens. Tokens NOT supplied via ctx fall back to
   * sensible defaults so a partial ctx still produces a valid name.
   */
  function expandTemplate(template, ctx) {
    if (!template || typeof template !== "string") template = "SN_flow_{random5}_{ddmmyyyy}";
    const c = ctx || {};
    const date = c.date instanceof Date ? c.date : new Date();
    const tokens = {
      "{random5}":    () => (typeof c.random5 === "string" && c.random5) || alpha5(),
      "{ddmmyyyy}":   () => (typeof c.ddmmyyyy === "string" && c.ddmmyyyy) || todayDDMMYYYY(date),
      "{mode}":       () => String(c.mode || "image").toLowerCase(),
      "{index}":      () => {
        const n = parseInt(c.index, 10);
        return Number.isFinite(n) && n > 0 ? String(n) : "1";
      },
      "{promptSlug}": () => {
        if (typeof c.promptSlug === "string" && c.promptSlug) return c.promptSlug;
        return slugifyPrompt(c.prompt, c.maxSlug);
      },
    };
    let out = template;
    for (const [k, fn] of Object.entries(tokens)) {
      if (out.indexOf(k) === -1) continue;
      const v = fn();
      // Replace globally without regex (k contains regex-special chars).
      out = out.split(k).join(String(v));
    }
    return out;
  }

  // ---------------- sanitization ----------------

  /**
   * Strip forbidden characters from a single filename segment. Also trims
   * trailing dots / spaces (Windows quirks Chrome inherits) and clamps the
   * total length. Never returns "" — returns "untitled" for empty input.
   */
  function sanitizeFilenameBody(name) {
    if (typeof name !== "string") name = "";
    let v = name.replace(FORBIDDEN_FILE, "").replace(/\x00/g, "");
    v = v.replace(/\s+/g, " ").trim();
    // strip trailing dots / spaces (Windows reserved)
    v = v.replace(/[. ]+$/g, "");
    // path separators are not allowed in a filename body
    v = v.replace(/[\/\\]+/g, "_");
    if (!v) v = "untitled";
    if (v.length > MAX_FILENAME_LEN) v = v.slice(0, MAX_FILENAME_LEN);
    // reserved-name safety
    const upper = v.toUpperCase().split(".")[0];
    if (RESERVED_WIN.has(upper)) v = "_" + v;
    return v;
  }

  /**
   * Validate the user's filenameTemplate input. Tokens like `{random5}` are
   * allowed and not treated as forbidden characters even though `{` and `}`
   * pass through fine — we strip them only AFTER expansion via
   * sanitizeFilenameBody.
   *
   * Returns { ok: true, value } on success, or { ok: false, error } with
   * one of the user-facing error strings spec'd in PR #15.
   */
  function validateFilenameTemplate(raw) {
    if (typeof raw !== "string") raw = "";
    const v = raw.trim();
    if (!v) {
      return { ok: false, error: "File name format is invalid. Please remove special characters." };
    }
    if (v.length > MAX_FILENAME_LEN) {
      return { ok: false, error: "File name format is invalid. Please remove special characters." };
    }
    // Strip recognised tokens before checking forbidden chars, so users can
    // still write {random5} etc. without false positives.
    const stripped = v.replace(/\{(random5|ddmmyyyy|mode|index|promptSlug)\}/g, "");
    if (FORBIDDEN_FILE_TEST.test(stripped)) {
      return { ok: false, error: "File name format is invalid. Please remove special characters." };
    }
    // No path separators in a filename
    if (/[\/\\]/.test(stripped)) {
      return { ok: false, error: "File name format is invalid. Please remove special characters." };
    }
    if (/\.\./.test(stripped)) {
      return { ok: false, error: "File name format is invalid. Please remove special characters." };
    }
    return { ok: true, value: v };
  }

  /**
   * Validate the user's outputFolder input. Allows nested subfolders via
   * `/`. Rejects absolute paths, `..` traversal, and forbidden characters.
   * Empty input is valid (means "save directly in Downloads").
   */
  function validateOutputFolder(raw) {
    if (raw == null) raw = "";
    if (typeof raw !== "string") return { ok: false, error: "Save folder must be inside Downloads." };
    const trimmed = raw.trim();
    if (!trimmed) return { ok: true, value: "" };

    if (isAbsolutePath(trimmed)) {
      return { ok: false, error: "Save folder must be inside Downloads." };
    }

    // Normalise backslashes → forward slashes, collapse duplicate slashes,
    // strip leading/trailing slashes.
    const normalised = trimmed
      .replace(/\\+/g, "/")
      .replace(/\/+/g, "/")
      .replace(/^\/+|\/+$/g, "");

    if (!normalised) return { ok: true, value: "" };

    // Strip recognised tokens before checking forbidden chars, so users can
    // still write {ddmmyyyy} etc. in folder names.
    const stripped = normalised.replace(/\{(random5|ddmmyyyy|mode|index|promptSlug)\}/g, "");

    const segs = stripped.split("/");
    for (const seg of segs) {
      if (!seg) continue;
      if (seg === "..") return { ok: false, error: "This folder path is not allowed by Chrome." };
      if (seg === ".") return { ok: false, error: "This folder path is not allowed by Chrome." };
      if (FORBIDDEN_FOLDER_SEG.test(seg)) {
        return { ok: false, error: "This folder path is not allowed by Chrome." };
      }
      if (seg.length > MAX_FOLDER_SEG_LEN) {
        return { ok: false, error: "This folder path is not allowed by Chrome." };
      }
      // Reserved-name check
      const upper = seg.toUpperCase().split(".")[0];
      if (RESERVED_WIN.has(upper)) {
        return { ok: false, error: "This folder path is not allowed by Chrome." };
      }
      if (/[. ]$/.test(seg)) {
        return { ok: false, error: "This folder path is not allowed by Chrome." };
      }
    }

    if (normalised.length > MAX_TOTAL_PATH_LEN) {
      return { ok: false, error: "This folder path is not allowed by Chrome." };
    }

    return { ok: true, value: normalised };
  }

  /**
   * Best-effort sanitizer — returns a usable folder string even for
   * partially-bad input (used as a final guard before chrome.downloads).
   * Empty string is a valid return value (means "save directly in
   * Downloads").
   */
  function sanitizeOutputFolder(raw) {
    const v = validateOutputFolder(raw);
    if (v.ok) return v.value;
    // Fall back: strip everything dangerous and try once more.
    if (typeof raw !== "string") return "";
    const cleaned = raw
      .replace(/\\+/g, "/")
      .replace(/^[~\/]+/, "")
      .replace(/[a-zA-Z]:/, "")
      .replace(/\.\./g, "")
      .replace(FORBIDDEN_FOLDER_SEG, "")
      .replace(/\/+/g, "/")
      .replace(/^\/+|\/+$/g, "");
    const v2 = validateOutputFolder(cleaned);
    return v2.ok ? v2.value : "";
  }

  /**
   * Build the final relative path string for chrome.downloads.download.
   * Sanitizes both folder and filename, expands template tokens, joins
   * with "/", and ensures the total length stays under MAX_TOTAL_PATH_LEN.
   *
   * Returns just `<filename>.<ext>` if outputFolder is empty or invalid.
   */
  function buildDownloadPath({ outputFolder, filenameTemplate, ext, ctx } = {}) {
    const folder = sanitizeOutputFolder(outputFolder);
    const expandedFolder = folder
      ? folder.split("/").map((seg) => expandTemplate(seg, ctx || {})).join("/")
      : "";

    const expandedName = expandTemplate(filenameTemplate, ctx || {});
    const safeName = sanitizeFilenameBody(expandedName);

    const cleanExt = String(ext || "bin").replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || "bin";

    let path = expandedFolder
      ? `${expandedFolder}/${safeName}.${cleanExt}`
      : `${safeName}.${cleanExt}`;

    // Final length guard — chop the filename body if the total is too long.
    if (path.length > MAX_TOTAL_PATH_LEN) {
      const overflow = path.length - MAX_TOTAL_PATH_LEN;
      const newName = safeName.slice(0, Math.max(8, safeName.length - overflow));
      path = expandedFolder
        ? `${expandedFolder}/${newName}.${cleanExt}`
        : `${newName}.${cleanExt}`;
    }

    return path;
  }

  root.SNFlowDownloadPath = {
    expandTemplate,
    slugifyPrompt,
    validateFilenameTemplate,
    validateOutputFolder,
    sanitizeFilenameBody,
    sanitizeOutputFolder,
    buildDownloadPath,
    isAbsolutePath,
    // exported for tests
    _internal: { FORBIDDEN_FILE, FORBIDDEN_FOLDER_SEG, RESERVED_WIN, MAX_FILENAME_LEN, MAX_FOLDER_SEG_LEN, MAX_TOTAL_PATH_LEN },
  };
})(typeof self !== "undefined" ? self : this);
