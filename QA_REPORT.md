# QA Report — SN Flow Auto v0.1.0 (Phase 9 Stabilization)

**Date**: 2026-05-05
**Chrome version**: 136 (Manifest V3)
**Google Flow URL**: `https://labs.google/fx/tools/flow`
**Extension version**: 0.1.0
**Branch**: post-PR#8 merge (includes PR #6 Chain schema, PR #7 attach media + Veo picker, PR #8 chain UX polish)

---

## Tested Modes

| Mode | Tested | Notes |
| --- | --- | --- |
| Image | Code verified | Prompt input, generate, result watcher, download path all reviewed |
| Video | Code verified | Same pipeline with video-specific timeout (5 min) |
| Chain (Image → Video) | Code verified | Image step → attach via flow-add-media.js → video step with Veo model picker |

---

## Code-Level Verification (Static Analysis)

All 20 JS files pass `node --check` (syntax validation).

### Failure Recovery — Pass/Fail Table

| Scenario | Status | Implementation |
| --- | --- | --- |
| Prompt input not found → retry | PASS | `content.js`: wrapped in `Retry.retry()` with 3 attempts, exponential backoff |
| Generate button not found → retry | PASS | `content.js`: wrapped in `Retry.retry()` with 3 attempts |
| Result detection timeout → fail only current item | PASS | `service-worker.js`: per-item error handling, queue continues |
| Download fails → retry download | PASS | `content.js`: `Retry.retry()` with 2 attempts per download |
| Flow UI changes → readable error | PASS | `content.js`: error message translation (prompt/generate/timeout/tab) |
| Failed items retryable | PASS | `popup.js`: per-row ⟳ button + bulk Retry Failed; cascade reset for chain parents |

### Queue Persistence — Pass/Fail Table

| Scenario | Status | Implementation |
| --- | --- | --- |
| Queue persists after popup closes | PASS | `chrome.storage.local` — popup reads on open, writes on change |
| Running state visible in floating monitor | PASS | `floating-monitor.js`: reads `chrome.storage.onChanged` |
| Browser/extension reload → recover as Idle | PASS | `service-worker.js`: `onStartup` → `resetActive()` + set running=false |
| Extension reinstall → safe reset | PASS | `service-worker.js`: `onInstalled` → running=false |
| In-flight item reverts after tab close | PASS | `service-worker.js`: `revertInFlightAndStop()` on `tabs.onRemoved` |
| In-flight item reverts after tab navigate | PASS | `service-worker.js`: `revertInFlightAndStop()` on `tabs.onUpdated` |

### UX Polish — Pass/Fail Table

| Scenario | Status | Implementation |
| --- | --- | --- |
| Empty state when queue is empty | PASS | `popup.js`: shows "No prompts in queue" placeholder row |
| Run completion summary | PASS | `popup.js`: "All N items completed" or "X done, Y failed, Z skipped" |
| Floating monitor run summary | PASS | `floating-monitor.js`: shows done/failed summary when run finishes |
| Floating monitor empty state | PASS | `floating-monitor.js`: shows "No prompts queued" when total=0 |
| Simplified error messages | PASS | `content.js`: translates DOM errors to user-friendly text |
| Status tags readable | PASS | `popup.js`: status rendered as colored tags |
| UI gradient preserved | PASS | `popup.css` / `floating-monitor.css`: `linear-gradient(135deg, #e1eec3, #f05053)` |

### Download Validation — Pass/Fail Table

| Scenario | Status | Implementation |
| --- | --- | --- |
| Duplicate filenames handled | PASS | `service-worker.js`: `conflictAction: "uniquify"` in `chrome.downloads.download()` |
| random5 = exactly 5 chars | PASS | `filename-template.js`: loop 5 iterations from 30-char alphabet |
| random5 chars are uppercase alphanumeric | PASS | Alphabet: `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (0/O/1/I excluded for readability) |
| ddmmyyyy uses local date | PASS | `filename-template.js`: `new Date().getDate()`, `.getMonth()`, `.getFullYear()` |
| Image extension correct | PASS | `filename-template.js`: mime-based → png/jpg/webp/gif; fallback "png" |
| Video extension correct | PASS | `filename-template.js`: mime-based → mp4/webm/mov; fallback "mp4" |
| Download subfolder | PASS | `service-worker.js`: saves to `SN_Flow_Auto/` subfolder |

---

## Build Check

| Command | Status | Notes |
| --- | --- | --- |
| `node --check` (all 20 .js files) | PASS | No syntax errors |
| `npm install` | N/A | No package.json — pure MV3 extension, no build tooling |
| `npm run lint` | N/A | No linter configured |
| `npm run typecheck` | N/A | No TypeScript |
| `npm run build` | N/A | No build step — extension loads directly as unpacked |

---

## Bugs Found & Fixed (This PR)

1. **No retry on prompt input detection** — prompt input lookup was single-attempt; now retries 3x with exponential backoff.
2. **No retry on generate button click** — single-attempt; now retries 3x.
3. **No retry on download failure** — single-attempt; now retries 2x per tile.
4. **No empty state in popup queue** — blank table when queue empty; now shows helpful placeholder message.
5. **No run completion summary** — progress bar just showed "N / N"; now shows "All items completed" or detailed breakdown.
6. **Floating monitor missing run summary** — showed "idle" with no context after run; now shows "done · X ok, Y failed".
7. **Raw DOM error messages** — errors like "prompt input not found" shown verbatim; now translated to user-friendly messages.

---

## Pending Live Testing (Next Session)

The following require live browser interaction with Google Flow and are deferred to a dedicated testing session:

- [ ] Image mode regression: 1, 5, 10, 25 prompts
- [ ] Video mode regression: 1, 5, 10 prompts
- [ ] Chain mode regression (Image → Video)
- [ ] Manual textarea input end-to-end
- [ ] TXT upload end-to-end
- [ ] Pause / Resume / Stop / Retry Failed / Clear Queue controls
- [ ] Tab close / refresh / navigate away recovery
- [ ] Auto-download filename format validation (actual files)
- [ ] Floating monitor visual inspection
- [ ] Extension reload recovery

---

## Known Limitations

1. No official Flow API — all automation via DOM interaction.
2. Flow rate-limits aggressive automation (default pacing: 30–60s).
3. Video gen is slow (Veo: 1–3 min per prompt, 8-min timeout for chain video).
4. `random5` uses 30-char alphabet (excludes 0/O/1/I) — intentional for readability.
5. Single Flow tab operation.
6. Flow may generate fewer tiles than requested output count (especially video).
