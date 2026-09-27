# Cinema Canvas — vault media grid for Obsidian

Turn the sample plugin into a **media canvas**: scans the vault for images + short
clips, lays them out as an automated zoomable grid where **each folder is a group**,
with lightbox / navigation / zoom controls.

## Decisions (locked)

- **Not** built on Obsidian's core Canvas plugin — it has no public extension API and
  its `.canvas` file format is node-per-file, not a live view. Instead: a custom
  `ItemView` implementing the same interaction model (infinite pan/zoom world,
  groups, fit/zoom-to-selection). Reads like Canvas, but is driven by the live
  file index rather than a stored document.
- Markdown is not involved anywhere. Nothing is written to the vault.
- Item cell is a **fixed box** (`itemHeight` × aspect ratio); media is
  `object-fit: contain` inside it, so the grid stays regular regardless of the
  real media dimensions. Default `itemHeight = 720` ("720p").

## Architecture

```
src/
  main.ts              plugin lifecycle only (view registration, commands, ribbon)
  settings.ts          settings interface, defaults, settings tab
  types.ts             MediaItem / MediaGroup / Rect / Viewport
  media/
    extensions.ts      image + video extension sets
    scope.ts           parse "src/, archive/" -> folder matcher (recursive)
    index.ts           MediaIndex: build from vault, incremental reconcile, change events
  view/
    canvas-view.ts     ItemView: world transform, virtualized render, input, controls
    layout.ts          pure layout: groups -> packed rects
    lightbox.ts        fullscreen overlay: prev/next, native fullscreen, video controls
  utils/
    debounce.ts
```

## Tasks

### 1. Foundations
- [x] `types.ts` — `MediaItem`, `MediaGroup`, `Rect`, `LayoutResult`
- [x] `media/extensions.ts` — images (png jpg jpeg gif webp avif bmp svg tif tiff heic)
      + video (mp4 mov webm mkv m4v avi) ; user-overridable via settings
- [x] `media/scope.ts` — parse comma list, normalize (`src/` -> `src`), empty = whole
      vault, recursive prefix match, case-insensitive, ignores `.obsidian`

