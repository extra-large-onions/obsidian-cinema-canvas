# Cinema Canvas

An Obsidian plugin that scans the vault for stills and short clips and lays them
out on a zoomable canvas — **one group per folder** — for reviewing
cinematography practice footage.

The canvas is generated from the live file index, not from a stored `.canvas`
document, so it is always current. What the plugin does write into the vault is
kept to two places: rebuildable caches under `_cache/cinema-canvas/`, and one
note beside each film you give scenes or labels to.

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

**Clear cached data** is a command if you ever need to force a rebuild; choose
**Thumbnails** from the list it offers.

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
Only TransNetV2 and the sound analysis need it — everything else works without
it.

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
    scenes.ts           scenes and cut labels: pure model, and the note's block
    scene-store.ts      reads and writes the scene note beside each film
    vault-cache.ts      _cache/cinema-canvas/ in the vault, and the move there
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
    clip-view.ts        one film, one tab: ribbon, grid, scene list, and the
                        switch to the scenes and sound halves
    scene-board.ts      the scenes half: the tag list, and scenes filed by tag
    scene-picker.ts     the searchable "add to a scene" list
    scene-block.ts      draws a scene note's block in reading view
    text-prompt.ts      one-line prompt for scene titles and cut labels
    segment-player.ts   frame-accurate segment playback, shared by every player
    sound-pane.ts       the sound half of that tab: lanes, lists, and the run
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
- **Sound** — the same four lanes the sound half draws, across the whole clip.
  Hover to read a moment, click to play from there.

Each tab carries a **dot** when its own side has never been run for this clip, so
you can see there is nothing there without switching to find out. Whichever side
is empty offers the one button that fills it: **Find cuts**, or **Analyse
sound**. Both tabs also carry the button that opens the same thing in a tab of
its own, for when the strip is too small for what you are looking at.

The canvas above never changes — it stays one cell per file, so "which file is
this" and "what is inside it" stay two separate questions.

Clips are never split on disk. A shot is a start and end time against the
original file, so a 40-shot scene is one file and forty seeks. Shot lists cache
to `_cache/cinema-canvas/shots/` in the vault — the folder this vault already
gitignores as rebuildable — keyed by path + size + mtime, so they survive
restarts and invalidate themselves when you re-export. Renaming or moving a clip
inside Obsidian carries its shot list over instead of throwing it away. Caches
written into the plugin folder by earlier versions are moved there on startup.

| Action | Mouse | Key |
| --- | --- | --- |
| Play one shot in its canvas cell | click a strip item | `Shift+←` `Shift+→` |
| Open one shot full screen | double-click a strip item | — |
| Show or hide the strip | toolbar | `S` |
| Switch between cuts and sound | the two tabs in the strip | — |
| Find the cuts, or analyse the sound | the button on the empty tab | — |
| Re-run either one | the refresh button in the strip | — |
| Change how the clip is cut | the two sliders in the strip header | — |
| Open the clip in the cut view | the cuts button in the strip header | — |
| Stop finding cuts | the stop button while it runs | — |
| Open the clip's sound half | the waveform button in the strip header | — |
| Stop what is playing | click any other cell, a folder header, or the background | — |
| Stop what is playing | switch to another tab | — |

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

### The cut view

The strip is for navigating one clip while the rest of the vault is still on
screen. When the clip — or a whole film — is the subject, give it a tab of its
own:

- right-click any video in the file explorer → **Open in cut view**, whether or
  not the canvas scans that folder,
- **Open current file in the cut view** in the command palette,
- the cuts button in the strip header, or **Open selected clip in the cut view**.

The tab holds:

- **the player**, which you can scrub anywhere — seeing what surrounds a cut is
  most of the point,
- **the ribbon**, where each cut is drawn as wide as it is long. This is the
  only place shot length is to scale, so a run of quick cuts reads as a dark
  stretch, and a two-minute held take looks like the wall it is,
