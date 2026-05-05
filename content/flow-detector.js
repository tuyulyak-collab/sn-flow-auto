/* content/flow-detector.js
 * Helpers shared across content scripts: deep DOM walking (incl. open Shadow DOM),
 * visibility/enabled checks, text helpers. Exposes window.SNFlowDom.
 *
 * NOTE: Google Flow's exact DOM is dynamic and may change. We deliberately keep
 * this module selector-agnostic and let prompt-input / generate-button /
 * result-watcher do scoring against multiple keyword candidates.
 */
(function (root) {
  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    if (el.closest && el.closest('[aria-hidden="true"]')) return false;
    return true;
  }

  function isEnabled(el) {
    if (!el) return false;
    if (el.disabled) return false;
    if (el.getAttribute("aria-disabled") === "true") return false;
    return true;
  }

  function elText(el) {
    if (!el) return "";
    return (
      el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") ||
      el.getAttribute("title") ||
      el.textContent ||
      ""
    ).toLowerCase().trim();
  }

  // Walk every node in the DOM, descending into open shadow roots.
  function* walkAll(rootNode) {
    const stack = [rootNode];
    while (stack.length) {
      const node = stack.pop();
      if (!node) continue;
      yield node;
      if (node.shadowRoot) stack.push(node.shadowRoot);
      const children = node.children ? Array.from(node.children) : [];
      for (const c of children) stack.push(c);
    }
  }

  function queryAllDeep(selector, rootNode) {
    const out = [];
    try {
      for (const node of walkAll(rootNode || document)) {
        if (node && node.querySelectorAll) {
          node.querySelectorAll(selector).forEach((el) => out.push(el));
        }
      }
    } catch (_) {
      try { (rootNode || document).querySelectorAll(selector).forEach((el) => out.push(el)); } catch (_) {}
    }
    return Array.from(new Set(out));
  }

  function distance(a, b) {
    try {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const dx = (ra.left + ra.width / 2) - (rb.left + rb.width / 2);
      const dy = (ra.top + ra.height / 2) - (rb.top + rb.height / 2);
      return Math.sqrt(dx * dx + dy * dy);
    } catch (_) { return Infinity; }
  }

  function looksLikeFlow() {
    const host = location.hostname.toLowerCase();
    const url = location.href.toLowerCase();
    const t = (document.title || "").toLowerCase();
    return /(^|\.)labs\.google$/.test(host)
        || /(^|\.)flow\.google$/.test(host)
        || /aitestkitchen\.withgoogle\.com$/.test(host)
        || url.includes("/flow")
        || t.includes("flow");
  }

  root.SNFlowDom = {
    isVisible, isEnabled, elText, walkAll, queryAllDeep, distance, looksLikeFlow,
  };
})(typeof self !== "undefined" ? self : this);