### 2. Index + reconciliation
- [x] `MediaIndex.build()` from `app.vault.getFiles()` (Obsidian's cache — no disk walk)
- [x] Incremental vault events: `create` / `delete` / `rename` / `modify`
      -> patch index, mark dirty, **debounced 150 ms** -> emit `change`
      (covers drag-and-drop into the vault and external file changes while open)
- [x] Rebuild on settings change (folders / extensions / sort)
- [x] Sort: name | modified | created, asc/desc; group = parent folder path
- [x] Manual "Rescan vault" command + toolbar button

### 3. Layout (`layout.ts`, pure/testable)
- [x] Per group: columns = clamp(ceil(sqrt(n)), 1, maxColumns)
- [x] Groups flow left→right and wrap into a target world width (mosaic packing)
- [x] Emits absolute world rects for every group + item; stable across re-layout

### 4. Canvas view
- [x] `ItemView` (`cinema-canvas`), viewport > world with `translate()/scale()`
- [x] Pan: drag background, middle-drag, wheel (shift = horizontal), touch drag
- [x] Zoom: ctrl/cmd+wheel + pinch, anchored at cursor; clamp 0.02–4
- [x] **Virtualization**: only build DOM for items intersecting viewport + margin
- [x] Items: `<img>` lazily via `vault.getResourcePath`; video as `<video muted
      playsinline preload=metadata>` poster frame, hover-to-play (optional)
- [x] Selection highlight; group headers with folder name + count

### 5. Controls
- [x] Toolbar: fit all, zoom in/out, zoom to current, zoom to parent, fullscreen,
      prev/next, rescan
- [x] Keys (scoped to view): `←/→` prev/next, `↑/↓` row, `Home/End`,
      `f` fullscreen, `z` zoom to current, `Shift+Z` zoom to parent,
      `0` fit all, `+/-` zoom, `Esc` close lightbox
- [x] Lightbox overlay: fit-to-screen media, prev/next, caption, native
      `requestFullscreen` toggle, video gets real controls
- [x] Command palette entries for the same actions

### 6. Settings tab
- [x] Folders (comma separated, empty = whole vault)
- [x] Item height preset (360/480/720/1080/1440/2160) + custom
- [x] Aspect ratio (16:9 / 4:3 / 1:1 / 9:16 / 3:2 / 2.39:1)
- [x] Gap, max columns per group, show filenames, include images/videos,
      extra extensions, sort field + direction, hover-play video, open on startup

### 7. Wiring / polish
- [x] `main.ts` slim: load settings, register view, ribbon, commands
- [x] `styles.css` for the whole view (theme-variable driven, light + dark)
- [x] `manifest.json` id/name/description updated
- [x] `npm run build` (tsc + esbuild) and `npm run lint` clean

## Status

All tasks above are implemented. `npm run build` (tsc + esbuild) and
`npm run lint` are clean — lint reports 5 stylistic warnings only:
4 sentence-case hints on placeholder strings that are literal path/extension
examples (`src/, archive/`, `dng, cr2`, `mts, mxf`, `custom px`), and one
suggestion to adopt the 1.13 declarative settings API.

### Not done / follow-ups
- No automated tests; `layout.ts` is pure and is the obvious first target.
- Video cells below 120px on screen render as stubs rather than decoders.
  A real thumbnail cache (first frame -> blob) would look better when zoomed out.
- Group packing is a single shelf pass; very uneven folder sizes leave gaps.

---

# v2 — thumbnail pipeline (performance)

## Why it lags today

- Every visible cell gets `<img src=app://…>` at **full resolution**. A 6000×4000
  still decodes to ~96 MB of RGBA. 100 of them is ~9 GB of bitmap; the browser
  thrashes and drops frames long before that.
- Every visible clip mounts a real `<video>` decoder. Chromium caps concurrent
  decoders, so beyond ~20 they queue and stall the compositor.
- Every index change unmounts and rebuilds all cells, re-triggering decode.
- `refreshVisible` scans the full item array per frame.

## Fix

Disk-cached, tiered thumbnails plus real cell recycling.

### Tasks

- [x] `media/thumbnails.ts` — `ThumbnailStore`
  - Tiers **256 / 640 / 1440** px wide, WebP q≈0.8, written to
    `<plugin dir>/thumbs/<hash>_<mtime>_<tier>.webp`
  - Key = cyrb53(path) + mtime, so a re-export invalidates itself
  - Directory listed **once** on init into an in-memory `Set`, so a cache hit
    costs no disk I/O
  - Images: `vault.readBinary` -> `createImageBitmap` -> draw to
    (Offscreen)Canvas -> `convertToBlob`; bitmap closed immediately, so peak
    memory is one image, not N
  - Clips: detached `<video>`, seek to ~10%, `drawImage` the frame. This is what
    removes the decoder-per-cell problem — the grid shows a still.
  - Priority queue, **concurrency 2**, priority = distance from viewport centre;
    requests cancel when a cell scrolls away
  - `failed` set so a HEIC/undecodable file is attempted once, not every frame
  - SVG bypasses the cache (vector, already cheap)
- [x] Progressive upgrade: if the wanted tier is cold but a smaller one is warm,
      show the smaller immediately and swap when the better one lands
- [x] Above the top tier (i.e. zoomed right in) use the original file
- [x] `view/media-cell.ts` — a `MediaCell` class owning one element, its pending
      thumbnail request, and its hover-preview video. Replaces `media-node.ts`.
      Hover creates the only live `<video>` on the canvas.
- [x] `view/spatial-index.ts` — uniform bucket grid so visibility is a local
      query instead of a full scan
- [x] `canvas-view.ts` — recycle cells keyed by path across relayouts (no more
      unmount-all), mount at most ~40 new cells per frame, nearest-first
- [x] Settings: use thumbnails on/off, thumbnail quality
- [x] Commands: clear thumbnail cache; prune orphans in the background
- [x] `contain: layout paint` on cells; cheaper selection ring
- [x] Progress readout in the status strip while the queue drains

## v2 status

Implemented and building clean. Measured expectations, not measurements — I have
not profiled this inside Obsidian:

- grid never touches an original file below ~1440 device px per cell;
- at most **one** `<video>` element exists at a time (the hovered cell);
- at most **600** cells mounted, built **40 per frame**;
- thumbnail generation is **2 at a time**, nearest-to-centre first, and a cell
  that scrolls off cancels its own queued job.

First open of a cold vault still costs one decode per file to build the cache —
that runs in the background with the queue depth shown in the status strip, and
is a one-off. Afterwards the cache is keyed by path+size+mtime, so it survives
restarts and invalidates itself when you re-export a shot.

### Remaining follow-ups
- No automated tests; `layout.ts` and `scope.ts` are the pure, obvious targets.
- HEIC/HEIF cannot be decoded by Chromium, so those files show a stub. Would
  need a wasm decoder.
- Thumbnail generation is main-thread. A Web Worker with `createImageBitmap`
  would keep the UI perfectly smooth during the initial cache build; today it is
  merely throttled.

---

# v3 — inline playback

Clips play in the cell rather than only in the full-screen viewer.

- [x] `MediaCell` gains a three-state mode: `still` / `preview` / `playing`
- [x] Click a clip -> still swaps to `<video>`, unmuted, no native controls
- [x] `pause` and `ended` both swap back to the still, which is the requested
      "on pause" behaviour; `stopPlayback` guards its own re-entrant `pause`
- [x] A hover preview under the cursor is **promoted in place** on click
      (unmute, stop looping) instead of restarting from zero
- [x] Playback outlives `pointerleave`; only pause, end, another clip starting,
      the lightbox opening, or the cell unmounting stops it
- [x] View tracks a single `playingCell`; starting one stops the other
- [x] Progress bar along the bottom of the cell, driven by `timeupdate`
- [x] `Space` toggles the selection; command "Play or pause selected clip"
- [x] Play badge hides while playing

Deliberately not native `<video controls>`: the controls live in the scaled
world layer, and clicks on them are indistinguishable from clicks on the cell,
so the toolbar would fight the click-to-toggle gesture. Scrubbing stays in the
full-screen viewer.

---

# v4 — shot detection

Detect the cuts in a clip with ffmpeg and cache them.

**Superseded by v5 for the UI half.** v4 exploded a clip into one canvas cell per
cut; v5 undid that and put the shots in a strip instead. The detector, the cache
and the data model below are unchanged and still current.

## Decisions (locked)

- **Clips are never split on disk.** A shot is `{ start, end }` against the
  original file. A 40-shot scene is one file and forty seeks, not forty exports.
- **Detection is ffmpeg's `scdet`, shelled out.** `ffmpeg -i f -vf scdet=... -an
  -sn -f null -` and parse `lavfi.scd.time` off stderr. Chosen over the
  `ffprobe -f lavfi -i "movie=…"` form because `movie=` needs lavfi path escaping
  (`C:\…` is a minefield) and cannot skip the audio decode. Measured on a 370 s
  720p clip: **10.5 s** for the ffprobe form, **5.1 s** for this one.
- This makes the plugin **desktop-only** (`child_process`). `manifest.json` flips
  to `isDesktopOnly: true`. Accepted deliberately — the alternative was a JS
  frame-differ at roughly a third of the speed.
- Nothing is written to the vault, as before: shot lists cache to
  `<plugin dir>/shots/`, beside `thumbs/`.

## Tasks

- [x] `types.ts` — `Shot { index, start, end, score }`; `MediaItem` gains `key`
      (identity, was `path`) and optional `shot`
- [x] `media/shots.ts` — `ShotIndex`
  - spawns ffmpeg, parses `lavfi.scd.score/time` off stderr, parses `Duration:`
    from the same run so no second process is needed
  - `buildShots()` is pure: cut times -> contiguous ranges covering the clip
  - min-shot-length drops a cut too close to the previous **kept** one, which is
    what stops one dissolve (scdet fires 2-3 times across it) becoming 3 shots
  - JSON cache at `<plugin dir>/shots/<hash><size>_<mtime>.json`, loaded once at
    startup; invalidates itself on re-export
  - concurrency **1** — detection is a full decode and would otherwise fight the
    UI for the same cores
  - `failed` set, `prune`, `clear`, `probe()` for the settings-tab check button
- [x] `thumbnails.ts` — key is `<base>_<shotTag>_<tier>.webp`; base stays
      file-level so `prune` still matches. Shot stills seek to **mid-shot**, not
      10% into the file
- [x] `lightbox.ts` — playback confined to the shot, scrubbing deliberately not
      (seeing what surrounds a shot is the point of opening it big)
- [x] Settings: ffmpeg path + **Check** button, cut sensitivity, shortest shot.
      Retuning either threshold clears the cache
- [x] Commands: detect shots in all clips, detect shots in the selected clip
      (always forces, so it doubles as the threshold tuning loop), clear
      detected shots
- [x] Status line shows detection progress

## v4 status

`npm run build` and `npm run lint` are clean (lint: 10 stylistic warnings, all
pre-existing in kind — sentence-case hints on `ffmpeg`/`scdet`/`PATH` as proper
nouns, plus the 1.13 declarative-settings suggestion).

`buildShots` is verified against real ffmpeg output from
`cinema/the boys/…-hd.mp4` (370.04 s, 37 raw cuts): ranges are contiguous, cover
the full duration exactly, and honour the minimum:

| shortest shot | shots | shortest | median |
| --- | --- | --- | --- |
| 0 s | 38 | 0.07 s | 0.63 s |
| 0.4 s (default) | 26 | 0.40 s | 2.10 s |
| 1.0 s | 18 | 1.00 s | 8.24 s |

**Not verified inside Obsidian** — the plugin has not been loaded and run. The
ffmpeg invocation, the stderr parse and `buildShots` are all tested against the
real file from the command line; the wiring around them is not.

### Follow-ups
- ~~26 shots in 6 minutes is too few~~ — fixed in v6; the default was the bug.
- `buildShots` and `formatTimecode` are pure and still have no test file, which
  is now the third time this list has said so.

---

# v5 — the shot strip

v4 put shots on the canvas. Wrong place: it made the canvas answer two questions
at once, and one film swamped the grid. Shots now live in a sticky strip along
the bottom of the view, for the selected clip only.

## Decisions (locked)

- **The canvas is always one cell per file.** `MediaIndex` never expands a clip;
  `expand()`, `ShotLookup` and `setShotLookup` are gone. `MediaItem.key` stays,
  because the thumbnail store still keys shot stills by it.
- **The strip is the only place a clip is broken up.** It owns its own elements
  rather than reusing `MediaCell`, which is built for absolutely-positioned world
  cells.
- **Fixed-width strip items, not proportional.** A proportional ribbon shows
  cutting rhythm but makes a 0.4 s shot an unclickable sliver. The strip is for
  navigating; rhythm can be its own view later.
- **Shot playback is transient.** `MediaCell.activeShot` is set by `playShot()`
  and cleared on stop, instead of a shot being baked into the cell's identity.
- **No settings toggle.** v4's *Split clips into shots* gated the whole feature;
  the strip's **Find cuts** button is the gate now, so `detectShots` and
  `ShotOptions.enabled` are gone.

## Tasks

- [x] `view/shot-strip.ts` — `ShotStrip`, four states: hidden / uncut (button) /
      detecting (spinner) / cut. Header carries count, average, shortest and
      longest; each item carries its start and its length
- [x] `view/canvas-view.ts` — `.cine-stage` wrapper so the strip takes real
      height off the viewport instead of floating over it; `playShot`,
      `openShot`, `onLightboxIndex`; `S` toggles the strip; `Shift+←/→` walks
      shots and falls through to the canvas when there are none
- [x] `media-cell.ts` — `playShot(shot)` and `activeShot`; `startPlaying()`
      extracted out of `togglePlayback()`; caption is the file name again
- [x] `shots.ts` — `isPending()` and `hasFailed()` for the strip's states;
      `running` holds the live job; `emit()` on start and finish so the strip
      swaps its button for a spinner
- [x] Reverted: canvas shot expansion, the `detectShots` setting, and the v4
      filmstrip *layout* (`settings.filmstrip`) built on a misread of "timeline"

## v5 status

`npm run build` is clean; lint is at the same 10 pre-existing stylistic warnings.
`computeLayout` re-verified as a plain grid after the revert (26 items -> 6 cols,
no `#t=` keys).

**Not verified inside Obsidian** — same caveat as v4. The strip has never been
rendered; only the layout function and `buildShots` are tested.

### Follow-ups
- No playhead tracking: the active item is set by clicking, not by where the
  video actually is. Needs `MediaCell` to report `timeupdate` upward.
- The strip re-renders every item on any `ShotIndex` change, including one for a
  different clip. Cheap today, wrong at 300 shots.
- A proportional ribbon view, for reading cutting rhythm rather than navigating.

---

# v6 — sensitivity that can actually be tuned

The strip worked and found a quarter of the cuts. Threshold 10 was the whole
problem, and re-running ffmpeg per tweak made it impossible to find that out.

## What was measured

Ran `scdet=threshold=0` once over the reference clip (370.04 s, 720p, 11,090
frames) and thresholded the score series offline, so every number below comes
from one decode rather than one decode per row.

Score distribution: **median 0.07, p99 5.2, max 28.6.** The old default of 10 sat
above the 99.9th percentile — it fired only on the most violent cuts.

| threshold | shots | avg | median |
| --- | --- | --- | --- |
| 10 (old default) | 26 | 14.23 s | 2.10 s |
| 8 | 45 | 8.22 s | 2.24 s |
| 6 | 67 | 5.52 s | 3.14 s |
| **4 (new default)** | **84** | **4.41 s** | **3.14 s** |
| 3 | 99 | 3.74 s | 2.24 s |
| 2 | 154 | 2.40 s | 1.27 s |

Sampled 8 cuts scoring 3–10 — the ones threshold 10 rejects — and compared the
frames either side: **6 of 8 are genuine cuts**, 2 are camera movement inside a
shot.

Three things were ruled out before committing to the simple fix:

- **Adaptive thresholding** (rolling-neighbourhood ratio, PySceneDetect's
  `detect-adaptive`) gives the *same* 84 shots at any sensible ratio once the
  floor is 4. On this material the absolute floor does all the work. Not worth
  building.
- **Keyframe positions** (free, no decode) are a fixed 8.34 s GOP with only 14 of
  47 gaps shorter than that. Useless as a cut source for a web-encoded file.
- **`select='gt(scene,X)'`** is the same metric on a 0–1 scale. `scene > 0.1` and
  `scdet >= 4` both yield exactly 84 shots, and select's cuts are a strict subset
  of scdet's. ffmpeg has one algorithm, not two.

## Decisions (locked)

- **Cache candidates, not shots.** ffmpeg is asked for every frame scoring at or
  above `SCORE_FLOOR = 1`; sensitivity is applied afterwards in `buildShots`.
  Retuning is a recompute over a few hundred numbers, not a re-decode.
- **The floor costs nothing.** 823 rows instead of 37 for the reference clip;
  measured 8.4 s at the floor against 10.4 s at threshold 10 — inside the noise.
  26 KB of cache for 6 minutes.
- **Default sensitivity is 4**, slider 1–20 in steps of 0.5. The floor is the
  slider's minimum, because the cache cannot honour anything lower.

## Tasks

- [x] `shots.ts` — `Candidate`, `Detection`; cache stores `{duration, floor,
      candidates}`; `derived` memo per clip dropped on retune; `setOptions` no
      longer wipes the disk cache
- [x] `buildShots(candidates, duration, threshold, minLength)` — threshold moved
      inside, still pure
- [x] Settings: default 10 -> 4, limits 1–40 step 1 -> 1–20 step 0.5, both
      descriptions corrected (they claimed a retune cleared the cache)
- [x] Pre-0.6 cache files cache shots and cannot be re-cut; `init` skips them and
      lets the next detection overwrite

## v6 status

`npm run build` clean, lint unchanged. `buildShots` re-verified against the real
823 candidates: all seven thresholds reproduce the offline Python counts exactly
(154 / 99 / 84 / 74 / 67 / 45 / 26), every list contiguous and covering
370.040/370.040. Edge cases pass: no candidates, all below threshold, cut past
the end, cut at 0, minimum-length collision, determinism.

**Still not verified inside Obsidian.**

### Follow-ups
- Dissolves are still invisible. That is a detector limit, not a setting.
- The strip's re-cut button now forces a decode nobody needs unless the file
  changed. Could become "re-cut" (free) vs "re-detect" (slow).
- A sensitivity preview — shot count as you drag the slider — is now cheap, and
  would make tuning obvious instead of trial and error.

---

# v7 — TransNetV2 as a second detector

The complaint that started v6 was missed cuts. Measurement said the threshold was
wrong, and fixing it worked — but it also showed the shape of what `scdet` cannot
do: it scores a frame-difference statistic, so it cannot see a dissolve and it
cannot tell a whip pan from a cut. No parameter fixes either. A different class
of detector does.

## Decisions (locked)

- **Two detectors, side by side, never merged.** Each clip caches candidates for
  both under its own key. The strip's two buttons are a run button when a
  detector has not run and a switch when it has — the same gesture either way.
- **TransNetV2, not AutoShot.** AutoShot scores marginally better on the SHOT
  benchmark; TransNetV2 has a maintained ONNX export and a documented inference
  protocol, which matters more than a point of F1 here.
- **`onnxruntime-node`, not `onnxruntime-web`.** It is a native N-API addon, and
  N-API is ABI stable across Node and Electron, so the prebuilt binary loads in
  Obsidian's renderer. It is marked external in esbuild and required from the
  plugin's own `node_modules`. The cost is ~283 MB in `node_modules` (~30 MB of
  that is the x64 binary actually used) and a plugin that is no longer one file.