- **the grid**, one card per cut, to select from and drag out of. Cards are all
  the same size on purpose: here a cut is a thing to click, and the ribbon
  already showed you which is which,
- **the scene list**, beside the grid: **No Cut**, meaning the whole film, and
  then every scene of it. It stands next to the cards rather than down the side
  of the tab, so the player and the ribbon keep the full width and none of
  their height goes to it. Every row plays what it names — No Cut plays the
  film, a scene plays its own cuts, one after another,
- **the switch**, which turns the same tab to the **sound half**: the same
  file, the same player, the other question.

The header carries nothing a row already does. A scene is played, renamed and
deleted from its own row, and left by clicking No Cut, so none of those is a
button at the top as well.

All of them share one playhead. Click a cut anywhere and the rest follow; scrub
the player past a cut and the highlight moves with it. Clicking a cut confines
playback to it — it repeats or pauses at its last frame, depending on the loop
button — and scrubbing out of it releases that.

Segments stop **on their own last frame**, in every player — the clip view, the
lightbox, and a canvas cell. The boundary is judged once per presented frame
with `requestVideoFrameCallback`, not on `timeupdate`, which Chromium fires about
every 250 ms: checked that way, the same 82 segments ran on for 4 frames of the
next shot on average and 8 at worst.

The same sliders are in this view's header, doing the same thing, and so is the
button that runs the network: **Find cuts** on a film with none, **Re-cut** on
one already cut, **Stop** while it runs. It is the accented button at the end of
the header, set apart from the icons by a rule, in the same place the sound half
puts **Analyse sound** — and the header survives full screen, so the run can be
started from across the room. Re-cutting keeps every scene and label: both are
anchored to a time in the film, not to a cut number. Changing a parameter re-cuts the film without touching the player, which
is the point: the frame stays where it is while the cuts around it move. While a
slider is being dragged only the ribbon follows; the cards are rebuilt when you
let go, because a film has well over a thousand of them.

#### A whole film

A two-hour film comes to roughly 1,300 cuts at the default confidence — measured
by repeating the reference clip's real detections twenty times end to end. The
view is built for that:

- **Find cuts says how long it will take** before you press it — about 27
  minutes for two hours, at the measured rate of 83 s per 370 s — and while it
  runs the header shows the percentage and the time left.
- **It can be stopped**, from the header or the strip. ffmpeg is killed at once
  (measured: 7 ms), nothing is cached and nothing is marked failed, so Find cuts
  starts it again from the beginning. Asking twice joins the run already going
  rather than queuing another half hour behind it.
- **Stills are only made for cards near the screen**, and a card scrolled away
  before its still arrives withdraws the request. Every still is a seek into the
  film; making all of them up front would be an hour of seeking before the first
  one you could see.
- **Renaming or moving the film inside Obsidian keeps everything**: its shot
  list, its sound readings and its scene note all follow it.

Obsidian still stutters in short bursts while TransNetV2 runs, because inference
happens in Obsidian's own process. Moving it out of process is the next thing to
fix.

#### Scenes and labels

A **scene** is any set of cuts you choose, with a name. The cuts need not be next
to each other, and one cut can be in as many scenes as you like, so a scene is a
grouping you make — every shot of one character, one location, every insert —
rather than a division of the film. A **label** is a line of text on one cut —
"close-up", "insert", a character's name.

**Choosing cuts.** Click a card to play it and select it. `Ctrl`-click (`Cmd`
on a Mac) adds or removes a card, and `Shift`-click selects the run from the
last card clicked. `Esc` clears the selection. With nothing selected, an action
applies to the cut under the playhead.

**Making and filling scenes.**

- **New scene** at the top of the panel, or `N`, makes a scene of the selected
  cuts, or an empty one to fill later.
- **Drag** cards onto a scene in the panel to add them, or onto New scene to
  make a scene of them. Dragging a selected card drags the whole selection.
