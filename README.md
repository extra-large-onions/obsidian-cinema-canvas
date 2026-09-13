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
Only TransNetV2 and the sound view need it — everything else works without it.

It has to be loaded with `require`, and by **absolute path**. Obsidian evaluates
`main.js` in the renderer, so the `require` in scope is Electron's, and its
resolution paths are rooted at Obsidian's own program directory: a bare
`require('onnxruntime-node')` walks up from there, never looks inside the plugin
folder, and fails with `MODULE_NOT_FOUND`. The plugin folder is resolved through
`FileSystemAdapter.getFullPath`, and `loadOrt` in `src/media/onnx.ts` loads the
runtime from `<plugin>/node_modules/onnxruntime-node`. A dynamic `import()` fails a
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
    shots.ts            detection queue, candidate cache, pure shot building
    transnet.ts         TransNetV2 inference over an ffmpeg rawvideo pipe
    onnx.ts             onnxruntime-node loader and session cache, shared
    sound.ts            sound analysis queue, cache, pinned model download
    sound-analysis.ts   Silero VAD + PANNs + loudness over one decode; lanes
    audioset-labels.ts  the 527 AudioSet class names PANNs scores
  view/
    canvas-view.ts      the ItemView: virtualized render, selection, controls
    layout.ts           pure layout: groups -> packed world rects
    viewport.ts         pan/zoom camera and input
    spatial-index.ts    bucket grid for visibility queries
    media-cell.ts       one cell: element, thumbnail request, hover preview
    shot-strip.ts       the sticky bottom strip: cuts and sound, as two tabs
    shot-controls.ts    cutting sliders + Find cuts, shared by both shot views
    clip-view.ts        one tab per clip: player, rhythm ribbon, segment grid
    segment-player.ts   frame-accurate segment playback, shared by every player
    sound-view.ts       one tab per file: dialogue, music, effects, silence lanes
    sound-lanes.ts      lane colours and canvas drawing, shared by strip + view
    lightbox.ts         full-screen viewer