- **The model is downloaded, not vendored.** 31 MB from Hugging Face into
  `<plugin folder>/models/`, behind a button in settings. Nothing about the vault
  is sent; the response is size-checked before it is written, so a redirect page
  cannot masquerade as weights.
- **Scores stay on one 0–100 scale.** TransNetV2's probability is stored ×100, so
  `buildShots` is unchanged and serves both detectors. Only the threshold differs
  (`shotThreshold` 1–20, `transnetThreshold` 5–95).
- **Peaks, not rising edges.** A transition lights up several neighbouring
  frames. `peaks()` keeps only local maxima at candidate time, so the shortest-
  shot setting is free to be zero and a dissolve is still one cut.

## Measured

Reference clip: 370.04 s, 720p, 11090 frames, 29.97 fps. No NVIDIA GPU.

| | ffmpeg `scdet` | TransNetV2 |
| --- | --- | --- |
| wall time | 6 s | 83 s |
| candidates cached | 823 | 305 |
| cuts at default | 82 (th 4) | 62 (th 50) |

Execution providers, 30 s of video: CPU 22.2 s, CPU with 4 threads 22.2 s,
**DirectML 5.9 s** — 3.7× faster, byte-identical cuts. DirectML runs on the
integrated GPU, so it is the default with a CPU fallback.

Sensitivity sweep, TransNetV2, min length 0.4 s:

| threshold | 5 | 10 | 25 | 50 | 75 | 95 |
| --- | --- | --- | --- | --- | --- | --- |
| shots | 88 | 78 | 73 | 63 | 58 | 21 |

Agreement, TransNetV2 at 50 against `scdet` at 4:

- 62 of ffmpeg's 82 cuts confirmed.
- 21 rejected — all inside three handheld passages (48–56 s, 132–144 s,
  273–279 s). These are the false positives the v6 threshold hunt could not
  remove without also losing real cuts.
- 3 added, all of which `scdet` scored between 1 and 4.
- 0 dissolves found, because the clip has none.

**Correction to v6.** The v6 table recorded 154 / 99 / 84 / 74 / 67 / 45 / 26
shots for `scdet` thresholds 2 / 3 / 4 / 5 / 6 / 8 / 10. Recomputed twice today —
once in Python over the full 11090-frame dump, once through the shipped
`buildShots` over the 823 cached candidates — the counts are
**154 / 98 / 82 / 72 / 65 / 43 / 25**. The two agree exactly at every threshold,
which is the property that matters: the floor-1 cache is lossless above the
floor. The v6 numbers were off by up to two.

## Tasks

- [x] `transnet.ts` — ffmpeg rawvideo pipe at 48×27, streaming 100-frame windows
      with stride 50, DirectML with CPU fallback, `peaks()` non-max suppression
- [x] `shots.ts` — `Detector` type, per-detector cache key and cache file, a
      `preferred` map, `detectorFor` / `prefer` / `pendingDetector` /
      `progressFor`, model path + `hasModel` + `downloadModel`
- [x] Shot strip — two detector buttons that double as a switch, a progress
      percentage while TransNetV2 runs, detector name in the header summary
- [x] Settings — TransNetV2 sensitivity slider, model path + Download button,
      ffmpeg slider renamed
- [x] Commands — `detect-shots-transnet`, `detect-shots-selected-transnet`
- [x] esbuild externalises `onnxruntime-node`; `models/` and `shots/` gitignored
- [x] Bump to 0.7.0

## v7 status

`npm run build` clean. Lint: 0 errors, 19 warnings — all the sentence-case rule
objecting to proper nouns (`ffmpeg`, `TransNetV2`, `PATH`, `src/`) plus the 1.13
declarative-settings suggestion.

Verified by bundling the real `src/` functions with esbuild and running them
against the reference clip:

- `detectWithTransNet` end to end: 305 candidates, scores 1.01–97.49, 83 s.
- `buildShots` over those: contiguous and covering 370.040/370.040 at every one
  of six thresholds.
- At `minLength` 0 it gives 66 shots against the reference implementation's 65
  cuts — exact agreement, so the windowing and padding match the authors'
  protocol.
- `peaks()` collapses a three-frame plateau to one candidate, keeps two separate
  spikes, and returns nothing for an empty or all-below-floor input.
- ffmpeg path unchanged: cached candidates and the full per-frame dump produce
  identical shot lists at thresholds 2, 3, 4, 5, 6, 8, 10.

**Still not verified inside Obsidian.** In particular `require('onnxruntime-node')`
from the plugin's `node_modules` under Electron is reasoned, not observed.

### Follow-ups
- Inference blocks the renderer in ~170–420 ms bursts even with a yield between
  windows, so Obsidian will stutter for the ~80 s a clip takes. The fix is to run
  it out of process — `process.execPath` with `ELECTRON_RUN_AS_NODE=1` gives a
  Node that already has the addon — which needs a worker script on disk.
- The download button has no progress. `requestUrl` buffers the whole 31 MB with
  no callback; a streaming fetch would fix it.
- Nothing tests whether TransNetV2 actually catches dissolves, because the
  reference clip has none. Needs footage that dissolves.
- Both detectors still re-decode on the refresh button. "Re-cut" (free) vs
  "re-detect" (slow) is still unbuilt.
- A sensitivity preview — shot count as you drag — is still unbuilt, and now
  there are two sliders that want it.

---

# v7.1 — the TransNetV2 button did nothing, and the sliders were in the wrong place

## The bug

"TransNetV2 found no cuts" on every clip. The cause was one line:

```ts
await import('onnxruntime-node')
```

esbuild leaves a dynamic `import()` as a real ESM import even when the output
format is `cjs` and the module is marked external. Obsidian's renderer then
resolved it against the page URL — `app://obsidian.md/onnxruntime-node` — and
found nothing. The rejection happened before a single frame was read, and
`pump()` swallowed it, so the failure arrived as an empty result.

Fixed by calling `require` instead. Inside the CJS bundle that is the `require`
Obsidian handed `main.js`, rooted at the plugin folder, which is exactly where
`node_modules/onnxruntime-node` is. `window.require` stands in if the module
scope ever stops providing one.

**Verified**, not reasoned this time: the same `src/` functions bundled with
`--format=cjs --external:onnxruntime-node`, written into the plugin folder, and
required from Node. The addon loads and the run completes — 305 candidates,
scores 1.01–97.49, 83 s, identical to the earlier ESM-harness numbers. Under
`--format=esm` esbuild substitutes a shim that throws "Dynamic require is not
supported", which is why the first harness could not have caught this.

## Errors are no longer silent

`ShotIndex` keeps a message per clip per detector. `pump()` records it and logs
the stack; the strip prints it where the clip name goes; the notice quotes it.
A detector that ran cleanly and found nothing now says "it may be a single take"
instead of wearing the same text as a missing runtime.

Every `return null` that meant "something is broken" became a `throw` with a
sentence: no model at that path, ffmpeg decoded no frames, ffmpeg reported no
duration — each carrying the last two lines of the ffmpeg log.

## The sliders moved into the strip

Cut sensitivity, TransNetV2 confidence and shortest shot are gone from settings.
They are in the strip header, beside the shots they cut, because every one of
them re-cuts from cached candidates in a few milliseconds — the strip under your
hand *is* the readout. Settings keeps only what is not a cutting parameter: the
ffmpeg path and the model.

