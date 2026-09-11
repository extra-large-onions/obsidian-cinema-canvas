# Cinema Canvas

An Obsidian plugin that scans the vault for stills and short clips and lays them
out on a zoomable canvas — **one group per folder** — for reviewing
cinematography practice footage.

Nothing is written to the vault. The canvas is generated from the live file
index, not from a stored `.canvas` document, so it is always current.

## Opening it

Ribbon icon (clapperboard), or **Open canvas** in the command palette.

## Scanning

- **Folders** — comma-separated, recursive, e.g. `src/, archive/2024`.
  Leave empty to scan the whole vault.
- Images: png, jpg, jpeg, gif, webp, avif, bmp, svg, tif, tiff, heic, heif
- Video: mp4, mov, webm, mkv, m4v, avi, ogv
- Both lists can be extended in settings.

Reconciliation happens in two ways:

- a **full scan** on startup (after the workspace is ready) and whenever a
  scanning setting changes — it reads Obsidian's in-memory file list, so it
  never walks the disk;
- **incremental patches** from vault events (`create` / `delete` / `rename` /
  `modify`), which is what covers dragging files in, deleting them, or an
  external tool writing into the vault while Obsidian is open. Events are
  coalesced through a 150 ms debounce, so dropping 200 stills triggers one
  relayout rather than 200. Folder renames and folder drops trigger a resync,
  because Obsidian does not emit per-child events for those.

**Rescan vault for media** is available as a command and a toolbar button if
you ever want to force it.

## Grid

Each cell is a fixed box — `item size` (height, default **720p**) × the chosen
aspect ratio — and the media is fitted inside without cropping, so the grid
stays regular whatever the source dimensions are. A folder wraps to a new row
after `max columns per group`; groups are then packed left to right into a
roughly square canvas.

## Performance

Hundreds of camera stills cannot be put on a canvas as `<img src=original>`: a
6000x4000 frame decodes to roughly 96 MB of bitmap, so a few hundred of them is
several gigabytes, and a `<video>` per clip exhausts the browser's decoder pool.
So the grid draws proxies instead.

- **Tiered thumbnails** at 256 / 640 / 1440 px wide, WebP, written to
  `<plugin folder>/thumbs/` and keyed by path + size + mtime. They survive
  restarts and invalidate themselves when you re-export a shot.
- The cell picks the smallest tier that covers its current on-screen size. If
  that one is cold but a smaller one is warm, the smaller shows immediately and
  is swapped when the sharper one lands. Zoom in past 1440 px and the original
  file is used, because at that point you actually want it.
- **Clips rest as a single extracted frame** (seeked ~10% in, to skip black
  leader). A `<video>` exists only for the cell you are hovering and the one
  clip you clicked to play — see below.
- Generation is a **priority queue, 2 at a time**, ordered by distance from the
  viewport centre; a cell that scrolls away cancels its own job. Queue depth is
  shown in the status strip.
- Cells are **recycled by path**, capped at 600 live, and built 40 per frame, so
  a big pan never blocks. Visibility is a bucket-grid query rather than a scan.
- Undecodable files (HEIC on Chromium, truncated exports) are attempted once and
  then left as a stub until the next rescan.

First open of a cold vault pays one decode per file to build the cache. That
happens in the background; afterwards it is essentially free.

**Clear thumbnail cache** is a command if you ever need to force a rebuild.

## Playing clips

Clips play **in the grid**, not in an overlay. Click one and its still is swapped
for a real `<video>`; click again — or let it reach the end — and it swaps back
to the still. That is the whole interaction: **click to play, pause to go back.**
`Space` does the same thing to whatever is selected.

There are no native video controls on the cell, so a click anywhere on it always
means play/pause; a thin progress bar runs along the bottom while it plays.
Scrubbing, volume and a proper timeline live in the full-screen viewer
(double-click, or `F`), which stops any inline playback when it opens.

If **play clips on hover** is on, hovering starts a muted, looping scrub. Click
during it and that same element is promoted to real playback with sound, keeping
its position rather than restarting. Only one clip plays at a time — starting
another stops the previous one.

## Controls

| Action | Mouse | Key |
| --- | --- | --- |
| Pan | drag background, middle-drag, wheel, one-finger drag | — |
| Zoom | ctrl/⌘ + wheel, pinch | `+` / `-` |
| Fit all | double-click background | `0` |
| Select | click a cell | `←` `→` `↑` `↓` `Home` `End` |
| Play a clip in place | click it | `Space` |
| Zoom to current | toolbar | `Z` |
| Zoom to parent folder | click a folder header | `Shift+Z` |
| Full screen | double-click a cell | `F` / `Enter` |
| Next / previous in full screen | on-screen arrows | `←` `→` |
| Native full screen | expand button in the viewer | `F` |
| Close viewer | click the backdrop | `Esc` |

