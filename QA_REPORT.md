# QA Report — SN Flow Auto v0.1.0 (Phase 9 + PR #10 Live Regression)

This is the live regression QA report for PR #10. PR #9 (Stabilization & Reliability) has been merged; this pass loads the merged build as an unpacked extension in Chrome and exercises every UI surface that does **not** require Google Flow account credits.

## Test environment

| Field | Value |
| --- | --- |
| Date | 2026-05-05 |
| Branch | `devin/pr9-live-regression` |
| Base | `devin/1777944480-scaffold-sn-flow-auto` (post-PR#9 merge) |
| Browser | Google Chrome for Testing 133.0.6943.126 (Linux x86_64, MV3) |
| Extension version | 0.1.0 |
| Extension ID | `dhkemolhkphjhmnigghbjmoiabgplogk` (unpacked) |
| Tested URL | `https://labs.google/flow/about` (no login required) |
| Tested account | _Not used_ — all tests are no-credit; live generation is deferred to a follow-up session |
| Build tooling | None — pure MV3, no `package.json` / lint / typecheck / build |

## Summary

| Result | Count |
| --- | --- |
| PASS | 13 |
| FAIL (regression found, fixed in this PR) | 1 |
| Untested — needs Google Flow login & credits | 5 |

A regression was found in the floating monitor's Stop button (it relied on `window.confirm()`, which is suppressed under `--enable-automation` and silently returned `false`). It is fixed in this PR by reusing the same custom `<dialog>` pattern the popup already uses.

## Pass / fail table

### Popup (browser action)

| # | Scenario | Result | Evidence |
| --- | --- | --- | --- |
| P1 | Popup opens with IDLE pill, gradient header, empty queue placeholder, Start/Pause/Resume/Stop disabled appropriately | PASS | screenshot 03, 04 |
| P2 | Mode dropdown switches between Image / Video / Chain (Image → Video); Chain panel hidden unless Chain selected | PASS | screenshot 07 |
| P3 | 10 image prompts pasted into textarea + "Add to Queue" populates 10 PENDING rows, table shows mode `image · 16:9`, count "10 items", progress "0 / 10" | PASS | screenshot 04 |
| P4 | Popup close → reopen preserves the entire queue and run state from `chrome.storage.local` | PASS | screenshot 04 (after re-open) |
| P5 | Stop button shows custom HTMLDialogElement confirm with title "Stop & reset queue?" and copy describing the reset behaviour; **Cancel** preserves running state and all 10 PENDING items | PASS | screenshot 05 |
| P6 | **Stop & reset** button clears every item back to PENDING, sets `running=false`, logs "queue stopped + fully reset count:10", and re-enables Start | PASS | screenshot 06 |
| P7 | Pause / Resume buttons toggle `paused` state without confirmation; button enablement reflects `(running, paused)` correctly | PASS | live test |
| P8 | Retry Failed resets only FAILED items back to PENDING, leaves PENDING/COMPLETED items alone | PASS | live test |
| P9 | Clear Queue shows custom confirm "Clear queue?"; Cancel preserves the queue | PASS | live test |
| P10 | Service worker emits friendly "Open https://labs.google first" error when run is started without a Flow tab open (soft-stop, queue intact) | PASS | live test |

### Floating monitor (content script on labs.google)

| # | Scenario | Result | Evidence |
| --- | --- | --- | --- |
| F1 | "SN" floating action button injects bottom-right of `https://labs.google/flow/about` | PASS | screenshot 08 |
| F2 | FAB click opens panel; panel is draggable by header; minimize button collapses body to header-only; second click restores | PASS | live test |
| F3 | Panel reads `chrome.storage.local` and shows accurate state: pill RUNNING, status `running · pending`, current `image · 16:9 · #5`, current item's prompt visible | PASS | screenshot 08 |
| F4 | **Pre-fix:** Stop button used native `window.confirm()` which is suppressed by `--enable-automation` and returns `false` silently, so Stop did nothing | **FAIL** (fixed in this PR) | recorded in video |
| F5 | **Post-fix:** Stop button uses the same `HTMLDialogElement.showModal()` pattern as the popup, so it works regardless of Chrome's automation flags | PASS (code review + content script reload) | new dialog CSS in `floating-monitor.css` |

### Filename validation (`SN_flow_{random5}_{ddmmyyyy}.{ext}`)

Verified programmatically from the service worker DevTools console (see screenshot 02):

| # | Input | Output |
| --- | --- | --- |
| N1 | `buildFilename({mode:'image', media:{mime:'image/png'}})` | `SN_flow_2UUAV_05052026.png` |
| N2 | `buildFilename({mode:'image', media:{mime:'image/jpeg'}})` | `SN_flow_KMDNS_05052026.jpg` |
| N3 | `buildFilename({mode:'video', media:{mime:'video/mp4'}})` | `SN_flow_SVTFD_05052026.mp4` |
| N4 | `buildFilename({mode:'video', media:{mime:'video/webm'}})` | `SN_flow_EJ97U_05052026.webm` |
| N5 | `buildFilename({mode:'image'})` (no media → defaults to `.png`) | `SN_flow_PX9HF_05052026.png` |
| N6 | `buildFilename({mode:'video'})` (no media → defaults to `.mp4`) | `SN_flow_TCZDE_05052026.mp4` |
| N7 | `random5()` × 20 trials — all length 5 | PASS |
| N8 | `random5()` × 20 trials — all match `[A-Z2-9]+` (excludes `0/O/1/I` for legibility) | PASS |
| N9 | `ddmmyyyy(new Date(2026,4,5))` returns `"05052026"` | PASS |
| N10 | `ddmmyyyy()` (today, no arg) returns `"05052026"` | PASS |

### Recovery (code-level review only — see "Pending" below)

| # | Scenario | Implementation reference | Result |
| --- | --- | --- | --- |
| R1 | Tab close mid-run → in-flight item → PENDING, run halts | `background/service-worker.js:517-522` `tabs.onRemoved` → `revertInFlightAndStop("Flow tab closed")` | Code verified, **needs live test in next session** |
| R2 | Tab navigate-away mid-run → in-flight item → PENDING | `background/service-worker.js:524-533` `tabs.onUpdated` → `revertInFlightAndStop("Flow tab navigated away")` | Code verified, **needs live test in next session** |
| R3 | Browser restart with a half-finished run → reset on startup | `background/service-worker.js:486-490` `chrome.runtime.onStartup` → `Queue.resetActive(queue)` | Code verified, **needs live test in next session** |

## Bug found

### Regression: floating monitor Stop button is a no-op under `--enable-automation`

**Severity:** medium — Stop is reachable from the in-page panel and is the documented "panic button" for users who don't want to open the popup.

**Repro:**
1. Load extension; open Flow tab; start a run.
2. Click the SN floating monitor's Stop button.
3. Expected: confirmation dialog → user confirms → run stops, queue reset.
4. Actual: nothing happens. No dialog. Run keeps going.

**Root cause:** `content/floating-monitor.js` called `window.confirm(...)`. Chromium suppresses native confirm in any context launched with `--enable-automation` (including Chrome for Testing, Selenium, Playwright) and immediately resolves it as `false`. The popup already worked around the same problem by using `HTMLDialogElement.showModal()` (`popup/popup.js` `snfConfirm`); the floating monitor was never updated to match.

**Fix in this PR:**
- `content/floating-monitor.js` — added `buildConfirmDialog()` and `snfConfirm(message, opts)` that mirrors the popup's API; replaced the `window.confirm(...)` call in the Stop handler with `await snfConfirm(...)`. Falls back to non-modal `dialog.show()` if `showModal()` throws on a host page that polyfills `<dialog>`.
- `content/floating-monitor.css` — added `#snflow-confirm` styles (gradient + backdrop) namespaced to avoid colliding with Flow's own CSS, with `z-index: 2147483647` so it sits above the page and above the monitor itself.

## Known limitations

- **No build tooling.** Pure MV3 extension — there is no `package.json`, no `npm install / lint / typecheck / build`. Syntax sanity is checked with `node --check` on each `.js` file. Adding a lint stack is intentionally out of scope for PR #10 (regression-only).
- **No live Flow generation in this run.** Image / video / chain end-to-end generation tests were not exercised because they require a Google Flow account login and burn through the user's Flow generation quota. They are listed in "Pending — to do in next session" below so they can be picked up explicitly.
- **`window.confirm` is also auto-rejected under `--enable-automation`.** This is why we cannot test the Stop confirmation behaviour from a Selenium/Playwright/Chrome-for-Testing context using the native API. The fix removes that dependency.

## Screenshots & video

| # | Description | Link |
| --- | --- | --- |
| 01 | Extension loaded on `chrome://extensions` (no errors, service worker active, host permissions for labs/flow/aitestkitchen) | [screenshot](https://app.devin.ai/attachments/b9891894-4f6b-4ec7-91fc-fa028200123d/screenshot_4f583b187f5943d2bda32a1c4043cd09.png) |
| 02 | Filename format validated in service worker DevTools console — image/video/jpg/webm/no-media all match `SN_flow_{random5}_{ddmmyyyy}.{ext}`; random5 charset and length verified for 20 samples | [screenshot](https://app.devin.ai/attachments/4f723678-d583-4930-9028-03821d8a8ce4/screenshot_ae0b865ea89f4ec9bbba8ab5505ce112.png) |
| 03 | Popup empty state — gradient header, IDLE pill, "No prompts in queue. Type prompts above or import a .txt file." | [screenshot](https://app.devin.ai/attachments/14f7a962-2f2f-4fa1-b373-9b5d987ddb46/screenshot_04e4373e790c486e996092fe8c5dfeb3.png) |
| 04 | Popup with 10 image prompts queued — table shows PENDING rows, count "10 items", progress "0 / 10" | [screenshot](https://app.devin.ai/attachments/9fc62fb0-7408-404b-bbed-6f1dfb6a7ba0/screenshot_1e069a24bd0a49c6927b85fdd1e89c51.png) |
| 05 | Popup Stop confirmation — custom HTMLDialogElement with title "Stop & reset queue?" and `Cancel` / `Stop & reset` buttons | [screenshot](https://app.devin.ai/attachments/7a7cb42e-ecf3-4cf0-9749-7190514493af/screenshot_22a75cd2ef5a4e05853d00443e66f7c4.png) |
| 06 | After confirming Stop & reset — log shows "queue stopped + fully reset count:10"; Start re-enabled; all items still PENDING | [screenshot](https://app.devin.ai/attachments/bba26991-1e8a-4eb3-b50f-31049f3750ac/screenshot_ed4b8c207e594b30a7b6f759a6f55bc8.png) |
| 07 | Chain mode panel shown only when Mode = Chain (Image → Video); strategy/prompt/run-order/aspect/model dropdowns + 2-rows-per-prompt notice | [screenshot](https://app.devin.ai/attachments/1fb8ca92-55c4-4ed2-8c35-2629d01eb51d/screenshot_c0217e5e590743f9a1850514b5c498cb.png) |
| 08 | Floating monitor on `labs.google/flow/about` — pill RUNNING, status `running · pending`, current `image · 16:9 · #5`, current item's prompt visible, Pause enabled, Resume disabled, Stop enabled | [screenshot](https://app.devin.ai/attachments/485e7b8f-68db-4a4d-ac58-f83efe48d6c3/screenshot_d6c3d0e7aec747c69f8a06d30bad933b.png) |
| video | End-to-end recording of the regression session (popup tests, monitor tests, the floating-monitor Stop bug being reproduced) | attached to PR comment |

## Pending — to do in next session (PR #10 follow-up or PR #11)

The following test scenarios were intentionally **not** executed in this session because they require Google Flow account login and consume generation quota. The fix in this PR is independent of these tests, but they should be run before declaring full PR-#9 regression coverage:

1. **Live Flow generation** — log in to `https://labs.google/flow/`, open a project, and run:
   - Image mode × **1**, **5**, **10** prompts — verify each download saves to `Downloads/SN_Flow_Auto/SN_flow_{random5}_{ddmmyyyy}.png` and the queue marks each item COMPLETED with the same filename in the row.
   - Video mode × **1**, **5** prompts — same checks but `.mp4`. Confirm the 5-min timeout is honoured.
   - Chain (Image → Video) mode × at least 1 prompt — verify image step completes, then attached input image lands on the video step (PR #7 `flow-add-media.js`), then video step completes with the configured Veo model (PR #8). Confirm queue rows show 2 entries per prompt (image + video) with parent-link badge.
2. **TXT upload** — drop a `.txt` file with 5 prompts via the "Import .txt" button; verify each prompt becomes one queue row, and "Add to Queue" still works after import.
3. **Tab lifecycle recovery (live)** — start a real run, then while item N is in-flight:
   - Close the Flow tab → expect item N back to PENDING, run halted, popup shows error "Flow tab closed".
   - Refresh the Flow tab → expect item N back to PENDING, run halted.
   - Navigate the Flow tab to e.g. `https://google.com` → expect item N back to PENDING, run halted, error "Flow tab navigated away".
4. **One-failure-doesn't-stop-queue** — manually break item 3's prompt (e.g. set it to a string Flow rejects), run a 5-prompt batch, confirm items 1, 2, 4, 5 all complete and only item 3 ends FAILED.
5. **Pacing under real load** — run 10 prompts and confirm the adaptive backoff log entries match the configured min/max delay and the cooldown-every-N-prompts pause; verify "Auto-pause queue after 3 consecutive rate-limit signals" actually fires when a rate-limit toast appears.
6. **PR #11 (UX polish)** — separate PR after this one merges, scoped to UX-only improvements (no regression fixes). Out of scope for PR #10.

To execute step 1–5, the next Devin session needs either:
- The user runs the tests manually after merging PR #10, **or**
- The user provides Google account credentials (via `secrets` `gmail` / `pass` and a TOTP secret if 2FA is on) and explicitly authorises burning Flow credits for regression testing.
