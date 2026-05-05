# SN Flow Auto

Chrome Extension (Manifest V3) untuk **batch prompt automation** di
[Google Flow](https://labs.google/fx/tools/flow). Mendukung mode **Image**,
**Video**, dan **Chain (Image → Video)**, dengan auto-download hasil dan
filename yang konsisten:

```
SN_flow_{random5}_{ddmmyyyy}.{ext}
e.g. SN_flow_A7K2Q_05052026.mp4
```

> SN Flow Auto bekerja dengan akun Google kamu yang sudah login di Chrome.
> Extension ini **tidak bypass limit / quota** dan tidak memakai API ilegal —
> semua otomasi dilakukan lewat UI Google Flow secara stabil.

---

## Fitur Utama

- **Manifest V3** — service worker + content scripts.
- **Manual prompt textarea** + **Import .txt** (1 baris = 1 prompt).
- **Mode selector**: `IMAGE` / `VIDEO` / `CHAIN (Image → Video)` (per batch).
- **Chain mode**: generate image first, then auto-feed it to Veo for video gen.
  Configurable strategy (first image only / all variants), video prompt source
  (same / suffix / custom template with `{prompt}` placeholder), run order
  (interleave / batch), and video model picker (Auto / Veo / Veo 2).
- **Aspect ratio**: `16:9 / 4:3 / 1:1 / 3:4 / 9:16` (per batch).
- **Output count**: `x1 / x2 / x3 / x4` (per batch — Flow generates N tiles per
  prompt, semua tiles auto-download).
- **Queue system** dengan status:
  `Pending`, `Sending Prompt`, `Generating`, `Waiting Result`, `Downloading`,
  `Completed`, `Failed`, `Skipped`.
- **Controls**: Start, Pause, Resume, Stop, Retry Failed, Clear Queue.
- **Auto-download** hasil image atau video (klik tombol download asli Google
  Flow kalau ada, atau fallback ke media URL via `chrome.downloads`).
- **Robust DOM detection** — fallback selectors untuk prompt input, tombol
  generate, result cards, tombol download. Walks open Shadow DOM.
- **Retry logic** + log readable (max 200 line di `chrome.storage.local`).
- **Floating monitor** di halaman Flow: draggable, minimizable, ada
  pause/resume/stop, progress bar real-time.
- **Persistent state** via `chrome.storage.local` — queue + settings tetap
  setelah popup ditutup atau service worker dibangun ulang.
- **Colorful gradient SaaS UI**:
  `linear-gradient(135deg, #e1eec3 0%, #f05053 100%)` untuk branding,
  primary buttons, monitor accent, dan progress highlights.

---

## Install (Load Unpacked)

1. Clone / download repo ini, lalu generate ikon (sekali saja):
   ```bash
   python3 tools/generate_icons.py
   ```
2. Buka Chrome → `chrome://extensions`.
3. Aktifkan **Developer mode** (kanan atas).
4. Klik **Load unpacked** → pilih folder repo ini.
5. Pin extension **SN Flow Auto** dari ikon puzzle di toolbar.

---

## Cara Pakai

1. Buka https://labs.google/flow/ dan login (kalau belum).
2. Klik ikon SN Flow Auto di toolbar Chrome → popup terbuka.
3. Pilih mode **Image**, **Video**, atau **Chain (Image → Video)**.
4. Tulis 1 prompt per baris di textarea, atau klik **Import .txt**.
5. Klik **Add to Queue** → semua prompt masuk antrian dengan status `pending`.
6. Klik **Start**.
7. Tonton progress di popup atau di **floating monitor** di halaman Flow
   (klik tombol bulat `SN` di pojok kanan bawah).
8. Hasil otomatis tersimpan ke folder `Downloads/SN_Flow_Auto/` dengan nama
   `SN_flow_{random5}_{ddmmyyyy}.{ext}`.

### Manual Prompts

Ketik 1 prompt per baris di textarea popup. Baris kosong akan diabaikan.

### Import TXT

Klik **Import .txt** dan pilih file `.txt` — setiap baris non-kosong menjadi
1 item di queue. Mendukung file besar (ratusan prompt).

### Image Mode

Generate gambar dari setiap prompt. Aspect ratio dan output count diatur
di popup (x1–x4). Semua tile hasil auto-download.

### Video Mode

Generate video (Veo) dari setiap prompt. Timeout per item 5 menit
(configurable). Flow mungkin generate 1 tile saja walau setting x2/x3/x4.

### Chain (Image → Video) Mode

Untuk setiap prompt, extension akan:
1. Generate **image** dulu (pakai model Flow yang aktif / Nano Banana).
2. Attach image sebagai input ke **video step** (Veo).
3. Generate video dari image + prompt.

Configurasi chain di popup:
- **Image → Video**: *Use first image only* vs *Chain every image variant*
- **Video prompt**: *Same as image prompt*, *+ suffix*, atau *Custom template*
  (pakai `{prompt}` placeholder)
- **Run order**: *Per prompt* (image1→video1→image2→…) vs *Batch*
  (semua image dulu, baru semua video)
- **Video model**: Auto / Veo / Veo 2

---

## Arsitektur Singkat

```
manifest.json                        — MV3 manifest
popup/                               — popup UI (gradient SaaS)
  popup.html / popup.css / popup.js
content/                             — content scripts running on Google Flow
  flow-detector.js                   — deep DOM walking (incl. Shadow DOM)
  prompt-input.js                    — find + fill the prompt textarea
  generate-button.js                 — find + click Generate / Create
  result-watcher.js                  — wait for new <img>/<video> after generate
  downloader.js                      — click native Download or fallback to URL
  floating-monitor.css/.js           — draggable in-page monitor panel
  content.js                         — message bridge with service worker
background/
  service-worker.js                  — orchestrator + chrome.downloads
core/                                — shared between popup, SW, content scripts
  logger.js retry.js filename-template.js
  storage.js queue-manager.js prompt-parser.js
icons/                               — generated app icons (16/48/128)
tools/generate_icons.py              — pure-stdlib icon generator
```

### Flow

```
popup.js  ──► chrome.runtime.sendMessage SN_FLOW_CMD:START ──► service-worker
                                                                   │
                              ┌──────────────────────────────┐    │
                              │ for each pending item:       │◄───┘
                              │  - find Flow tab             │
                              │  - ensure content scripts    │
                              │  - sendMessage RUN_ITEM      │
                              │      (prompt+mode+settings)  │
                              └──────────────────────────────┘
                                       │
                                       ▼
                              content.js → set prompt → click Generate
                                        → watch DOM/PerformanceObserver
                                        → click Download or chrome.downloads
                                        → reportStatus along the way
```

State + queue persisted in `chrome.storage.local` — both popup and the floating
monitor read it via `chrome.storage.onChanged`.

---

## Acceptance Checklist

- [x] **Process at least 10 prompts from textarea** — queue is unbounded.
- [x] **Import prompts from TXT** — `Import .txt` in popup.
- [x] **Sequential processing** — service worker run loop is single-flight.
- [x] **Auto-download image results** — `chrome.downloads` with custom filename.
- [x] **Auto-download video results** — same path, mp4/webm autodetected.
- [x] **Filename format** — `SN_flow_{random5}_{ddmmyyyy}.{ext}` (ddmmyyyy uses
      local time).
- [x] **Floating monitor real-time updates** — subscribes to
      `chrome.storage.onChanged`.
- [x] **Pause / Resume / Stop** — both popup and floating monitor.
- [x] **Retry failed** — `Retry Failed` resets failed → pending; per-item
      retry button in the queue table.
- [x] **Gradient SaaS UI** — `#e1eec3 → #f05053`, no dark/blue dominance.

---

## Failure Recovery

- **Prompt input not found**: retries up to 3x with exponential backoff before
  marking the item failed.
- **Generate button not found**: retries up to 3x.
- **Result detection timeout**: only the current item fails, not the whole
  queue. Other pending items continue.
- **Download failed**: retries download up to 2x per tile.
- **Flow UI changed**: readable error messages ("Could not find prompt
  input — Flow UI may have changed or not fully loaded").
- **Failed items**: retryable via per-row ⟳ button or bulk **Retry Failed**.

## Queue Persistence

- Queue stored in `chrome.storage.local` — persists when popup closes.
- Floating monitor reads from storage via `chrome.storage.onChanged`.
- If browser/extension reloads, in-flight items revert to `Pending` (not stuck
  `Running`). Run state resets to `Idle`.
- Tab close / navigate away: in-flight item reverts to `Pending`, queue pauses.

---

## Known Limitations

1. **No official Flow API** — all automation via DOM interaction. Flow UI
   updates may break selectors; heuristic fallbacks mitigate this.
2. **Rate limiting** — Flow rate-limits aggressive automation. Default pacing
   (30–60s between prompts) helps. Aggressive mode (0 delay) is for testing
   only.
3. **Video gen is slow** — Veo takes 1–3 minutes per prompt. Chain mode video
   steps have an 8-minute timeout.
4. **Filename random5** uses a 30-character alphabet (A–Z + 2–9, excluding
   ambiguous 0/O/1/I) for readability. Still 5 chars, ~24.3M combinations.
5. **Single tab** — extension operates on 1 Flow tab at a time.
6. **No batch progress from Flow** — if output count x4 but Flow only
   generates 2 tiles (e.g. video mode), extension downloads what's available.

---

## Troubleshooting

| Problem | Fix |
| --- | --- |
| "Open https://labs.google/flow first" | Open a Flow tab and make sure you're logged in. |
| Prompt input not found | Refresh the Flow tab. Make sure you're on a project page (not the landing page). |
| Generate button not found | Check if Flow's UI changed. Try refreshing. |
| Download folder empty | Check `Downloads/SN_Flow_Auto/`. Chrome may block downloads — check `chrome://downloads`. |
| Queue stuck on Running | Close popup, reopen. If stuck, go to `chrome://extensions` → reload the extension. |
| Rate limit / blocked | Increase min/max delay in Pacing settings. Enable "Pause on rate limit". |
| Chain video has no input image | Make sure the parent image completed successfully. Check that `flow-add-media.js` is loaded (visible in content scripts). |

---

## Catatan Teknis — DOM Contract Google Flow

DOM contract yang sudah diobservasi langsung di
`https://labs.google/fx/tools/flow` (May 2026) dan jadi dasar selector
extension ini:

| Element | Selector | Notes |
| --- | --- | --- |
| Prompt input | `[data-slate-editor="true"]` (Slate.js, role=textbox, contenteditable) | Pakai `document.execCommand("insertText")` supaya beforeinput observer Slate menerima text. |
| Generate (Create) button | `<button type="submit">` di dalam `<form>`, berisi `<i>arrow_forward</i>` (Google Symbols), label visible-hidden "Create" | Sudah scored juga via keyword `create/generate/send/go`. |
| Settings dropdown trigger (chip kiri tombol Send) | `<button aria-haspopup="menu">` yang labelnya berisi nama model + icon `crop_*` + `xN` | Klik buka Radix popper berisi 3 tablist (mode/ratio/count). |
| Mode tab | `[role="tab"][id$="-trigger-IMAGE"]`, `…-VIDEO` | `aria-selected="true"` = aktif. |
| Aspect ratio tab | `[role="tab"][id$="-trigger-LANDSCAPE"]` (16:9), `…-LANDSCAPE_4_3` (4:3), `…-SQUARE` (1:1), `…-PORTRAIT_3_4` (3:4), `…-PORTRAIT` (9:16) | Beberapa option bisa disabled untuk mode tertentu (misal video kadang menolak 1:1). |
| Output count tab | `[role="tab"][id$="-trigger-1"|"-2"|"-3"|"-4"]` | Label text `x1 / x2 / x3 / x4`. |
| Tile result | `<a class="sc-3ab8616e-…"><img alt="Generated image" src="…/media.getMediaUrlRedirect?name=<UUID>" /></a>` | Untuk video: `<video src="…/media.getMediaUrlRedirect?name=<UUID>">`. URL redirect endpoint sama untuk image & video. |
| Tile hover toolbar (3 tombol) | Buttons overlay tile berisi icon `favorite`, `redo`, `more_vert` | Muncul setelah hover; extension dispatch synthetic `mouseenter/over/move`. |
| Native Download | Klik `more_vert` → Radix menu `[role="menu"][data-state="open"]` → menuitem dengan `<i>download</i>` icon | Extension klik menuitem ini DAN tetap fire `chrome.downloads.download()` URL-based supaya nama file tetap `SN_flow_*`. |

Strategi extension: pakai selector spesifik di atas sebagai **fast path**,
fallback ke scoring heuristic (keyword + size + position + proximity ke
prompt input) supaya tetap jalan kalau Google Flow refactor minor.

Semua content script jalan di `document_idle` di
`labs.google/* | flow.google/* | aitestkitchen.withgoogle.com/*` dan walk
open Shadow DOM via `SNFlowDom.queryAllDeep` (lihat
`content/flow-detector.js`).

---

## Arsitektur Tambahan (Phase B: Chain Mode)

```
content/flow-add-media.js   — attach image to Flow (4-strategy fallback:
                               fileInput → addMediaClick → paste → drop)
content/flow-settings.js    — applyModel() for Veo/Veo-2 picker
background/service-worker.js — SN_FLOW_FETCH_BLOB CORS fallback for image fetch
core/pacing.js              — adaptive anti-bot delay + cooldown
background/network-sniffer.js — webRequest-based rate-limit detection
content/dom-error-watcher.js  — DOM-based rate-limit toast detection
```

---

## License

MIT (kosong — feel free to copy / adapt).