```

## License

0-BSD

## The strip

Select a clip and the **strip** appears along the bottom of the view, with two
tabs over one body — the two questions worth asking about a clip you are looking
at from the outside:

- **Cuts** — one thumbnail per cut, scrolling sideways, with the clip's shot
  count, average shot length, and its shortest and longest shot in the header.
  Under each thumbnail is where that shot starts and how long it runs.
- **Sound** — the same four lanes the sound view draws, across the whole clip.
  Hover to read a moment, click to play from there.

Each tab carries a **dot** when its own side has never been run for this clip, so
you can see there is nothing there without switching to find out. Whichever side
is empty offers the one button that fills it: **Find cuts**, or **Analyse
sound**. Both tabs also carry the button that opens the same thing in a tab of
its own, for when the strip is too small for what you are looking at.

The canvas above never changes — it stays one cell per file, so "which file is
this" and "what is inside it" stay two separate questions.

Clips are never split on disk. A shot is a start and end time against the
original file, so a 40-shot scene is one file and forty seeks. As everywhere else
in this plugin, nothing is written to the vault: shot lists cache to
`<plugin folder>/shots/`, keyed by path + size + mtime, so they survive restarts
and invalidate themselves when you re-export.

| Action | Mouse | Key |
| --- | --- | --- |
| Play one shot in its canvas cell | click a strip item | `Shift+←` `Shift+→` |
| Open one shot full screen | double-click a strip item | — |
| Show or hide the strip | toolbar | `S` |
| Switch between cuts and sound | the two tabs in the strip | — |
| Find the cuts, or analyse the sound | the button on the empty tab | — |
| Re-run either one | the refresh button in the strip | — |
| Change how the clip is cut | the two sliders in the strip header | — |
| Open the clip's own tab | the segments button in the strip header | — |
| Open the clip's sound tab | the waveform button in the strip header | — |

**ffmpeg** must be on your system for both halves — TransNetV2 reads its frames
through it, and the sound analysis reads its audio the same way. Leave **ffmpeg
path** empty to use whatever is on `PATH`, and use **Check** to confirm it runs.
This is why the plugin is desktop-only.

The cutting parameters live in the strip header, not in settings, because the
strip is their readout — you drag and the shots under your hand rearrange:

- **Confidence** (5–95%) is how sure TransNetV2 has to be that a frame is a cut.
  50 is what its authors use. The network is decisive, so this moves the count
  much less than its range suggests — on the reference clip 5% gives 88 shots
  and 75% gives 58.
- **Min shot** ignores a cut that falls too soon after the one before it, which
  is what stops a single dissolve becoming three shots.

**Both of them re-cut the clip instantly.** The network is asked once for every
frame scoring at least 1, and the confidence is applied to that cached list
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

Segments stop **on their own last frame**, in every player — the clip view, the
lightbox, and a canvas cell. The boundary is judged once per presented frame
with `requestVideoFrameCallback`, not on `timeupdate`, which Chromium fires about
every 250 ms: checked that way, the same 82 segments ran on for 4 frames of the
next shot on average and 8 at worst.

The same sliders and the same Find cuts button are in this view's header, doing
the same thing. Changing a parameter here re-cuts the clip without touching the
player, which is the point: the frame stays where it is while the cuts around it
move.

| Action | Mouse | Key |
| --- | --- | --- |
| Play a segment | click a card or a ribbon block | — |
| Next / previous segment | — | `←` `→` or `j` `k` |
| Play or pause | the player's own controls | `Space` |
| Repeat the segment | the loop button | `L` |
| Full screen player | the expand button | `F` |

### Why ffmpeg no longer finds the cuts

Earlier versions offered a second detector: ffmpeg's `scdet` filter, which
compares each frame to the one before it and scores how much that difference
*changed*. It was about fourteen times faster, and it was dropped anyway.

Scoring the change rather than the difference is what let it ignore steady
camera movement — a long pan differs a lot from frame to frame, but by a
consistent amount. What it could not see was a dissolve, because no single frame
across one differs much from its neighbour. What it saw that was not there was
movement sharp enough to look like a change in the rate of change: a handheld
jolt, a whip pan, a muzzle flash. On the reference clip that was 21 false cuts,
all of them inside three handheld passages. There was no second algorithm inside
ffmpeg to switch to — the older `select='gt(scene,X)'` form is the same
computation on a 0–1 scale, and finds a strict subset of the same cuts.

A strip you have to eyeball is worth less than one you can trust, so the choice
itself was removed rather than left as a faster wrong answer. ffmpeg is still
required — it decodes the frames TransNetV2 reads, and the audio the sound view
reads.

**Cache files written by the old detector are ignored**, not migrated: `scdet`
scored frames 1–20 and the network scores probability × 100, so reading one at
the network's 50% confidence would quietly report a feature film as a single
take. A clip that was only ever cut with ffmpeg shows as uncut until TransNetV2
runs on it.

### How TransNetV2 detects cuts

TransNetV2 reads 100 frames at a time, scaled down to 48×27, and returns a
probability per frame that it is a transition. Every frame is judged with 25
frames of past and 25 of future around it, which is why it can tell a cut from a
camera move: it has seen what happens either side. It was trained on labelled
cuts, so it answers the question directly instead of inferring it from a
frame-difference statistic.

On the 370-second reference clip, measured against `scdet` at sensitivity 4
while both detectors still existed:

- It confirmed **62** of ffmpeg's 82 cuts.
- It **rejected 21**, every one of them inside three handheld passages.
- It **added 3** that ffmpeg had scored too low to reach.
- It found no dissolves, because that clip has none — the model can see them,
  this footage just does not use them.

So on hard-cut material it is a false-positive filter rather than a source of
extra cuts. That difference is why it is now the only detector.

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

## Sound

The shot views ask where the picture changes. The **sound view** asks what you
are hearing: where the score comes in, how long a scene goes without a line,
where the mix drops out. It is built for whole films, which are usually not on
the canvas at all, so it opens from anywhere a file is:

- right-click any video or audio file → **Open in sound view**
- **Open current file in the sound view** in the command palette
- the waveform button on the strip's Sound tab, or in the clip view

The strip's Sound tab draws the same lanes for a clip you are looking at on the
canvas. This view is what a whole film gets: the lanes to scale across the full
running time, a zoomable detail set under the playhead, and the lists.

A film's audio is one mixed track, so dialogue, music and effects are rarely
heard alone. Each is its own **lane**, and any number can be on at once.

| Lane | From | Judged every |
| --- | --- | --- |
| Loudness | RMS level | 100 ms |
| Dialogue | Silero VAD, a dedicated speech detector | 32 ms |
| Music | PANNs CNN14, its music and singing classes | 1 s, over 2 s |
| Effects | PANNs, anything audible that is neither of the above | 1 s, over 2 s |
| Silence | quieter than the threshold for at least 0.5 s | 100 ms |

The tab holds the player, the **whole film** as one strip of lanes, a **detail**
set of lanes following the playhead (scroll over it to zoom from 10 s to 30 min),
and three lists: music cues, silences over a second, and stretches of 30 s or
more without dialogue. Hovering the lanes names the three sounds PANNs was most
sure of at that second. Click a lane or a list row to jump there.

| Action | Key |
| --- | --- |
| Play / pause | `Space` |
| Back / forward 5 s (30 s with `Shift`) | `←` `→` |
| Zoom the detail lanes | `+` / `-`, or scroll |
| Full screen, lanes and all | `f` |

The **expand** button, or `f`, takes the whole view full screen: the player takes
the room the header and the lists were using, and the lanes stay under it. The
player's own full screen button is the browser's, and shows only the picture — a
fullscreened video element sits above everything else in the compositor, so
nothing can be drawn over it.

**Three sliders** — silence level, dialogue confidence, music confidence — live in
the header and re-label the film instantly: the readings are cached, not the
lanes, exactly as shots cache candidates rather than cuts.

### Models

Two networks run on this machine, downloaded once into `<plugin>/models/` from
the **Download models** button the view shows the first time (330 MB, about 40 s
on a fast connection):

- **Silero VAD v6.2.1** (2.3 MB, MIT), from the authors' repository
- **PANNs CNN14, 16 kHz** (327 MB, MIT; Kong et al., 2020), an ONNX export
  published on Hugging Face as a graph plus external weights

Both URLs are pinned to a fixed revision, and each file is streamed to disk and
only installed if its size and SHA-256 match the exact files the analysis was
verified with. A mismatch installs nothing.

### Speed and accuracy

Measured on a 185 s test track of known content — synthesised speech, digital
silence, solo piano, rain and thunder, gunshots, and speech over piano at −12 dB:

- **175 of 185 seconds** labelled exactly right at the default thresholds. Most
  misses were real pauses between sentences, which the lanes call silence and the
  hand-written truth did not; three were piano too quiet under the speech to
  register.
- **14 s** of wall time on the CPU, which is about **9 minutes for a two-hour
  film**. The CPU is used rather than DirectML on purpose: the runs are small,
  and a 2 s window measured 42 ms on the CPU against 298 ms through the GPU.
- The cache is about **0.6 MB per two-hour film**, in `<plugin>/sound/`, keyed by
  path + size + mtime. Re-labelling a two-hour film for a slider takes about 6 ms.

The first audio track is analysed, which on a film with a commentary is the main
mix. **Clear sound analysis** is a command.
