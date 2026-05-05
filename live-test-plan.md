# Live test plan for PR #4

PR: https://github.com/tuyulyak-collab/sn-flow-auto/pull/4
Branch: `devin/1777954681-stop-confirm-reset` → base `devin/1777944480-scaffold-sn-flow-auto`

This plan exercises the **only** thing PR #4 changes: the **Stop** control (popup + floating monitor) and the **`stopQueue()`** semantics in `background/service-worker.js`. Tab-lifecycle hardening is also covered. Pause/Resume is verified as NOT changed.

The plan deliberately does NOT cover full end-to-end Flow generation — that requires Google login + burns Flow credits and is out of scope for this PR.

---

## Setup (already done — not part of recording)

- Maximize Chrome window
- `chrome://extensions` → Developer mode ON → Load unpacked → pick `/home/ubuntu/repos/sn-flow-auto` → confirm "SN Flow Auto" entry shows up
- Pin the extension icon to the toolbar
- Open the extension popup once and a `https://labs.google/` tab once so the floating monitor & content scripts inject

---

## Test A — Stop: confirm dialog gates the action (popup)

**Why this is adversarial:** A broken implementation could (1) skip the confirm dialog entirely, (2) show the dialog but proceed even on Cancel, or (3) show the dialog and never proceed even on OK. The two assertions below distinguish all three failure modes from a working impl.

Steps:
1. In the popup, paste 3 prompts and **Add to Queue**. Verify queue table now has 3 rows, all with status badge `pending`.
2. Use popup DevTools Console to mark item #1 `completed` and item #2 `failed` (this simulates a previous run without burning Flow credits):
   ```js
   chrome.storage.local.get('snflow.queue', ({['snflow.queue']: q}) => {
     q[0].status = 'completed'; q[0].filename = 'SN_flow_AAAAA_05052026.png';
     q[1].status = 'failed';    q[1].error = 'simulated';
     chrome.storage.local.set({['snflow.queue']: q});
   });
   ```
3. Verify popup re-renders: row 1 shows `completed` + filename; row 2 shows `failed` + "simulated"; row 3 shows `pending`.
4. Click **Stop**.
   - **PASS criterion:** A native browser `confirm()` dialog appears whose first sentence reads `Stop will halt all processing immediately and reset every queue item back to Pending.`
   - **FAIL** if no dialog appears, or the dialog text differs.
5. Click **Cancel** in the dialog.
   - **PASS criterion:** Popup state is unchanged — row 1 is still `completed` (`SN_flow_AAAAA_05052026.png` visible), row 2 still `failed` (with "simulated"), row 3 still `pending`.
   - **FAIL** if any row's status changed despite Cancel.

## Test B — Stop OK: every item resets, attempts/error/filename cleared

**Why adversarial:** The OLD `stopQueue()` only reset items in active states (`sending` / `generating` / `waiting` / `downloading`). A `completed` or `failed` item would have survived. This test deliberately starts with mixed-status items so that a regression to the old behavior would visibly leave row 1 `completed` and row 2 `failed`.

Steps:
1. Continuing from Test A (rows: completed / failed / pending), click **Stop** again.
2. Click **OK** in the confirm dialog.
3. Verify within ~1 s:
   - **PASS criteria (all four must hold):**
     - Row 1's status badge is `pending` (NOT `completed`); the `SN_flow_AAAAA_05052026.png` filename meta line is gone.
     - Row 2's status badge is `pending` (NOT `failed`); the "simulated" error meta line is gone.
     - Row 3's status badge is `pending`.
     - In popup DevTools Console, run
       ```js
       chrome.storage.local.get(['snflow.queue','snflow.runState'], v => console.log(v));
       ```
       Every item must show `attempts: 0`, no `error` field, no `filename` field, no `mediaUrl` field. The `snflow.runState` must be `{ running: false, paused: false, currentId: null }`.
   - **FAIL** if any item's status is not `pending`, or any of those residual fields remain.

## Test C — Floating monitor Stop: same confirm wording

**Why adversarial:** A regression where only the popup was patched (not the in-page monitor) would let the in-page Stop button silently nuke the queue with no confirm dialog. This catches that.

Steps:
1. Open `https://labs.google/` (matches the extension's host_permissions; no login needed).
2. Click the floating SN circular FAB at the bottom-right → monitor panel opens.
3. Click **Stop** in the monitor's footer.
   - **PASS criterion:** A `confirm()` dialog appears whose first sentence is identical to the popup's: `Stop will halt all processing immediately and reset every queue item back to Pending.`
   - **FAIL** if no dialog appears, or the wording differs.
4. Click **Cancel** in the dialog.
   - **PASS criterion:** No state change — re-open the popup, queue still has whatever was there before.

## Test D — Pause does NOT show confirm and does NOT reset (regression guard)

**Why adversarial:** PR #4's risk is accidentally generalizing the "confirm + reset" pattern to Pause. This test guarantees Pause/Resume remain a soft-pause and never reset state.

Steps:
1. With 3 pending items in the queue, ensure no real Flow tab is open. From popup DevTools console, force a "running" state so Pause is meaningful:
   ```js
   chrome.storage.local.get('snflow.queue', ({['snflow.queue']: q}) => {
     chrome.storage.local.set({
       'snflow.runState': { running: true, paused: false, currentId: q[0].id },
     });
   });
   ```
2. Verify popup pill flips from `idle` to `running`. **Pause** button becomes enabled, **Resume** disabled.
3. Click **Pause**.
   - **PASS criterion (all three must hold):**
     - **No** `confirm()` dialog appears.
     - Popup pill flips to `paused`.
     - In storage, `snflow.runState` is now `{ running: true, paused: true, currentId: <item 1 id> }` and the queue items' statuses are unchanged.

## Test E — Tab lifecycle: in-flight item returns to pending on close (best-effort, no Google login)

**Why adversarial:** Without this lifecycle handler the in-flight item stays stuck in an active state forever after a tab close, requiring manual rescue.

Steps:
1. With 3 pending items, open `https://labs.google/` (matches the URL regex). The content scripts inject; the floating SN FAB appears.
2. Click **Start** in the popup.
3. The run loop will pick `labs.google/` as the Flow tab, set `lastFlowTabId`, then fail to find a Flow prompt input. While item 1 is in `sending` / `generating`, **before** the failure marks it pending via the retry path, close the `labs.google` tab.
4. **PASS criterion:** Within 1 s of closing the tab:
   - In storage, item 1's status is `pending`. Its `error` field reads `Flow tab closed` (or, if the natural retry path raced and won, `prompt input not found` — either is acceptable since both end at `pending`; we will note which fired).
   - `snflow.runState` is `{ running: false, paused: false, currentId: null }`.
   - Items 2, 3 remain `pending`.
   - Popup pill is `idle`. Start button is enabled again.
   - **FAIL** if any item is left in `sending` / `generating` / `waiting` / `downloading`, or if `running: true` persists.
5. **NOTE:** This test has a known race condition (whether the lifecycle handler or the run loop's "prompt input not found" path fires first). Both paths must result in pending — the assertion is the *end state*, not which path got there.

---

## Out of scope (will not be tested in this run)

- **Test 5/6 against a real Flow tab** — requires Google login. Out of scope for this PR.
- **Actual generation end-to-end** — burns Flow credits. Out of scope.
- **Pacing settings driving real delays** — covered by unit-style assertions in `core/pacing.js`; the popup-side persistence half is covered by closing/reopening the popup and re-reading inputs (regression test only).

---

## Recording

One continuous recording covering Tests A → B → C → D → E in that order. Annotate each with `test_start` and assertions per `annotate_recording` rules.
