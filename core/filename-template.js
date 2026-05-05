/* core/filename-template.js — produces filenames like SN_flow_A7K2Q_05052026.mp4
 *
 * Format spec from the user:
 *   SN_flow_{random5}_{ddmmyyyy}
 *   - random5: max 5 alphanumeric (uppercase A-Z + 0-9)
 *   - ddmmyyyy: local user date (no separators)
 *   - extension: matches downloaded media type (.png/.jpg/.mp4/.webm/...)
 */
(function (root) {
  const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // skip 0/O/1/I to make filenames cleaner

  function random5() {
    let out = "";
    for (let i = 0; i < 5; i++) {
      out += ALPHA[Math.floor(Math.random() * ALPHA.length)];
    }
    return out;
  }

  function ddmmyyyy(d = new Date()) {
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = String(d.getFullYear());
    return `${dd}${mm}${yyyy}`;
  }

  /**
   * Pick an extension for a given mime type / URL fallback.
   */
  function extFor(mimeOrUrl, fallback = "bin") {
    if (!mimeOrUrl) return fallback;
    const v = String(mimeOrUrl).toLowerCase();

    // mime
    if (v.startsWith("image/")) {
      if (v.includes("png")) return "png";
      if (v.includes("webp")) return "webp";
      if (v.includes("gif")) return "gif";
      if (v.includes("jpeg") || v.includes("jpg")) return "jpg";
      return "png";
    }
    if (v.startsWith("video/")) {
      if (v.includes("mp4")) return "mp4";
      if (v.includes("webm")) return "webm";
      if (v.includes("quicktime") || v.includes("mov")) return "mov";
      return "mp4";
    }

    // URL — strip query
    const noQ = v.split("?")[0];
    const m = noQ.match(/\.([a-z0-9]{2,5})$/);
    if (m) return m[1];

    return fallback;
  }

  /**
   * Build the final filename from a mode + media descriptor.
   * mediaDescriptor: { mime, url, ext } — any one is sufficient.
   */
  function buildFilename({ mode, media, date } = {}) {
    let ext;
    if (media && media.ext) ext = media.ext;
    else if (media && media.mime) ext = extFor(media.mime);
    else if (media && media.url) ext = extFor(media.url);
    else if (mode === "video") ext = "mp4";
    else ext = "png";

    return `SN_flow_${random5()}_${ddmmyyyy(date)}.${ext}`;
  }

  root.SNFlowFilename = { random5, ddmmyyyy, extFor, buildFilename };
})(typeof self !== "undefined" ? self : this);