Only the threshold of the detector currently showing is rendered. Offering the
other one means dragging a slider that changes a list you cannot see.

Two things this needed:

- **A drag guard.** Each step calls `setParam`, which re-cuts, which fires
  `onChange`, which would rebuild the header and tear the slider out from under
  the pointer. While `adjusting` is set, `render()` redraws only the summary and
  the shot cells.
- **A deferred write.** `setShotParam` applies to `ShotIndex` immediately and
  debounces `saveData` by 500 ms, because a range input fires per pixel.

Change events from `ShotIndex` are now coalesced to an animation frame. Detection
emits one per window, which was 222 full re-renders of the strip for one clip.

## Tasks

- [x] `require` instead of `import()`, with the failure surfaced
- [x] `errorFor(item, detector?)`, populated in `pump()` and shown in the strip
- [x] Cutting parameters rendered in the strip header, removed from settings
- [x] `setShotParam` on the plugin: instant apply, debounced save
- [x] Drag guard and rAF-coalesced rendering in the strip
- [x] Bump to 0.7.1

## v7.1 status

`npm run build` clean. Lint: 0 errors, 16 warnings — all the sentence-case rule
objecting to proper nouns, plus the 1.13 declarative-settings suggestion.

End-to-end verification re-run against the reference clip after the change, this
time through a CJS bundle in the plugin folder, which is how `main.js` is loaded:
305 candidates, all six thresholds contiguous and covering 370.040/370.040,
`minLength` 0 giving 66 shots against the reference implementation's 65 cuts,
`peaks()` unit checks passing.

**The strip UI is still not verified inside Obsidian** — the drag guard, the
progress readout and the detector switch have never been clicked.

### Follow-ups
- Unchanged from v7: inference still blocks the renderer in bursts; the download
  button still has no progress; dissolves are still untested for want of footage.
- The parameter sliders re-render every shot cell per drag step. Cheap at 60
  shots, possibly not at 400 — the cells could be reused by index instead.

## v7.2 — the runtime was never on Obsidian's search path

`require('onnxruntime-node')` threw `MODULE_NOT_FOUND` inside Obsidian, with the
package sitting right there in the plugin's own `node_modules`.

v7.1 fixed the wrong half of the problem. Swapping `import()` for `require` was
necessary — a dynamic import survives bundling as a real ESM import and the
renderer resolves it against the page URL — but it was not sufficient, and the
comment I wrote justifying it was wrong: Obsidian's `require` does **not**
resolve from the plugin folder. `main.js` is evaluated in the renderer, so the
`require` in scope is Electron's, whose resolution paths are rooted at
Obsidian's program directory. A bare specifier walks up from there and never
enters the plugin folder.

Fixed by requiring the absolute path. `ShotIndex.runtimeDir()` resolves the
plugin folder through `FileSystemAdapter.getFullPath` and passes it into
`detectWithTransNet`; `loadOrt(runtimeDir)` tries
`<runtimeDir>/node_modules/onnxruntime-node` first and the bare name second, in
case the package has been hoisted somewhere visible. Both failures are quoted in
the thrown message, so the next one names the paths it tried.

Verified rather than reasoned about, this time in the shape that actually
distinguishes the two cases: from a process whose cwd is *not* the plugin
folder, the bare name gives `MODULE_NOT_FOUND` and the absolute path loads
onnxruntime-node 1.29.0. My earlier harness ran with the plugin folder as cwd,
where the bare name resolves — which is exactly why it could not see this.

End to end on the reference clip after the change: 305 candidates, 1.01–97.49,
93 s, and the same shot counts as v7.1 (88/78/73/63/58/21 at 5/10/25/50/75/95,
every list contiguous and covering 370.040 s).

**Lesson worth keeping:** a harness that runs from a different directory than
the real thing cannot test module resolution. Two bugs in a row hid behind that.

## v8 — a tab of its own for one clip

The strip answers "where in this clip am I" while the canvas still fills the
screen. That is the right shape for browsing and the wrong shape for studying:
one scrolling row, 132px a cell, and no sense of how long anything is.

`CinemaClipView` (`cinema-clip`) takes a whole tab and spends it on one clip:

1. **The player.** Scrubbable anywhere, deliberately not confined to the current
   segment — seeing what surrounds a cut is most of why you would open this.
2. **The ribbon.** Every segment drawn to scale. This is the only place in the
   plugin where shot length is proportional, and it is the one view that makes
   cutting rhythm legible as a shape rather than as a column of durations.
3. **The grid.** One card per segment, wrapping, all cards the same size. Not to
   scale on purpose — here a segment is a target to click, and the ribbon
   already carries the proportion.

One playhead drives all three. `syncPlayhead` maps `video.currentTime` onto the
ribbon and finds the segment under it, so the highlight follows the video no
matter what moved it. Clicking a segment confines playback to its range (repeat
or pause at the last frame, per the loop button); scrubbing out of that range
releases the confinement rather than yanking the playhead back.

**What had to be shared.** The cutting sliders and the detector buttons now
belong to both views, so they moved into `shot-controls.ts` — one implementation,
one drag-guard contract (`hold`/`release`, which each view uses to suppress the
one re-render that would tear a slider out from under the pointer). The CSS
classes lost their `cine-strip-` prefix for the same reason. `ShotParams` and
`ShotParamKey` live there now; `main.ts` imports them from there.

**The player is built once per clip, not once per render.** Re-creating it on
every change event would restart the video every time a slider moved, which is
precisely the thing this view exists to avoid.

**Deferred views.** Matching an already-open clip tab reads
`leaf.getViewState().state`, not `leaf.view`: since Obsidian 1.7 a background
leaf holds a placeholder until it is revealed, so asking the view would have
missed every tab the user had not looked at and opened duplicates.

**State across restarts** is the vault path, not the item — a leaf can only
persist plain data, and the media index has not scanned anything yet when the
workspace is restored. The item is resolved lazily and re-resolved on every index
change.

### Not done

- No test of the view in a DOM. There is no jsdom in the project and adding one
  is a dependency decision, so this went out on a type check and a careful read.
- The ribbon has no frame-accurate scrubbing: clicking a block plays its segment
  rather than seeking to the exact x position. Worth adding if the ribbon starts
  getting used as a scrubber.
- Dragging a slider re-renders every card. Fine at 90 segments, unmeasured at
  400 — the same open question the strip has.

## v8.1 — segments ran past their cut

Reported: the cuts look right, but playing a segment does not stop before the
cut — it stops a beat after, "like 0.1s". Two separate causes, both measured.

### 1. The stop was checked on `timeupdate`

Every player — clip view, lightbox, canvas cell — confined a shot with
`timeupdate` and `currentTime >= shot.end`. Chromium fires `timeupdate` about
every 250 ms, so playback ran 0–250 ms into the next shot before the check even
happened. Modelled on the reference clip's 82 scdet segments: 4.1 frames of the
next shot on average, 8 at worst (267 ms). The report's "0.1s" is the typical
case.

Fixed with `SegmentPlayer` (`src/view/segment-player.ts`), used by all three:

- `requestVideoFrameCallback` fires once per *presented* frame with that frame's
  own media time. The callback arrives after presentation, so it stops on the
  frame whose time is within 1.5 frames of `end` — the segment's last frame —
  rather than waiting for `>= end`, which is already the next shot.
- Play-once pauses there and then **pins** the last frame with a seek to just
  inside it, so if the decoder got one frame further before the pause landed,
  the outgoing shot is what stays on screen and `currentTime` is still inside
  the segment (the highlight stays put).
- Seeks aim a little inside the frame (`min(half a frame, 1/120 s)`). Cut times
  are stored to the millisecond, and a seek a hair before a frame shows the one
  before it — the last frame of the previous shot, as a flash.
- Frame duration is learned from the callback (shortest media-time step per
  presented frame), 1/30 until two frames have been seen.
- Ending, or scrubbing out of the segment, releases the confinement, so pressing
  play afterwards carries on into the next shot.

Verified with a frame-stepped simulation of the shipped class against a mock
video, over the 82 real segments: first frame shown is the segment's first,
nothing from the next shot is shown, and play-once comes to rest on the last
frame — at 29.97, 23.976, 25 and 59.94 fps, with ±4 ms of timing jitter, play
once and loop. A pessimistic model where one frame escapes after `pause()` shows
exactly one frame of the next shot and then pins back; whether Chromium ever
does that from inside a frame callback is not something the simulation can say.

### 2. TransNetV2 put every cut one frame early

Of the 62 cuts both detectors found on the reference clip, 60 sat exactly one
frame before scdet's. scdet's score for frame n compares it with frame n−1, so
its time is the first frame of the incoming shot. TransNetV2 marks the last frame
of the outgoing shot — consistent with its authors' scene splitter, which puts
the marked frame at the end of the earlier scene. The windowing was checked and
is not the cause (pad index 25 is frame 0; the second window's kept range starts
at frame 50).

Fixed in `peaks()`: a candidate's time is `(i + 1) / fps`. Re-run on the
reference clip: 305 candidates, 79 s, and **62 of 62** shared cuts now on exactly
the same frame as scdet.

Cache files now carry `cutAt: 'incoming'`. TransNetV2 files without it are
ignored on load rather than shifted — the shift is one frame at the clip's exact
rate, which the file never recorded — so those clips need TransNetV2 run again.
ffmpeg caches are unaffected.

## v9 — the sound view

Asked for: cuts stay for clips; for a full film, "the sound/silence/dialogue
whatever", in a separate view, in its own cache file.

### What was built

