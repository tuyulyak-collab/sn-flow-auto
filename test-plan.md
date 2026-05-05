# SN Flow Auto — Test Plan

Manual + scripted tests for the popup, the floating monitor, the queue runner,
and the tab-lifecycle/anti-bot pacing layers. The tests are designed so the
first 4 can be run **without burning Flow credits** (they exercise UI + state
transitions only). Tests 5–8 require a logged-in `https://labs.google/flow/`
tab.

---

## Setup (once per session)

1. Generate icons (idempotent): `python3 tools/generate_icons.py`
2. Open `chrome://extensions` → enable Developer mode → Load unpacked → pick
   the repo root.
3. Pin the extension. Open https://labs.google/flow/ and login (only needed
   for tests 5–8).
4. Open Chrome DevTools on the popup (right-click the popup icon → Inspect)
   and on the Flow tab (F12) — keep both Console tabs visible during testing.

---

## Test 1 — Add to Queue, Mode/Aspect/Output persist

**Goal:** the popup writes items into `chrome.storage.local` correctly and
the per-batch settings round-trip.

1. Open popup. Set Mode = `image`, Aspect = `1:1`, Output = `x2`.
2. In the prompts textarea paste:
   ```
   a tiny astronaut planting flowers on the moon
   a cinematic sunrise over Bali rice terraces
   neon koi pond at midnight
   ```
3. Click **Add to Queue**.
4. **Expected:**
   - Queue table shows 3 rows with status `pending`.
   - Mode column reads `image · 1:1 · x2`.
   - Closing + reopening the popup keeps the queue.
   - In DevTools console of the popup, run
     `chrome.storage.local.get('snflow.queue', console.log)` — verify the 3
     items are persisted and have `status: "pending"`.

**Pass criteria:** all 3 rows persisted with the chosen mode/ratio/count.

---

## Test 2 — Start with no Flow tab open (graceful failure)

**Goal:** Start without a Flow tab does not silently freeze.

1. Make sure no `labs.google/flow` tab is open.
2. Click **Start** in the popup.
3. **Expected:**
   - First item gets status `failed` with error
     `Open https://labs.google/flow first`.
   - Run state goes back to idle (Start re-enabled, Pause/Resume/Stop
     disabled).
   - Pacer state in the popup reads `0 done · …` (no streak yet).

**Pass criteria:** failure surfaces in the row and the run cleanly stops.

---

## Test 3 — Stop = halt + full reset (confirmation required)

**Goal:** Stop matches the contract:
> When user clicks Stop, show confirmation. If user confirms, halt all
> processing immediately, reset every queue item back to Pending, clear
> current item, set running=false and paused=false, reset pacer state.
> Next Start must begin again from item 1.

1. Add 3 prompts to the queue (any mode).
2. Manually mutate the queue from the popup DevTools console so we can
   verify "every item → pending" without waiting for Flow:
   ```js
   chrome.storage.local.get('snflow.queue', ({['snflow.queue']: q}) => {
     q[0].status = 'completed'; q[0].filename = 'SN_flow_AAAAA_05052026.png';
     q[1].status = 'failed';    q[1].error = 'simulated';
     q[2].status = 'pending';
     chrome.storage.local.set({['snflow.queue']: q});
   });
   ```
3. Also set a fake run state + pacer streak so we can verify reset:
   ```js
   chrome.storage.local.set({
     'snflow.runState': { running: true, paused: false, currentId: q[2].id }
   });
   ```
   *(or simply Start once with a live Flow tab and click Stop while item 2
   is in flight — both work)*
4. Click **Stop** in the popup.
5. **Expected:**
   - A `confirm()` dialog appears with text starting
     `Stop will halt all processing immediately and reset every queue item
     back to Pending.`
   - Click **Cancel** → nothing changes (running stays true, items keep
     their current status). **Verify in console.**
   - Click **Stop** again → confirm and accept.
   - All 3 items are `pending`. `filename` / `error` are cleared on every
     item. `attempts` reset to 0.
   - Run state: `{ running: false, paused: false, currentId: null }`.
   - Click **Start** → run begins again from item 1 (index 0).
6. **Floating monitor variant:** repeat steps 1–5 but click Stop in the
   draggable monitor overlay on the Flow tab — same confirmation +
   reset behavior.

**Pass criteria:** Cancel preserves state; OK fully resets queue to all
pending and clears run/pacer state; next Start visibly begins from item 1.

---

## Test 4 — Pause / Resume preserves state

**Goal:** Pause/Resume is **not** a reset — current item, queue progress,
and pacer streak are preserved.

1. Queue 3 prompts. Start. Wait until item 1 transitions to `sending` /
   `generating`.
2. Click **Pause** (no confirm dialog should appear).
3. **Expected:**
   - Run state: `{ running: true, paused: true, currentId: <id of item 1> }`.
   - Item 1 status remains whatever it was at pause time (e.g. `generating`).
   - Items 2 and 3 stay `pending`.
   - Pacer's `total` / `errorStreak` / `sinceCooldown` are unchanged.
