/* core/retry.js — small retry / wait helpers. */
(function (root) {
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * Wait until `predicate()` returns truthy or `timeout` ms elapses.
   * Returns whatever the predicate returned, or null on timeout.
   */
  async function waitFor(predicate, { timeout = 30_000, interval = 300, signal } = {}) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (signal && signal.aborted) return null;
      try {
        const v = await predicate();
        if (v) return v;
      } catch (_) { /* swallow */ }
      await sleep(interval);
    }
    return null;
  }

  /**
   * Retry an async fn up to `attempts` times with exponential backoff.
   */
  async function retry(fn, { attempts = 3, baseDelay = 500, maxDelay = 5_000, signal, onAttempt } = {}) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      if (signal && signal.aborted) throw new Error("aborted");
      try {
        if (onAttempt) onAttempt(i + 1);
        return await fn(i + 1);
      } catch (err) {
        lastErr = err;
        const delay = Math.min(maxDelay, baseDelay * Math.pow(2, i));
        await sleep(delay);
      }
    }
    throw lastErr || new Error("retry failed");
  }

  root.SNFlowRetry = { sleep, waitFor, retry };
})(typeof self !== "undefined" ? self : this);