- `SoundIndex` (`src/media/sound.ts`): queue of one, progress, stop, errors, a
  cache per file in `sound/` keyed by path hash + size + mtime (a rewritten file
  is re-analysed and its old file deleted), and a streamed model download with
  redirects, progress and SHA-256 verification against pinned revisions.
- `analyseSound` (`src/media/sound-analysis.ts`): one ffmpeg decode of the first
  audio track to 16 kHz mono f32le, read three ways — Silero VAD per 32 ms, PANNs
  CNN14 on a 2 s window every 1 s (every second heard by two windows and
  averaged), RMS per 100 ms. Cached as integers.
- `classifySound`: pure, thresholds -> four lanes with per-lane gap filling and
  minimum runs. Effects = audible and neither dialogue nor music, or an effect
  class at 20+ underneath them.
- `CinemaSoundView`: player, whole-film lanes (pre-rendered, playhead drawn per
  frame), detail lanes following the playhead with wheel zoom, hover readout
  with PANNs' top three classes, and lists of music cues / silences / 30 s
  without dialogue. Opens from the file menu, a command, the strip and the clip
  view.
- `src/media/onnx.ts`: the runtime loader and session cache moved out of
  `transnet.ts`, now shared; sessions can turn off thread spinning.

### Choosing the models

- AST (MIT's Audio Spectrogram Transformer, quantised ONNX from Xenova) scores
  best on AudioSet, but measured 1.1-2.2 s per 10 s window on the CPU: 18+ min
  for a two-hour film at 10 s resolution. Rejected.
- PANNs CNN14 at 16 kHz takes raw waveform of any length (the STFT is in the
  graph): 42 ms per 2 s window alone, ~74 ms inside the pipeline. DirectML was
  slower at every window size under 60 s.
- The only ONNX export found is a single uploader's Hugging Face repo (MIT, no
  model card). Accepted because its op set is plain (no custom ops, so nothing
  executable beyond the graph), its output on the test track is exactly what a
  working AudioSet tagger gives, and the download is pinned by revision and
  hash. If that repo disappears, the download fails loudly; nothing breaks
  silently.

### Verified

- Known-truth test track (185 s: TTS speech, silence, Satie on piano, rain and
  thunder, gunshots, thunder, TTS over Beethoven at -12 dB, silence, Beethoven):
  175/185 seconds exact. Speech 25/30 (the 5 are TTS sentence pauses, digitally
  silent), silence 20/20, music 60/60, effects 43/45, speech+music 27/30.
- 14.0 s wall for 185 s (9.1 min per two hours); spinning off took it from 16.7 s.
- Stop mid-run, a file with no audio track, a 1.35 s file, a 7.55 s file.
- Real download through `SoundIndex`: 330 MB in 40 s, progress to 100%, no
  `.part` left; a truncated model re-fetched on its own; a different file served
  under the same name (Silero v5.1.2) refused with nothing installed.
- Lifecycle: analyse -> cache file -> fresh index reads it back; rewritten file
  -> old readings ignored -> re-analysis replaces the old cache file; stop
  records no error and writes nothing.
- The view, in jsdom over the real index and models: 37 checks through no
  models -> ready (estimate from duration) -> running (stop button and header
  survive progress updates) -> done (summary shares, 3 music cues and 2
  silences on the test track, sliders, lists) -> drawing at dpr 2 with no NaN
  rects, 0.83 ms per frame -> hover readout, overview click seeks, wheel zoom,
  arrow keys, space, cue row plays -> slider survives a drag and re-labels ->
  missing file and back -> reopened tab reads the cache without running.

### Not done / not verified

- Not run inside Obsidian: real layout, theme colours, and whether Electron's
  renderer tolerates a 9-minute analysis without stutter. Every inference call
  is async (the runtime works off the main thread), so it should, but that is
  inference, not measurement.
- Not run on a real film. The test track is synthetic by necessity; a mix with
  music under most dialogue will lean on the music slider.
- Renaming a file re-analyses it (the cache is keyed by path), and the old cache
  file stays until **Clear sound analysis**.
- Only the first audio track. No track picker.
- One analysis at a time, in-process, like TransNetV2.

## v10 — one detector, and the strip as two tabs

Asked for: the bottom sticky should carry buttons that open the dedicated cut
and sound views, plus a tab bar switching between a quick cut view and a quick
sound view, with an analyse button on whichever side has not been run. And:
remove the ffmpeg cut detector, "the neural net is just so much better".

### The ffmpeg detector is gone

Not reduced to a one-member union — the concept is deleted. `Detector`,
`DETECTORS`, `DETECTOR_LABELS`, `detectorFor`, `prefer`, `pendingDetector`, the
`preferred` map, the per-detector cache key, `runScdet`, `SCD_LINE`,
`parseDuration` and the `shotThreshold` setting are all removed; `ShotIndex`
methods no longer take a detector. `probe()` and `ffmpegPath` stay, because
TransNetV2 reads its frames through an ffmpeg pipe and the sound view reads its
audio the same way.

Two things were deliberately kept:

- The `_transnet` suffix on cache file names. It is what every existing cache
  file is already called, so dropping it would orphan them all *and* collide
  with the unsuffixed names the ffmpeg detector used to write.
- The `detector` field inside the cache file, now read as a filter: `init()`
  skips anything that does not say `'transnet'`. This is the one genuinely
  dangerous part of the change — scdet scores frames 1-20 and the network
  scores probability x100, so an old file read at the 50% confidence would
  report a feature film as a single take rather than failing loudly. Old files
  are ignored on load and swept up by `prune` and `clear`.

Consequence to expect: a clip that was only ever cut with ffmpeg now shows as
uncut until TransNetV2 is run on it.

### The strip

`ShotStrip` is now two tabs over one body, both about the selected clip.

- **Cuts**: the shot cards as before, the cutting sliders, Find cuts when it has
  not run, refresh when it has.
- **Sound**: the same four lanes as the sound view, drawn `STRIP_ROWS` high
  across the whole clip, with a hover readout and click-to-play-from-here. When
  it has not been analysed the lanes are replaced by a panel that walks the same
  path the sound view does — download models, analyse, progress with a stop
  button, error with a retry.
- Each tab carries a dot when its own side has never been run for this clip, so
  "there is nothing here" is visible before you switch to find out.
- Both tabs carry the button that opens their dedicated view.

`src/view/sound-lanes.ts` is new: `LANES`, `drawLanes`, `rowTops`, the theme
colour cache and the two formatters moved out of `sound-view.ts` so the strip
and the full view draw from one implementation. Two drawings of the same four
lanes would have drifted.

Clicking the strip's lanes plays the canvas cell from that point to the end,
through a synthetic full-tail `Shot` — `SegmentPlayer` already confines
playback to a range and pauses at its end, so this needed no new plumbing.

### Verified

- jsdom, over the real `ShotIndex` and `SoundIndex` and the real models
  (`domtest/strip-test.cjs`): a planted ffmpeg-era cache file is ignored while
  the TransNetV2 one loads, and no scdet-scored cut leaks into the shot list;
  both tabs, the not-run dots, the open-dedicated-view buttons, card clicks,
  analyse -> progress -> lanes, the hover readout, click-to-seek carrying the
  right time and duration, the two sliders re-labelling with nothing re-run,
  and switching tabs and clips back and forth.
- `npm run build` clean; `npm run lint` 0 errors.

### Not done / not verified

- Still never run inside Obsidian. Everything below is inference from jsdom.
- The strip's sound tab offers only the dialogue and music thresholds. The
  silence level belongs with the lists, which only the full view has.
- Analysing a two-hour film from the strip works but is an odd place to start a
  nine-minute job; the dedicated view is the better home for that.
- Old ffmpeg cache files are only deleted when `prune` or **Clear detected
  shots** runs, not on upgrade.

## v10.1 — the sound view's lanes were blank, and full screen

Two things, one of which was the actual complaint.

### The blank lanes

In real Obsidian the dedicated sound view drew nothing: labels, stats and lists
all present, both canvases and the readout empty. The strip drew the same four
lanes from the same module perfectly, which is what made it worth diffing the
two draw paths rather than the lane drawing.

The cause, from the console trace Khan sent:

```
HierarchyRequestError: Failed to execute 'appendChild' on 'Node':
Only one element on document allowed.
    at HTMLDocument.createEl (enhance.js)
    at lt.draw (plugin:cinema-canvas)
```

`draw()` builds the overview as an offscreen bitmap, and asked for it with
`activeDocument.createEl('canvas')`. **Obsidian's `createEl` appends to whatever
it is called on**, so on a document it tries to add a second document element and
throws. Every `draw()` died on that line, before the detail lanes and before the
readout — which is why the labels, stats and lists were all present and only the
painting was missing.

The bitmap is now made by the timeline element, which `createEl` may legally
append to, and removed again on the next line: a detached canvas is still a
valid `drawImage` source and never reaches the layout. `createElement` would say
it more directly, but `obsidianmd/prefer-create-el` forbids it and
`eslint-comments/no-restricted-disable` forbids silencing that rule, so this is
the shape that satisfies both.

I had first reasoned my way to the `isShown()` gate at the top of `draw()` from
the screenshot alone, which was wrong — right symptom, wrong line. That work was
kept, because all of it is real hardening for a draw that runs once at open:

- the canvases are sized inside `draw()`, the way the strip does it, rather than
  in a pass of their own,
- the `isShown()` gate is gone; a canvas still 0 px wide re-tries next frame,
  bounded at 60 frames so a collapsed sidebar cannot hold a frame open,
- `onResize`, `active-leaf-change` and `onLayoutReady` all draw again.

The jsdom stub is why no test caught this: its `document.createEl` returned a
detached element instead of appending. It now appends exactly as Obsidian's
does, and jsdom throws the same `HierarchyRequestError`.