4. Click **Resume**.
5. **Expected:**
   - Run continues from the same item 1; does NOT restart from beginning.
   - When item 1 finishes, it advances to item 2 (not item 1 again).
6. Repeat with the floating monitor's Pause/Resume — same behavior, no
   confirmation dialog on Pause/Resume.

**Pass criteria:** queue state survives the pause; resume continues from
exactly where it left off.

---

## Test 5 — Tab lifecycle: closing the Flow tab mid-run

**Goal:** if the Flow tab is closed while an item is in flight, that item
returns to Pending and the run stops cleanly.

1. With a Flow tab open + logged in, queue 2 prompts and click **Start**.
2. While item 1 is `sending` / `generating` / `waiting`, close the Flow
   tab (Ctrl+W on the Flow tab).
3. **Expected:**
   - Within ~1 s, item 1's status flips back to `pending` with
     `error: "Flow tab closed"`.
   - Run state: `{ running: false, paused: false, currentId: null }`.
   - Service worker log line:
     `WARN: Flow tab closed mid-run`.
4. Open a new Flow tab, login again, click **Start** → run picks up from
   item 1 (which is once again pending) and proceeds to item 2.

**Pass criteria:** no item is silently lost; run stops; popup status reads
`idle`.

---

## Test 6 — Tab lifecycle: navigating the Flow tab away mid-run

**Goal:** same contract as Test 5 but for navigation away.

1. Queue 2 prompts. Start. While item 1 is in flight, in the Flow tab
   address bar, navigate to `https://example.com` and Enter.
2. **Expected:**
   - Item 1 reverts to `pending` with `error: "Flow tab navigated away"`.
   - Run state: `{ running: false, paused: false, currentId: null }`.
   - Service worker log: `WARN: Flow tab navigated away mid-run`.
3. Navigate the same tab back to `https://labs.google/flow/` and Start —
   item 1 runs again.

**Pass criteria:** in-flight item returns to Pending on navigation.

---

## Test 7 — Pacing settings persist + drive the run loop

**Goal:** verify the new anti-bot pacing card writes to settings and the
run loop honours the values.

1. In the popup's "Pacing & anti-bot" card set:
   - Min delay = 5 (s), Max delay = 8 (s)
   - Cooldown every = 2 prompts, Cooldown duration = 12 (s)
   - Adaptive backoff = on, Auto-pause on streak = on
   - Aggressive mode = off
2. Close + reopen popup. **Expected:** all 6 values persist.
3. Queue 3 prompts. Start. Watch the popup `Log` panel.
4. **Expected:**
   - Between item 1 and item 2: log line `pacing next { delayMs: ~5000–8000 }`.
   - Between item 2 and item 3: cooldown engaged → `delayMs ≥ 12000`.
   - Pacer-state line ("3 done · …") increments after each item.
5. Toggle Aggressive mode → confirm dialog fires → re-Start → all
   `delayMs` values should be 0.

**Pass criteria:** settings persist; observed delays match the chosen
window; cooldown injection visible at item 2→3; aggressive collapses to 0.

---

## Test 8 — Floating monitor: visibility, draggability, controls

**Goal:** the in-page monitor is usable on the Flow tab.

1. Open `https://labs.google/flow/...` (logged in).
2. **Expected:** a circular `SN` FAB appears in the bottom-right corner.
3. Click the FAB → monitor panel opens with sections: Status / Progress
   bar / Current / Prompt / Log / Pause / Resume / Stop.
4. Drag the panel by its header — it should follow the cursor and stay
   inside the viewport.
5. Click the `—` minimize button → panel collapses to header only; click
   again → expands.
6. Queue + Start from the popup, then watch the monitor:
   - Pill text flips `idle → running`.
   - Progress bar fills as items complete.
   - During a rate-limit streak, the pill turns red and shows
     `cooling × N`.
7. Click monitor's **Pause** → no confirm dialog → run pauses.
8. Click monitor's **Stop** → confirm dialog appears (same wording as
   popup) → confirm → queue resets to all pending exactly like Test 3.

**Pass criteria:** monitor is fully functional on the Flow tab; Stop
confirmation matches the popup behavior.

---

## Bug log (filled during the run)

| Date       | Test | Bug                          | Status / Fix                |
|------------|------|------------------------------|-----------------------------|
| 2026-05-05 | 3    | Stop did not show a confirm  | Fixed in popup.js + monitor |
| 2026-05-05 | 3    | Stop only reset active items, not every item | Fixed in service-worker.stopQueue() |
| 2026-05-05 | 5,6  | Tab lifecycle handler did not defensively reset other active-status items | Hardened via revertInFlightAndStop() helper |

---

## Known limitations

- Tests 5–8 require a real Google Flow login. Tests 1–4 + 7 (UI parts) can
  be run with `chrome.storage` mutation + Pacing & anti-bot settings only,
  without burning Flow credits.
- Generation tests (actual Flow output) burn credits — defer until the user
  explicitly approves a credit-consuming run.
- Image-to-Video Chain mode is intentionally **not** part of this PR; it
  will land in a separate follow-up.
