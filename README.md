# SN Flow Auto

Chrome Extension (Manifest V3) untuk **batch prompt automation** di
[Google Flow](https://labs.google/flow/). Mendukung mode **Image** dan
**Video**, dengan auto-download hasil dan filename yang konsisten:

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
- **Mode selector**: `IMAGE` / `VIDEO` (per batch).
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
3. Pilih mode **Image** atau **Video**.
4. Tulis 1 prompt per baris di textarea, atau klik **Import .txt**.
5. Klik **Add to Queue** → semua prompt masuk antrian dengan status `pending`.
6. Klik **Start**.
7. Tonton progress di popup atau di **floating monitor** di halaman Flow
   (klik tombol bulat `SN` di pojok kanan bawah).
8. Hasil otomatis tersimpan ke folder `Downloads/SN_Flow_Auto/` dengan nama
   `SN_flow_{random5}_{ddmmyyyy}.{ext}`.

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

## Catatan Teknis

- Google Flow's DOM is dynamic / lazy-loaded and may use Shadow DOM. Selectors
  here are intentionally generic and **scored**:
  - prompt input: prefer visible `role=textbox` / `contenteditable` /
    `<textarea>` whose label contains keywords like `prompt`, `describe`,
    `imagine`, `video`, etc.
  - generate button: prefer buttons with text `generate`, `create`, `submit`,
    `send`, `go`, or arrow-right SVG, **closest to the prompt input**.
  - result watcher: snapshots all `<img>`/`<video>` URLs before clicking
    Generate, then waits for new media via `MutationObserver`-style polling
    + `PerformanceObserver` resource events.
  - downloader: searches ancestors of the new media for a button with text
    `download` / `save` / `export` or a download-shaped SVG. Falls back to
    `chrome.downloads.download({ url, filename })` so we always get our own
    filename.
- Bila Google Flow menambah selector spesifik nanti (mis. `data-testid` atau
  attribute baru), tambahkan ke `content/prompt-input.js` /
  `content/generate-button.js` / `content/downloader.js`.

---

## License

MIT (kosong — feel free to copy / adapt).