### Full screen

The sound view also gained an **expand** button and `f`. It fullscreens the
view's own root, not the `<video>`: a fullscreened video element is handed to
the compositor and sits above the rest of the page, so lanes drawn under it
cannot be seen at all. The stylesheet hides the header and the lists under
`.cine-sound-view:fullscreen`, so the DOM is untouched and the normal layout
cannot regress.

### Verified

- `domtest/view-test.cjs`, 51 checks, all passing. The new ones: a canvas
  reporting a width of 0 paints nothing and throws nothing; when the width
  arrives the lanes paint and the readout fills, both via `onResize` and via the
  retry alone with no resize at all; and a view detached at its first render —
  which is how a leaf revealed after `onOpen` reads to `isShown` — still paints.
- The harness was also run against a bundle built from a copy of `src` patched
  back to the shipped code (`old-src`, `VIEW_BUNDLE=`), and with the corrected
  stub it **reproduces Khan's crash exactly** — `HierarchyRequestError: Invalid
  insertion of CANVAS node in #document node`, jsdom's wording for the same
  thing. So the harness now fails on the real bug rather than agreeing with
  whatever the current code happens to do.
- An empty readout is the symptom that identifies a dead `draw()`: it is written
  on the last line of the method, so it is missing whenever the method did not
  finish. "The canvases are sized" is the check that does *not* detect it —
  `render` sized them before `draw` ever ran.
- Full screen: the button is in the header, the *view* is what goes full screen
  rather than the video, the lanes stay in the tree and repaint on the
  transition, and both the button and `f` toggle back out.
- `npm run build` clean; `npm run lint` 0 errors.

### Not done / not verified

- The blank-lane fix matches the reported stack trace and is reproduced in the
  harness, but the lanes have still not been seen painting inside Obsidian.
- Nothing else in the plugin calls `createEl` on a document — checked — but the
  same trap is open to any future offscreen canvas.
- The fullscreen *layout* is still a guess — how much room the player takes up
  there, whether the detail lanes want to be taller.
- The clip view's expand button still fullscreens only the player, so its
  ribbon disappears the way the lanes would have.

## v11 — whole films, scenes and labels, and everything in the vault

Asked for: cut a whole movie; label cuts; group cuts together, each group in a
view of its own. Then, on where it lives: "note in the vault. also move the
shots/ and sound to vault as well". Groups are scenes — consecutive runs of cuts
— and each opens in its own tab.

### Decisions (locked)

- **Everything is in the vault, in two kinds of place.** Rebuildable caches go to
  `_cache/cinema-canvas/{shots,sound}/`, the folder this vault already gitignores
  as "rebuildable cache — never version this" and where writer-studio keeps its
  index. Hand-made data goes in a note beside the film: `Heat.mkv` ->
  `Heat.mkv.scenes.md`. Thumbnails and models stay in the plugin folder; they
  were not part of the ask.
- **The note holds one fenced `cinema-scenes` JSON block, not frontmatter.**
  Lists of objects render badly in Properties, and frontmatter would mean
  trusting a stub of `parseYaml` in every test. The block is parsed by our own
  code and written by replacing only the block; the rest of the note is the
  user's.
- **Scenes and labels are anchored to times, never cut numbers.** The confidence
  slider renumbers cuts. A scene is `{start, title}`, runs to the next scene, and
  snaps to the nearest cut whenever it is read; a label is `{at, text}` shown on
  whichever cut contains `at`. Both survive any retune.
- **Strict parsing, and refuse to write.** One unreadable entry makes the whole
  block an error, and nothing is saved while there is one. A lenient parser that
  skipped bad entries would delete them on the next save.
- **The note's name keeps the film's extension**, so two films sharing a base
  name never share a note, and the film is found from the note by stripping the
  suffix — nothing inside the block can go stale on a rename.
- **One view, two modes.** A scene tab is `cinema-clip` with `scene: <mark>` in
  its state rather than a second view type: the same player, ribbon and grid,
  confined to the scene.
- **The cut view opens any video**, not only what the canvas indexes — a film is
  usually outside the canvas folders — and follows the file through vault events.

### Tasks

- [x] `media/scenes.ts` — pure model (`buildScenes`, `findScene`, `sceneOf`,
      `nearestShot`, `labelsIn`, `splitAt`, `mergeIntoPrevious`, `renameScene`,
      `setLabel`), the block (`parseNotes`, `parseBlock`, `formatBlock`,
      `writeNotes`), and `notePathFor` / `filmPathForNote`
- [x] `media/scene-store.ts` — reads lazily; writes through `vault.process`
      against what is on disk; creates the note on the first edit; re-reads a
      hand edit; moves the note with its film via `fileManager.renameFile`
- [x] `media/vault-cache.ts` — `_cache/cinema-canvas/`, `ensureDir`, and
      `migrateDir`, which moves the old plugin-folder caches once (a file already
      at the destination wins; the old folder goes when empty)
- [x] `shots.ts` — cache in the vault; `cancel`, `wasCancelled`, `startedAt`; a
      second `detect` joins the queued run; `rename` carries a detection to its
      new path; `clear` resolves queued callers instead of leaving them waiting
- [x] `transnet.ts` — `signal` kills ffmpeg and throws `DetectionCancelled`;
      `DETECTION_SECONDS_PER_SECOND` for the estimate