- Right-click a card for **New scene from…**, **Add to a scene…** (a searchable
  list, also `A`), **Remove from** each scene it is in, and **Label this cut**
  (also `T`; save it empty to remove the label).
- Every card shows a coloured bar for each scene it is in; hover the bars for
  their names.

**The list.** The first row is **No Cut**: the whole film, with nothing picked,
which is where the view starts and the way back. Below it each scene shows its
name, its number of cuts and how long it plays. Hover a row to **play** the
scene, **rename** it (or double-click its name) or **delete** it. Deleting
doesn't ask first; the notice it shows has an **Undo** button, and deleting a
scene never touches the cuts themselves.

**Showing a scene.** Click its row and this view shows it — a film is one tab,
never a tab per scene, so the player keeps playing and the list stays where it
is. Click the same row again, click No Cut, or press `Esc` to come back to the
whole film. The switch at the top, or `V`, chooses between two ways of showing
the scene:

- **Its cuts**: only the scene's cuts, laid end to end on the ribbon so it reads
  as the scene plays. Each card has a remove button, and `Delete` removes the
  selected cuts.
- **All cuts**: the whole film with the scene's cuts highlighted and the rest
  faded, for seeing where they fall and picking more — select cards and press
  `A`. A scene you have just made is shown this way.

In both, **play** (`P`) plays the scene's cuts one after another, skipping what
lies between them, and `←` `→` step through them. Open the film in a split pane
if you want two of these side by side; cards drag between them.

#### Tags: the Scenes half

The switch in the header has a third position, **Scenes**, between Cuts and
Sound. It keeps the player and swaps what is under it for every scene of the
film, **filed under tags**: over the shoulder, shot / counter shot, two shot,
ensemble, action, rapid cuts, and whatever else you add.

- **The tag list** stands on the left. It is one list for every film — a two
  shot is a two shot everywhere — and it starts with a handful of common ones.
  Type into **Add a tag** and press Enter to add one; the **×** on a row takes
  it off the list and off this film's scenes, with an undo in the notice.
  Clicking a tag shows only its scenes; clicking it again, or `Esc`, shows all.
- **The board** has one group per tag, with **Untagged** first while anything is
  left in it. A scene with two tags is in both groups: a tag is a way to find a
  scene, not a place it lives.
- **Tagging.** Drag a scene onto a tag (a group or a row in the list), drag a
  tag onto a scene, or use the **+** on a scene card, which lists every tag with
  a tick on the ones it has, plus **New tag…**. Right-click does the same. The
  **×** on a chip takes that tag off. Dragging adds and never moves, so to
  re-file a scene, add the new tag and take the old one off.
- Click a card to **play** the scene; double-click it, or its film button, to
  show its cuts on the Cuts half. Each scene's tags also show under its name in
  the Cuts half's list.

Which scene carries which tag is saved in the film's scene note, as a `tags`
list on the scene. Taking a tag off the shared list does not open other films'
notes: they keep it, and show it in italics as *not on your list* the next time
you look, where the same **×** takes it off them too. Tags are one tag whatever
their case.

Both scenes and labels are anchored to **times, never to cut numbers**. A cut's
number is only its position in a list the confidence slider rebuilds, so "cut
412" names a different frame after a retune. A scene stores the middle of each
of its cuts, and shows whichever cut contains that time now, so scenes follow
the cuts when you re-cut. A label shows on whichever cut contains its time, so
raising the confidence until its cut disappears moves it onto the cut that
swallowed it instead of losing it.

They are saved in a **note beside the film**, named after it: `Heat.mkv` keeps
its scenes in `Heat.mkv.scenes.md`. It is an ordinary note — it syncs and
versions with the vault, survives clearing every cache, and reads fine without
the plugin. The plugin owns one fenced block in it and leaves everything else
alone, so write whatever you like around it:

````
```cinema-scenes
{
  "scenes": [
    {"id":"k2f9qa","title":"The Marquis","tags":["Two shot"],"cuts":[12.5,1705.8,3310.25]},
    {"id":"0xw3b1","title":"Stagecoach","cuts":[12.5,40.1]}
  ],
  "labels": [
    {"at":12.5,"text":"close-up"}
  ]
}
```
````

Each scene has an `id`, which is how the view finds it, so a scene can be renamed
freely. Its `cuts` are times in seconds, one inside each cut; its `tags`, if it
has any, are text. If you write the
block by hand, give each scene an id made of letters, digits, `-` or `_`, used by
no other scene.

In reading view the block is drawn as a list of scenes; clicking one opens the
film in the cut view and shows that scene there.
In editing view it stays JSON and can be edited by hand. If a hand edit leaves it
unreadable, the cut view says so in its header and **refuses to save anything**
until it is fixed, rather than overwriting it.

| Action | Mouse | Key |
| --- | --- | --- |
| Play a cut, and select it | click a card or a ribbon block | — |
| Add or remove a card from the selection | `Ctrl`-click / `Cmd`-click | — |
| Select a run of cards | `Shift`-click | — |
| Clear the selection, then go back to the whole film | — | `Esc` |
| Next / previous cut | — | `←` `→` or `j` `k` |
| Play or pause | the player's own controls | `Space` |
| Repeat the cut or scene | the loop button | `L` |
| Label the cut | right-click a card → Label this cut | `T` |
| New scene from the selection | New scene in the panel, or drag cards onto it | `N` |
| Add the selection to a scene | drag cards onto the scene, or right-click → Add to a scene… | `A` |
| Remove from a scene | right-click → Remove from…, or the × on a card while its scene is shown | `Delete` while a scene is shown |
| Show a scene in this view | click its row in the list | — |
| Back to the whole film | click No Cut | `Esc` |
| Its cuts / all cuts, for the scene shown | the switch in the header | `V` |
| Play the whole scene | the play button on its row | `P` |
| Play the whole film | the play button on No Cut | — |
| Rename a scene | the pencil on its row, or double-click its name | — |
| Delete a scene | the bin on its row | — |
| Cuts or sound | the switch in the header | — |
| Show or hide the scene list | the list button | — |
| Full screen, keeping every control | the expand button | `F` |
| Pause the film, keeping the frame | switch to another tab | — |

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
required — it decodes the frames TransNetV2 reads, and the audio the analysis
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
fight the UI for the same cores — and any run can be stopped. The refresh button
in the strip forces a fresh decode; you only need it if the file itself changed.

Playing a shot from the strip plays only that shot and stops at the cut. In the
full-screen viewer, playback is confined to the shot but scrubbing is not —
seeing what surrounds a shot is usually the point of opening it big.

## Sound

The cuts ask where the picture changes. The **sound half** asks what you are
hearing: where the score comes in, how long a scene goes without a line, where
the mix drops out.

It is the other half of the film's own tab, not a tab of its own. Both questions
are about the same file at the same moment, so they share one tab, one player
and one playhead, and a switch in the header moves between them. A dot on the
switch marks the half that has never been run for this file. It opens from
anywhere a file is:

- right-click any video or audio file → **Open in sound view**
- **Open current file in the sound view** in the command palette
- the waveform button on the strip's Sound tab

Any of them reveals the file's tab and turns it to the sound half; none of them
opens a second tab. A file with no picture — an mp3 — has no cuts half, and so
no switch.

The strip's Sound tab draws the same lanes for a clip you are looking at on the
canvas. The tab is what a whole film gets: the lanes to scale across the full
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
- The cache is about **0.6 MB per two-hour film**, in the vault's
  `_cache/cinema-canvas/sound/`, keyed by path + size + mtime, and it follows a
  file renamed inside Obsidian. Re-labelling a two-hour film for a slider takes
  about 6 ms.

The first audio track is analysed, which on a film with a commentary is the main
mix. **Clear cached data** is a command; choose **Sound analysis** from it.
