# Phase B Plan — Image-to-Video Chain Mode

## Goal

Add a new top-level **Mode** option, **"Chain (Image → Video)"**, that for each prompt:

1. generates an image with the chosen aspect ratio + count, then
2. attaches the generated image as input to a video generation, then
3. generates a video using a video model (Veo) with the same prompt.

The user types prompts once; each prompt produces 1 image + 1 video.

## User-facing UX

### Popup

- Mode dropdown grows from `Image | Video` to `Image | Video | Chain (Image → Video)`.
- When Mode = Chain, a new "Video step" panel appears with:
  - Video aspect ratio (defaults to image aspect ratio; can be different — e.g. image 16:9, video 9:16).
  - Video model: dropdown with Flow's available video models (start with auto-detect — read whatever video model Flow currently has selected; expose explicit override later).
  - Video prompt source: `Same as image prompt` (default) | `Custom suffix` (textarea adds a sentence to the image prompt to steer video, e.g. "with subtle camera dolly-in").
- Add to Queue: each line in the prompts textarea creates **two queue items**:
  - image step (mode=`image`, chainStep=`image`, parentId=null)
  - video step (mode=`video`, chainStep=`video`, parentId=imageStep.id, status=`pending` but skipped by the run loop until parent completes successfully)
- Queue table renders the video step indented under its parent image step with a `↳` chain icon, so users see the relationship at a glance.

### Floating monitor

- No structural changes — monitor still shows current item progress and status. Add a small chain icon next to chained items so the user knows what they're looking at.

## Storage schema additions

`core/storage.js` `QueueItem` extended with three optional fields:

```js
{
  // existing: id, prompt, mode, status, attempts, error, filename, mediaUrl, ...
  parentId?: string,        // id of the image-step this video item depends on
  chainStep?: "image" | "video",
  inputMediaUrl?: string,   // populated by run loop when chained video step starts
}
```

`DEFAULT_SETTINGS` extended:

```js
{
  // existing fields...
  chainEnabled: false,
  chainVideoAspectRatio: "16:9",
  chainVideoPromptMode: "same",  // "same" | "suffix"
  chainVideoPromptSuffix: "",
  chainVideoModel: "auto",        // "auto" | "veo" | "veo-2" — best-effort
}
```

## Service worker changes

`background/service-worker.js` run loop:

1. `Queue.nextPending` now skips video items whose parent image item is not completed.
2. Before running an item, if `chainStep === "video"` and `parentId` is set, look up the parent's `mediaUrl` and put it on the item as `inputMediaUrl`. If parent is missing or failed, mark the video item as `skipped` with reason `"parent image step did not complete"`.
3. The dispatch message `SN_FLOW_RUN_ITEM` already carries `item` + `settings` — we add `inputMediaUrl` on the item so the content script can attach it.
4. Tab-lifecycle revert (PR #4 / #5): unchanged. If the tab closes mid-video-step, only that item flips back to pending; the parent image step stays completed.

## Content script changes

Two new pieces:

- `content/flow-add-media.js` — programmatic image attach. Approaches in order of preference:
  1. **Click "Add Media" button** (devinid=7 on labs.google), which opens a Drive / upload picker. From a `mediaUrl` we already have, fetch the image as a Blob, then dispatch a synthetic `paste` event with a DataTransfer carrying the file into Flow's prompt area. Flow accepts paste-uploads natively today.
  2. Fallback: synthesize a `drop` event on the prompt input with the same DataTransfer.
  3. Fallback: simulate file selection via the hidden `<input type="file">` that the upload picker creates.
- `content/flow-settings.js` — add `applySettings({ ..., model })` so we can flip model selection (Veo) when chainStep=video. Read available model tabs in the settings dropdown's first tablist (model picker is a separate tablist from mode/ratio/count on Flow's UI).

`content/content.js` (the run-item dispatcher):
- If `item.inputMediaUrl` is set, call `attachInputImage(item.inputMediaUrl)` BEFORE typing the prompt, then continue with normal flow (typing prompt → click Generate → result-watcher → downloader).

## Risk / open questions

- **Output count > 1 on image step**: today Flow can produce x2/x3/x4 image variants from one prompt. Spec calls for one chained video per prompt. Default decision: **chain video uses the FIRST image variant**. We can revisit if user wants 2 videos for 2 images.
- **Video runtime is much longer than image** (~30 s vs ~2-4 min). Pacing already handles per-item delay, but the `waitTimeoutMs` default (5 min) might be too short for some Veo runs. Solution: bump default `waitTimeoutMs` for video items to 8 min.
- **Veo availability**: Veo is gated by Flow account tier. If the model picker doesn't expose Veo, video step fails with a clear `"video model not available"` error and the parent image step stays completed.
- **Live testing burns Flow credits.** Image gen ≈ 0 credits on Nano Banana 2 in Flow's free tier today; Veo costs significant credits per generation. We will validate the plumbing using the existing simulated-state console fixtures (no real generation), then ask user to do one real chain run as a final smoke test.

## Implementation order (small, mergeable steps)

1. **PR #6 (this plan)** — schema additions + popup UI + storage migration. No content-script changes; chain mode visible in UI but a chained video item just sits in pending.
2. **PR #7** — content script `attachInputImage` + Veo model picking. Validate end-to-end by user clicking Start on a chain-mode queue.
3. **PR #8** — polish: indented queue rendering, retry-only-video-step button, custom video-prompt suffix.

For this session, scope = **PR #6 only** (schema + UI + queue creation logic). Live chain testing waits for PR #7 + a user-driven real run.

## File changes for PR #6

- `core/storage.js` — extend defaults + QueueItem doc comment.
- `core/queue-manager.js` — `addPrompts` grows a `mode === "chain"` branch that creates 2 linked items per prompt; `nextPending` gates video items on parent completion.
- `popup/popup.html` — add Chain mode option + collapsible "Video step" panel.
- `popup/popup.css` — style for nested rows and chain icon.
- `popup/popup.js` — wire new settings, render indentation in queue table, persist new settings.
- `background/service-worker.js` — propagate `inputMediaUrl` from parent to chained video item just before dispatch.
- `content/content.js` — accept `inputMediaUrl` and (no-op for now if not present); will gain `attachInputImage` in PR #7.

Estimated diff: ~250–350 LoC.