- [x] `sound.ts` — cache in the vault; `rename`
- [x] `view/clip-view.ts` — rewritten: any video; scene bands; ribbon blocks that
      touch (a film's 1px gaps were wider than the ribbon); a section per scene
      with play / rename / merge / open; the cut menu; `T` and `S`; scene tab
      mode; stop button, percent and time left; stills only near the viewport,
      withdrawn when scrolled away; cards held back while a slider is dragged;
      the highlight touches two elements per cut change, not every card
- [x] `view/scene-block.ts`, `view/text-prompt.ts`
- [x] `main.ts` — `SceneStore`; **Open in cut view** in the file menu and as a
      command; `openClip(file, scene?)`; `isVideoFile`, `itemForFile`; renames
      carry shot lists and sound readings; the code block processor
- [x] Strip: stop button while detecting; no "found no cuts" notice after a stop
- [x] Bump to 0.11.0

### Verified

Four suites over the real sources bundled with esbuild:

- **Scene model**, 34 checks: snapping, hidden marks, scenes following a re-cut,
  full coverage, edits leaving their argument alone, the block round trip, text
  around the block byte-identical, `$&` in a title, CRLF endings, and six kinds
  of malformed block each reported rather than silently dropped.
- **Scene store** over a real folder, 18 checks: no note creates nothing; the
  first edit creates one; hand text either side survives; two concurrent edits
  both land; a broken block is reported, keeps the last good scenes, refuses the
  edit and leaves the file byte-identical; a film rename moves its note; an
  unrelated rename is ignored.
- **Cut view** in jsdom at film scale, 55 checks. The reference clip's real
  candidates repeated twenty times: 7400.8 s, **1281 cuts**, rendered in 218 ms.
  Block widths sum to 100.0000%. No still requested on render; twelve for twelve
  cards in view; none asked twice; all twelve withdrawn on scrolling away. Split,
  label, edit and clear a label, name the implicit first scene, merge; a broken
  note refusing an edit with a notice; a scene tab (981 cuts, stepping wraps
  inside the scene, state round trip); a merged scene's open tab falling back to
  the scene it joined; a slider drag re-cutting the ribbon live (1281 -> 781)
  while the cards wait for the release; a running detection's percent, time left
  and stop button; a film rename keeping its cuts and its note.
- **ShotIndex against real ffmpeg and TransNetV2**, 25 checks, on the real 370 s
  and 177 s clips: shots and sound migrated out of the plugin folder; a file at
  the destination winning; rename carrying a detection, read back by a fresh
  index; a second request joining the run; a queued run cancelled at once; the
  running one **stopped in 7 ms, ffmpeg gone**, nothing cached, nothing failed;
  Find cuts starting it again; and a full run still working — 29 cuts in 33.9 s,
  cached under `_cache/cinema-canvas/shots`, covering all 177.41 s.
- `npm run build` clean; `npm run lint` 0 errors and the same 16 warnings.

tsc, not the harness, caught the worst bug: `SceneStore.load(path)` shadowed
`Component.load()`. `addChild` calls `load()` to run `onload`, so real Obsidian
would have skipped the store's vault listeners, while the shim's `Component` has
no `load` and every suite would have passed. The harness's own bug went the
other way: its fake `rmdir(path, false)` used `fs.rmSync`, which refuses any
folder, so the first run reported a migration failure the plugin did not have.

### Not done / not verified

- **Not run inside Obsidian.** The menu, the modal, the code block processor,
  the sticky scene headers and `leaf.updateHeader` (undocumented; called only if
  present) are only as right as the shim's idea of them.
- **No real two-hour film has been cut.** The scale test uses real detections
  repeated, and the 27-minute estimate is the measured rate extrapolated.
- **Inference still stutters the renderer** in bursts — for a film, half an hour
  of it. Running it out of process is still the fix, as it has been since v7.
- A file renamed while Obsidian is closed is not seen, so its caches stay under
  the old path. That is already the case for `cinema/4f6aef…-hd.mp4`, whose shot
  list was written as `cinema/the boys/…`: it will show as uncut.
- Two marks that snap to one cut hide the later one until the cuts change back,
  and nothing shows that it is there.
- The ribbon still re-renders per slider step: fine at 1281 blocks in jsdom,
  unmeasured in Obsidian.
- The strip shows neither scenes nor labels; only the cut view does.

## v11.1 — a scene is any set of cuts

v11 made a scene a run of consecutive cuts that divides the film. That was
wrong: "not consecutive, you see. it can be whatever combination of cut i want.
also scenes can overlap." Also asked for: a panel with the scenes, an add scene
button, dragging cuts into a scene, and two previews — only the chosen cuts, and
all the cuts with the chosen ones highlighted.

The v11 note format never reached a vault (no `.scenes.md` existed anywhere), so
it was replaced outright, with no migration.

### Decisions (locked)

- **A scene is `{id, title, cuts}`.** `cuts` holds one time inside each chosen
  cut: its **middle**, not its start. A start is the boundary itself, and a
  re-detection that moves it by a millisecond would put the time in the cut
  before. Each time shows whichever cut contains it now; two times that land in
  one cut after a retune show the cut once and are both kept.
- **Identity is a random six-character id**, not the title (which can repeat,
  change or be empty) and not a count (two devices would pick the same one).
  Tabs store it; the block rejects duplicates.
- **Order is the note's order** for scenes and film order for cuts inside one.
  Reordering by hand was not asked for.
- **Selection works like a file list.** A click plays and selects one card,
  `Ctrl`/`Cmd`-click toggles, `Shift`-click runs from the last click, and a right
  click outside the selection selects that card alone. An action with no
  selection applies to the cut under the playhead.
- **Dragging goes through a module variable, not `dataTransfer`.** The browser
  hides a drag's data until drop, so a row could not light up while cuts are
  held over it. Times rather than indexes, so a drop into another tab resolves
  them against that tab's cut list.
- **Two previews in one scene tab**: *Its cuts* (the ribbon lays them end to
  end) and *All cuts* (the rest fade). In the film's tab, clicking a panel row
  gives the second preview without opening anything.
- **Deleting doesn't ask first; the notice offers Undo**, which puts the
  scene back where it was.
- **Cards are kept across edits** and updated in place (labels, scene chips,
  highlight, selection). Rebuilding 1281 cards on every drop would lose the
  scroll position and ask for every still again.

### Tasks

- [x] `media/scenes.ts` — the new model: `shotAt`, `anchorOf`, `buildScenes`,
      `findScene`, `scenesWith`, `hasMember`, `scenesByShot`, `labelsByShot`,
      `playRanges` (adjacent cuts joined, so a scene plays through them without
      a pause), `newSceneId`; edits `addScene`, `addCuts`, `removeCuts`,
      `renameScene`, `deleteScene`, `restoreScene`; strict parsing of the new
      block
- [x] `view/clip-view.ts` — scene panel; selection; drag and drop between cards,
      rows, New scene and another tab; *Its cuts* / *All cuts*; scene playback
      in sequence; cut menu and `N` `A` `Delete` `V` `P` `Esc`; bands and scene
      sections removed
- [x] `view/scene-picker.ts` — `FuzzySuggestModal` for "Add to a scene…"
- [x] `view/scene-block.ts` — lists scenes with their cut counts, opening by id
- [x] `main.ts` — `openClip(file, sceneId?)`
- [x] `styles.css` — panel, rows, drop targets, selection, highlight fade, chips,
      the mode switch; the panel goes under the grid in a narrow tab
- [x] README

### Verified

- **Scene model**, 42 checks: non-consecutive and overlapping scenes; scenes
  following a re-cut; times past the end hidden; `hasMember` against `includes`
  over every index; `labelsByShot` identical to `labelsIn` for every cut,
  including a label 0.4 ms before a boundary; adjacent cuts joined for playback;
  an add of a cut already present (by another time inside it) returning the same
  object; remove dropping every time inside the cut; undo restoring position;
  round trip; ten kinds of malformed block, including duplicate and missing ids.
- **Scene store**, 19 checks, on the new format.
- **Cut view** in jsdom, 1281 cuts, 119 checks:
  - Selection: click, Ctrl, Cmd, Shift from the anchor, Esc.
  - A scene of three scattered cuts made with `N`, stored by their middles and
    highlighted at once.
  - A Shift-selection dragged onto New scene; an overlap giving one card two
    chips.
  - An unselected card dragged onto a row without disturbing the selection; a
    duplicate drop adding nothing.
  - The menu listing "Remove from" for both scenes; the picker adding two cuts;
    `A` and New scene….
  - Labels edited with the card element unchanged.
  - Highlight moving between rows; rename; delete and Undo byte-for-byte.
  - A broken note refusing a drop.
  - The scene tab: only its cuts, and the playhead placed along the joined
    ribbon and hidden outside it. Scene playback jumps the gap and stops at the
    end. Stepping wraps; state is stored by id.
  - A card dragged from the film's tab into the scene tab, and the scene tab
    refusing its own cards; the × and `Delete`.
  - *All cuts* with `A`, and `V` back; a panel row switching the tab to another
    scene; a deleted scene's tab.
  - A slider re-cut clearing the selection while scenes keep their cuts; hiding
    the panel remembered in state; a film rename carrying the note.
- `npm run build` clean; `npm run lint` 0 errors, the same 16 warnings.
- The TransNetV2 / ShotIndex suite was not re-run: nothing it covers changed.

### Not done / not verified

- **Still not run inside Obsidian.** Native drag and drop in Electron, the
  fuzzy picker, `Notice` with a fragment, `createFragment`, the container query
  and `requestSaveLayout` are only as right as the shim's idea of them. Drag
  events in the tests are synthetic, with a fake `dataTransfer`.
- Scene colours follow a scene's position in the note, so deleting one shifts
  the colours of those after it.
- No reordering of scenes, and no custom order of cuts inside a scene.
- A scene whose cuts all fall past the end of a re-detected film shows 0 cuts
  and doesn't say why.

## v11.2 — one view per film, and the scenes beside the cards

v11.1 spent a tab on every scene and a full-height column on the scene panel.
Both were wrong: "i don't want the side bar for scenes like that. i don't want a
separate tab for each scene. when i fullscreen, show all the existing controls -
timeline, clip, scene. the sidebar for scene, it doesn't take up vertical space -
it's within the controls below, not the whole right side. there's also the
default of No Cut."

### Decisions (locked)

- **One film is one tab.** A scene is something the view *shows*, not something
  it opens. `openClip(file, scene)` reveals the film's existing tab and tells it
  which scene to show; the tab keeps the film's name and the film icon.
- **No Cut is the first row of the list**: the whole film, nothing picked. It is
  where the view starts, what `Esc` and the film button go back to, and what
  clicking the shown scene's row again returns to. Its swatch is an outline, not
  a colour.
- **The list stands in the band under the ribbon**, beside the grid
  (`.cine-clip-below`), so the player and the ribbon keep the whole width and
  lose none of their height to it. Under 640px it drops below the cards.
- **Full screen takes the view's root**, not the picture, so the ribbon, the
  cards and the scenes are all still there — the same trick the sound view
  already used, minus its hiding of the header and lists.
- **The picked scene is the highlight.** `focusId` is gone: `mode: 'all'` means
  the scene's cuts stand out among all of them, `mode: 'only'` means only its
  cuts are shown. A scene just made is shown in *All cuts*, which is where
  seeing what went into it is worth something.
- **A scene deleted under a view falls back to No Cut** rather than to a
  placeholder explaining that its tab has lost its subject.

### Tasks

- [x] `view/clip-view.ts` — the layout band, the No Cut row, `selectScene`,
      the row tools without "open in a tab", "Show X" in the cut menu,
      full screen over the root, `Esc` back to the film
- [x] `main.ts` — `openClip` reuses the film's tab and sets its scene
- [x] `styles.css` — `.cine-clip-below`, the No Cut swatch, the panel width,
      the `:fullscreen` rules, the container query
- [x] README and the keys table

### Verified

- **Cut view**, 126 checks (was 119), including: the top-level layout is
  header / stage / ribbon / below, with the list and the grid inside the last;
  No Cut present and picked from the start, naming the film's cut count; a new
  scene picked in this view with nothing opened in a tab; two `Esc` presses
  going selection → whole film; a row clicked twice going back to No Cut; the
  cut menu offering *Show* rather than *Open*; a scene deleted in another view
  dropping this one back to No Cut; `F` handing the *view root* to the
  Fullscreen API, not the stage.
- **Scene model** 42 and **scene store** 19 unchanged: the note format did not
  change in this round.
- `npm run build` clean; lint 0 errors, the same 16 warnings.
- Re-render of 1281 cuts with nothing changed: 45 ms in jsdom.

### Not done / not verified

- Still not run inside Obsidian: the reveal-and-retarget path in `openClip`,
  the `:fullscreen` rules, and native drag and drop.
- Picking a scene keeps whichever mode the switch was left on, so the first
  click after a fresh open shows *Its cuts*. Only a scene just made forces
  *All cuts*.
- Scene colours still follow position in the note; deleting one shifts the rest.
- No reordering of scenes, and no custom order of cuts inside one.

## v11.3 — one tab for the cuts and the sound, and a header that repeats nothing

> "i need you to merge audio view and cut scene into 1 tab, just have a switch.
> the scene rename and back to whole movie control is redundant, remove, and the
> play at the top as well. each scene has its own play already (add the same
> controls to No Cut). now the analyze button that is shown in cinema canvas, add
> it to the fullscreen view as well, separate and more highlighted."

### Decisions

- **One file is one tab.** The cuts and the sound are two questions about the
  same file at the same moment, so they are two halves of one tab sharing one
  player and one playhead, with a switch in the header. `CinemaSoundView` is
  deleted; `VIEW_TYPE_CINEMA_SOUND` is no longer registered.
- **The sound half is a pane, not a view.** `sound-view.ts` became
  `sound-pane.ts`: it owns the lanes, the lists and the run, and is given two
  rows the tab makes for it in the tab's own order. It never owns the player,
  the header or the summary.
- **The pane is built lazily**, the first time the switch is thrown, and kept
  after that. A film whose sound is never asked about costs nothing.
- **An audio file has no cuts half**, so it has no switch: `openSound` on an
  mp3 lands on the sound half of a tab that only has one.
- **The header repeats nothing a row does.** Play, rename and back-to-the-film
  are gone from it; the scene row already carries the first two, and No Cut the
  third. No Cut now carries the same play button every scene row has, and it
  plays the whole film.
- **The one big button is set apart and accented.** `.cine-clip-cta` sits behind
  a rule at the end of the header: Find cuts on an uncut film, Download models
  or Analyse sound on the sound half, Stop while either runs. It is in the
  header rather than only in the panel because full screen keeps the header and
  the panel is the first thing a bigger player pushes off the screen.
- **Full screen is now one rule for both halves.** The old
  `.cine-sound-view:fullscreen` block hid the header and the lists; that view no
  longer exists, and `:not(.cine-sound-view)` is gone from the clip view's rule.

### Tasks

- `src/view/sound-pane.ts` new, `src/view/sound-view.ts` deleted.
- `clip-view.ts`: `half` in the state, the switch, the CTA, the sound half's
  render, No Cut's play, the sound branch of `onKeyDown`, `onResize`, the
  `is-audio` stage, `css-change` and `fullscreenchange`.
- `main.ts`: `openClip` and `openSound` share one `reveal`, which retargets the
  file's existing tab instead of opening another.
- `styles.css`: `.cine-clip-cta`, `.cine-sound-slot:empty`, one full-screen rule.

### Verified

- **Cut view**, 142 checks (was 126), including: both halves in the header with
  a dot on the one never run; the sound half taking the tab while the *same*
  `<video>` is kept — one player, not two; the lanes row filled in place; the
  accented button standing on its own; the header keeping the switch and full
  screen on the sound half; the cards and the ribbon as they were on the way
  back; No Cut carrying a play button that runs the film from its first cut
  without picking a scene; and the header no longer carrying play, pencil or
  film while a scene is shown.
- **Scene model** 42 and **scene store** 19 unchanged.
- `npm run build` clean; lint 0 errors, the same 16 warnings.
- Re-render of 1281 cuts with nothing changed: 47 ms in jsdom.

### Not done / not verified

- Still not run inside Obsidian. The lanes in particular are only proved inert
  in jsdom: nothing is analysed there, so `drawLanes` never runs. The stub can
  lie — a real film has to be switched to and drawn.
- A saved layout holding a `cinema-sound` leaf now opens on nothing, because the
  type is no longer registered. 0.11.0 never shipped, so no migration was
  written.
- The pane measures its canvases when the half is first shown; `setHalf` calls
  `onResize` for that. Whether one frame is enough in Electron is untested.
- `itemForFile` still reports `kind: 'video'` for an mp3. Nothing on the sound
  half reads it, but it is wrong.

### Nothing plays where you are not looking

> "when i click elsewhere in cinema canvas, or when i switch tab, pause the
> current video if playing."

Two rules, in three views:

- **The canvas.** `onClick` stops the playing cell unless the click landed on
  that same cell — the background, a folder header, and another cell all stop
  it, a still image as readily as a clip. Clicking the playing cell still
  toggles, which is how you pause it by hand. Before this, only clicking
  *another clip* stopped the first one.
- **Leaving the tab.** Every view listens for `active-leaf-change` and acts
  when the leaf named is not its own. The film's tab pauses its player and
  keeps the frame (`pauseForNow`), so coming back and pressing space carries
  on. The canvas stops its cell, which swaps the still back, and pauses the
  lightbox without closing it (`Lightbox.pauseForNow`).

Why pause rather than tear down: a two-hour file holds a decoder and a
soundtrack, and the playhead, the cut under it and the scene shown are all
worth keeping. Only the canvas cell is stopped outright, because a cell that
is not playing *is* its still.

**Verified:** cut view 142 checks (was 137), the five new ones covering a film
playing, an event naming this same tab leaving it alone, leaving the tab
pausing it, the frame kept, and coming back not starting it again. The test's
workspace stub now keeps its handlers so the event can be fired at all; before
this it threw every one away. Build clean, lint 0 errors / 16 warnings.

**Not verified:** the canvas has no jsdom suite, so its click rule and its
leaf-change handler are read but not run. `active-leaf-change` also fires when
a sidebar leaf takes focus, so clicking the file explorer pauses the film as
well as switching tab does — wanted here, but it is a wider rule than "switch
tab".

### One command to clear, not three

> "my commands, merge all the clear into 1"

**Clear thumbnail cache**, **Clear sound analysis** and **Clear detected shots**
became one entry: **Clear cached data**. It opens a picker
(`src/view/cache-picker.ts`) offering **Everything** first, then the three
caches. The palette went from eight commands to six.

The choice is kept rather than folded into one blunt command, because the three
cost wildly different amounts to make again, and each line in the picker says
which:

- Thumbnails — made again as you look at them.
- Detected shots — about 27 minutes per two-hour film.
- Sound analysis — about 5 seconds per minute of audio.

Losing a film's cut list because you wanted to rebuild its stills is the
failure this avoids. **Everything** runs the three in order rather than at once:
three cache folders rewritten in parallel is the one way to make it slower than
it has to be. A failure is reported in the notice instead of being swallowed.

**Verified:** build clean, lint 0 errors / 16 warnings. Cut view 142, scene
model 42, scene store 19 — all unchanged, as expected: `main.ts` is type-only
in the test bundle, so no suite reaches the palette. No reference to the three
old ids or titles is left in `src/` or the README.

**Not verified / cost:** not run in Obsidian, and nothing tests the palette at
all. The three old command ids are gone, so **any hotkey bound to one of them
is dropped** and has to be set again on the new command.

### Cut and re-cut from the cut view

> "add the button to cut/recut to the cut view in the main clip tab"

The cuts half now carries one button that runs the network, in the same slot
the sound half puts **Analyse sound**: last in the header, behind a rule, in the
accent colour, with an icon.

| The film | The button | What it does |
| --- | --- | --- |
| uncut | **Find cuts · TransNetV2** | `renderFindCuts`, as before, moved into the CTA slot |
| cut | **Re-cut** | `detect(item, true)` — the network again, from the frames |
| running | **Stop** | `shots.cancel(item)` |

Two icons went, because the button replaced them rather than joining them: the
`square` stop and the `refresh-cw` re-detect. The re-detect was also hidden
whenever a scene was shown, which was the wrong rule — a scene is anchored to a
time in the film, not to a cut number, so it survives the film being cut again.
**Re-cut** is therefore offered whether or not a scene is on screen.

The tooltip says both halves of the price: about 27 minutes for two hours, and
that scenes and labels are kept. It also points at the sliders, which change how
the film is cut without running anything at all.

`renderCta` grew an optional icon (`sparkles`, `square`) and a `data-cta`
attribute naming the button, which is what the tests read.

**Verified:** cut view 146 checks (was 142). The four new ones: a cut film
offers **Re-cut**, accented and alone; it replaced the refresh icon rather than
joining it; it is still offered while a scene is shown; and **Stop** is the
accented button during a run, with no `square` icon left in the header. The
uncut check now also proves **Find cuts** sits inside the CTA slot. Build clean,
lint 0 errors / 16 warnings.

**Not verified / open:** not run in Obsidian. **Re-cut** starts at once, with no
confirmation — the same as the old icon did, but it is a much easier button to
hit now. The sound half is left asymmetric: re-analysing is still a small
`refresh-cw` icon, not a **Re-analyse** button beside **Re-cut**.

## v11.4 — tags, and a scenes half to file scenes by them

> "add me tags for each scene, also a separate scene view. let me organize by
> tags - this scene is over the counter, that scene is action with a lot of
> rapid cuts, those scenes are shot and counter shot, 2 shot, ensemble, ...
> make a list of tags that is add/removable - all within the same view."

### Decisions

- **A third position on the switch, not a tab.** "Separate scene view" but "all
  within the same view": Cuts | Scenes | Sound, one player. `ViewHalf` gained
  `'scenes'`; the leaf state records `half: 'scenes'`.
- **A scene has any number of tags.** Stored as `tags: string[]` on the scene in
  the film's note, written only when non-empty so older notes are unchanged by
  their next edit. Case-insensitive: "Two shot" and "two shot" are one tag.
- **One tag list for every film**, in settings (`sceneTags`), because shot
  grammar is not particular to a film. Seeded with ten common ones. Tags a
  film's note uses that are not on the list are shown too, in italics.
- **Organised = grouped.** One group per tag, Untagged first; a scene with two
  tags is in two groups. Drag scene → tag and tag → scene both *add*; the chip
  × removes. Nothing moves a scene out of a group by dragging.
- **Removing a tag from the list** strips it from this film's scenes (undo in
  the notice) and does not rewrite other films' notes.
- "Over the counter" read as over the shoulder; seeded as **Over the shoulder**.

### Verified

- Tag model, 16 checks in `scratchpad/tags.test.ts`: old notes parse with no
  tags and write back without a `tags` key; add/remove, case-insensitive no-ops,
  blank tags ignored; round trip through the note; `removeTagEverywhere` leaves
  untouched scenes identical; hand-edited duplicates and blanks cleaned; a
  non-text tag refused with an error rather than dropped.
- `npm run build` clean; lint 0 errors, the same 16 warnings.

### Not done / not verified

- **No DOM run at all.** The jsdom harness from the v11 sessions is gone from
  the scratchpad, so the board, the drag and drop, the + menu and the switch
  are type-checked only. Not run in Obsidian either.
- No renaming or reordering of tags in the view (removal's undo puts a tag
  back in its old place, which is the only reordering there is).
- The settings tab does not show the tag list; it is edited only in the view.
