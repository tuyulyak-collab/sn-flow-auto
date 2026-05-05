/* core/pacing.js — anti-bot pacing for the queue runner.
 *
 * Google Flow throttles aggressive automation. This module models a
 * human-ish pacing strategy without hard-coding any one delay:
 *   - per-prompt random delay between minDelayMs and maxDelayMs (uniform)
 *   - jitter (extra random ms ±jitterMs around the picked delay)
 *   - cooldown: after every `cooldownEvery` prompts, take a longer pause
 *     (cooldownMs ± jitter) so we don't sustain a too-regular cadence
 *   - adaptive backoff: if Flow returns rate-limit signals, multiply the
 *     next delay by 2^N where N is the consecutive-error count (capped),
 *     and require at least `backoffFloorMs` for the next prompt
 *   - aggressive mode: zero out delays (used for stress testing — risk!)
 *
 * Public API:
 *   makePacer(initialSettings) -> {
 *     nextDelayMs(): number,            // delay BEFORE the next prompt
 *     onItemCompleted(),                // call after a prompt finishes ok
 *     onRateLimited(reason?: string),   // call when a rate-limit signal fires
 *     reset(),                          // forget pacing state (after Stop)
 *     getState(): PacerState,
 *     updateSettings(partial),
 *   }
 *
 * Settings shape (subset of DEFAULT_SETTINGS):
 *   { minDelayMs, maxDelayMs, jitterMs,
 *     cooldownEvery, cooldownMs,
 *     adaptiveBackoff, backoffMultiplier, backoffMaxMs, backoffFloorMs,
 *     aggressiveMode }
 */
(function (root) {
  const DEFAULTS = {
    minDelayMs: 30_000,
    maxDelayMs: 60_000,
    jitterMs: 4_000,
    cooldownEvery: 5,           // every 5 prompts, take a longer pause
    cooldownMs: 180_000,        // 3 minutes
    adaptiveBackoff: true,
    backoffMultiplier: 2,       // delay × 2^errorStreak
    backoffMaxMs: 15 * 60_000,  // cap at 15 min
    backoffFloorMs: 90_000,     // after a rate-limit, ≥ 90s before next prompt
    aggressiveMode: false,      // when true, all delays collapse to 0 (dangerous)
  };

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  function uniform(lo, hi) {
    if (lo > hi) [lo, hi] = [hi, lo];
    return lo + Math.random() * (hi - lo);
  }

  function withJitter(ms, jitter) {
    if (!jitter || jitter <= 0) return Math.max(0, Math.round(ms));
    return Math.max(0, Math.round(ms + uniform(-jitter, jitter)));
  }

  function makePacer(initial) {
    let s = { ...DEFAULTS, ...(initial || {}) };
    const state = {
      // count of prompts paced since last reset/cooldown
      sinceCooldown: 0,
      // count of prompts ever paced (useful for telemetry)
      total: 0,
      // streak of consecutive rate-limit signals (resets on a successful item)
      errorStreak: 0,
      // last reason text we got from the network/DOM sniffer
      lastReason: null,
      // unix ms timestamp of the last rate-limit event (or null)
      lastRateLimitAt: null,
      // unix ms timestamp of the last completed item (or null)
      lastCompletedAt: null,
    };

    function nextDelayMs() {
      if (s.aggressiveMode) return 0;

      // base delay (uniform within [min,max])
      let base = uniform(s.minDelayMs, s.maxDelayMs);

      // cooldown injection — only AFTER reaching the threshold, before the
      // next prompt. We bump the delay (don't replace) so we still preserve
      // a randomised feel.
      let cooldownActive = false;
      if (s.cooldownEvery > 0 && state.sinceCooldown >= s.cooldownEvery) {
        base = Math.max(base, s.cooldownMs);
        cooldownActive = true;
      }

      // adaptive backoff multiplier
      if (s.adaptiveBackoff && state.errorStreak > 0) {
        const factor = Math.pow(s.backoffMultiplier, state.errorStreak);
        base *= factor;
        base = Math.max(base, s.backoffFloorMs);
        base = Math.min(base, s.backoffMaxMs);
      }

      const ms = withJitter(base, s.jitterMs);
      // After scheduling a delay, advance bookkeeping
      if (cooldownActive) state.sinceCooldown = 0;
      return ms;
    }

    function onItemCompleted() {
      state.sinceCooldown += 1;
      state.total += 1;
      state.errorStreak = 0;        // success resets the backoff
      state.lastReason = null;
      state.lastCompletedAt = Date.now();
    }

    function onRateLimited(reason) {
      state.errorStreak += 1;
      state.lastReason = reason || "rate-limited";
      state.lastRateLimitAt = Date.now();
    }

    function reset() {
      state.sinceCooldown = 0;
      state.total = 0;
      state.errorStreak = 0;
      state.lastReason = null;
      state.lastRateLimitAt = null;
      state.lastCompletedAt = null;
    }

    function getState() {
      return { ...state, settings: { ...s } };
    }

    function updateSettings(patch) {
      s = { ...s, ...(patch || {}) };
    }

    return {
      nextDelayMs,
      onItemCompleted,
      onRateLimited,
      reset,
      getState,
      updateSettings,
    };
  }

  /**
   * isRateLimitMessage(text): cheap heuristic for whether a piece of text
   * (toast content, error body) looks like Flow telling us we're being
   * throttled. Used by content/dom-error-watcher.js and the network sniffer.
   */
  const RL_PATTERNS = [
    /rate.?limit/i,
    /too.?many.?req/i,
    /try.?again.?(later|in)/i,
    /quota.?(exceeded|reached|limit)/i,
    /capacity/i,
    /unusual.?traffic/i,
    /unavailable.*try.?again/i,
    /can'?t.?process.*right.?now/i,
    /sedang.?banyak/i,        // ID
    /coba.?lagi.?nanti/i,     // ID
    /tunggu.?sebentar/i,      // ID
    /you.?(are|'re).?being.?rate/i,
    /\b429\b/,                // status code mention
    /generation.?(failed|error).*try/i,
  ];

  function isRateLimitMessage(text) {
    if (!text || typeof text !== "string") return false;
    for (const rx of RL_PATTERNS) if (rx.test(text)) return true;
    return false;
  }

  /**
   * isRateLimitStatus(status): whether an HTTP status code from a Flow tRPC
   * call indicates rate-limiting. Used by background/network-sniffer.js.
   */
  function isRateLimitStatus(status) {
    if (typeof status !== "number") return false;
    return status === 429 || status === 503;
  }

  root.SNFlowPacing = {
    DEFAULTS,
    makePacer,
    isRateLimitMessage,
    isRateLimitStatus,
    RL_PATTERNS: RL_PATTERNS.map(r => r.toString()),
  };
})(typeof self !== "undefined" ? self : this);