Every navigation action is also a command, so you can bind your own hotkeys
under **Settings → Hotkeys**.

## Development

```bash
npm install
npm run dev     # watch
npm run build   # typecheck + production bundle
npm run lint
```

Release artifacts are `main.js`, `manifest.json` and `styles.css`.

`onnxruntime-node` is a runtime dependency, not a bundled one: it is a native
N-API addon, so `node_modules/onnxruntime-node/` has to stay next to `main.js`.
Only TransNetV2 needs it — everything else works without it.

It has to be loaded with `require`, and by **absolute path**. Obsidian evaluates
`main.js` in the renderer, so the `require` in scope is Electron's, and its
resolution paths are rooted at Obsidian's own program directory: a bare
`require('onnxruntime-node')` walks up from there, never looks inside the plugin
folder, and fails with `MODULE_NOT_FOUND`. `ShotIndex.runtimeDir()` resolves the
plugin folder through `FileSystemAdapter.getFullPath`, and the runtime is loaded
from `<plugin>/node_modules/onnxruntime-node`. A dynamic `import()` fails a
second way: esbuild leaves it as a real ESM import, which the renderer resolves
against the page URL.

## Source layout

```
src/
  main.ts               plugin lifecycle, commands, view registration
  settings.ts           settings interface, defaults, settings tab
  types.ts              MediaItem / MediaGroup / layout boxes
  media/
    extensions.ts       image + video extension table
    scope.ts            folder list -> recursive path matcher
    media-index.ts      live index + vault-event reconciliation
    thumbnails.ts       tiered, disk-cached proxy generation + priority queue
    shots.ts            detector queue, candidate cache, pure shot building
    transnet.ts         TransNetV2 inference over an ffmpeg rawvideo pipe
  view/
    canvas-view.ts      the ItemView: virtualized render, selection, controls
    layout.ts           pure layout: groups -> packed world rects
    viewport.ts         pan/zoom camera and input
    spatial-index.ts    bucket grid for visibility queries
    media-cell.ts       one cell: element, thumbnail request, hover preview
    shot-strip.ts       the sticky bottom strip: one scrolling row of shots
    shot-controls.ts    cutting sliders + detector buttons, shared by both views
    clip-view.ts        one tab per clip: player, rhythm ribbon, segment grid
    lightbox.ts         full-screen viewer
```

## License

0-BSD

## Shots

Select a clip and the **shot strip** appears along the bottom of the view: one
thumbnail per cut, scrolling sideways, with the clip's shot count, average shot
length, and its shortest and longest shot in the header. Under each thumbnail is
where that shot starts and how long it runs.

An uncut clip gets **two Find cuts buttons** instead, because there are two
detectors and they are good at different things:

| | ffmpeg | TransNetV2 |
| --- | --- | --- |
| What it is | the `scdet` filter | a small neural network |
| Speed, per 6 min of 720p | ~6 s | ~80 s |
| On the reference clip | 82 cuts | 62 cuts |
| Fooled by | handheld movement, flashes | much less |
| Needs | nothing extra | a 31 MB model file |

Once both have run on a clip the two buttons become a switch: the one that is not
showing swaps in instantly, because the candidates for both are cached side by
side. The header says whose cuts you are looking at.

The canvas above never changes — it stays one cell per file, so "which file is
this" and "where in the file is this" stay two separate questions.

Clips are never split on disk. A shot is a start and end time against the
original file, so a 40-shot scene is one file and forty seeks. As everywhere else
in this plugin, nothing is written to the vault: shot lists cache to
`<plugin folder>/shots/`, keyed by path + size + mtime + detector, so they
survive restarts and invalidate themselves when you re-export.

| Action | Mouse | Key |
| --- | --- | --- |
| Play one shot in its canvas cell | click a strip item | `Shift+←` `Shift+→` |
| Open one shot full screen | double-click a strip item | — |
| Show or hide the strip | toolbar | `S` |
| Switch detector, or run the other one | the two buttons in the strip | — |
| Re-run the current detector | the refresh button in the strip | — |
| Change how the clip is cut | the two sliders in the strip header | — |
| Open the clip's own tab | the segments button in the strip header | — |

- **ffmpeg** must be on your system for either detector — TransNetV2 still reads
  its frames through it. Leave **ffmpeg path** empty to use whatever is on
  `PATH`, and use **Check** to confirm it runs. This is why the plugin is
  desktop-only.
The cutting parameters live in the strip header, not in settings, because the
strip is their readout — you drag and the shots under your hand rearrange:

- **Sensitivity** (ffmpeg, 1–20) is how far a frame must differ from the one
  before it. Lower finds more cuts and more false ones. Expect to tune it per
  title.
- **Confidence** (TransNetV2, 5–95%) is how sure the network has to be. 50 is
  what its authors use. The network is far more decisive than `scdet`, so this
  moves the count much less — on the reference clip 5% gives 88 shots and 75%
  gives 58.
- **Min shot** ignores a cut that falls too soon after the one before it, which
  is what stops a single dissolve becoming three shots. It applies to both.

Only the threshold of the detector currently showing is offered; the other one
would change a list that is not on screen.

**Every one of them re-cuts the clip instantly.** Each detector is asked once for
every frame scoring at least 1, and the threshold is applied to that cached list
afterwards — so tuning is a slider, not a re-scan. Verified: the cached candidate
list and a full per-frame dump produce identical shot lists at every threshold
above the floor.

### The clip view

The strip is for navigating one clip while the rest of the vault is still on
screen. When the clip itself is the subject, the segments button in the strip
header (or **Open selected clip in the segment view**) gives it a whole tab:

- **the player**, which you can scrub anywhere — seeing what surrounds a cut is
  most of the point,
- **the ribbon** under it, where each segment is drawn as wide as it is long.
  This is the only place shot length is to scale, so a run of quick cuts looks
  like a run of quick cuts, and a two-minute held take looks like the wall it is.
- **the grid**, one card per segment, wrapping over the full width instead of
  scrolling sideways. Cards are all the same size on purpose: here a segment is
  a thing to click, and the ribbon already showed you which is which.

All three share one playhead. Click a segment anywhere and the other two follow;
scrub the player past a cut and the highlight moves with it. Clicking a segment
confines playback to it — it repeats or pauses at its last frame, depending on
the loop button — and scrubbing out of it releases that.

The same sliders and detector buttons are in this view's header, doing the same
thing. Changing a parameter here re-cuts the clip without touching the player,
which is the point: the frame stays where it is while the cuts around it move.

| Action | Mouse | Key |
| --- | --- | --- |
| Play a segment | click a card or a ribbon block | — |
| Next / previous segment | — | `←` `→` or `j` `k` |
| Play or pause | the player's own controls | `Space` |
| Repeat the segment | the loop button | `L` |
| Full screen player | the expand button | `F` |

### How ffmpeg detects cuts

ffmpeg has exactly one cut detector and exactly one knob on it. The `scdet`
filter compares each frame to the one before it, takes the mean absolute
difference of the luma plane, and scores the frame on how much that difference
*changed*. Scoring the change rather than the difference is what makes it ignore
steady camera movement — a long pan differs a lot from frame to frame, but by a
consistent amount.

The older `select='gt(scene,X)'` form is the same computation on a 0–1 scale
instead of 0–100, and the cuts one finds are a strict subset of the other's.
There is no second algorithm inside ffmpeg to switch to.

What it cannot see is a dissolve, because no single frame across one differs much
from its neighbour. What it sees that is not there is camera movement sharp
enough to look like a change in the rate of change — a handheld jolt, a whip pan,
a muzzle flash.

### How TransNetV2 detects cuts

TransNetV2 reads 100 frames at a time, scaled down to 48×27, and returns a
probability per frame that it is a transition. Every frame is judged with 25
frames of past and 25 of future around it, which is why it can tell a cut from a
camera move: it has seen what happens either side. It was trained on labelled
cuts, so it answers the question directly instead of inferring it from a
frame-difference statistic.

On the 370-second reference clip, against `scdet` at sensitivity 4:

- It confirmed **62** of ffmpeg's 82 cuts.
- It **rejected 21**, every one of them inside three handheld passages.
- It **added 3** that ffmpeg had scored too low to reach.
- It found no dissolves, because that clip has none — the model can see them,
  this footage just does not use them.

So on hard-cut material it is a false-positive filter rather than a source of
extra cuts. That is still the difference between a strip you can trust and one
you have to eyeball.

It needs a 31 MB ONNX file, downloaded once from Hugging Face with the
**Download** button in settings, into `<plugin folder>/models/`. Inference runs
locally through `onnxruntime-node`, on DirectML if your GPU supports it and on
the CPU otherwise — DirectML was measured 3.7× faster here, with identical
output. Nothing about your vault leaves the machine.

Detection runs one clip at a time — it is a full decode, and anything more would
fight the UI for the same cores. The refresh button in the strip forces a fresh
decode; you only need it if the file itself changed.

Playing a shot from the strip plays only that shot and stops at the cut. In the
full-screen viewer, playback is confined to the shot but scrubbing is not —
seeing what surrounds a shot is usually the point of opening it big.
