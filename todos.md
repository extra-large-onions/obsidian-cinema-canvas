# Todo

## Test in Obsidian
Most features were checked only by type check or a jsdom stub, never in the app.
- [ ] Lighting readout: panel, edge-light tracing, face setting and download, live update while playing, and in the film tab (placement over the letterbox, hidden on the sound half)
- [ ] Light zones and spot loupe: hover dimming, A/B pins, zones clearing while a clip plays
- [ ] Depth and haze: download, the Zones / Depth switch, the worker thread keeping Obsidian responsive (falls back to the main thread if Electron refuses the worker), a real hazy frame
- [ ] Framing guides: thirds, center, triangle, aspect mask
- [ ] Frame marks: draw, move, text, undo, one-frame marks landing on their frame, the track, saving to the note
- [ ] Scenes half: drag and drop, tag board, + menu, switch
- [ ] Sound lanes: switch to the sound half on a real film and see them draw
- [ ] Canvas: click-to-stop and pause on tab change
- [ ] Clear cached data picker
- [ ] Cut a real two-hour film end to end
- [ ] Sound analysis on a real film, with music under dialogue
- [ ] Dissolves: find footage with dissolves, see if TransNetV2 catches them

## Film analysis
### Composition
- [ ] Golden spiral / phi grid on the guide layer. Easy.
- [ ] Shot size: label each shot ECU, CU, MS, WS… from face size. Needs a face model.
- [ ] Headroom: mark the eyes, show their distance to the top third line.
- [ ] Saliency: heatmap of where the eye goes first.

### Blocking and staging
- [ ] Pose: stick figures on each person.
- [ ] Movement trails: each person's path across one shot.
- [ ] Depth layers: near, middle, far. Deep vs. flat staging.
- [ ] 180° line / eyelines: flag cuts that cross the line.

### Camera and editing
- [ ] Shot length graph: average shot length per scene. Uses existing cuts. **Next.**
- [ ] Cuts vs. sound: do cuts land on dialogue, music or silence? Uses existing data. **Next.**
- [ ] Camera move type: static, pan, tilt, push, handheld. Optical flow.

### Study tools
- [ ] A/B wipe: two shots side by side, slider between.
- [ ] Frame marks in the film tab (`clip-view.ts`), same `MarkLayer`.
- [ ] Frame marks on stills: no time, so key them by file.
- [ ] Frame marks track view: one row per layer, drag a mark's ends to change its range.
- [ ] Frame length is measured while playing; a clip opened paused assumes 24 fps until it plays.
- [ ] Reference board: frames from many films in one group.

### Lighting
- [ ] Key/fill ratio per shot, plotted across the film.
- [ ] Haze was checked on frames fogged by hand, not real ones; the Shining corridor's lit far wall reads as a surface, not haze.
- [ ] Key height (above / level / below): dropped for now, hats and hair fooled it.
- [ ] Backlit, hazy faces are missed (Rachael in the Blade Runner blinds shot).
- [ ] Edge light also marks lit face edges in dark rooms and neon; flat scenes (Parasite) get a few false marks.

### On hold: color
- [ ] Waveform, false color, vectorscope
- [ ] Palette per shot, movie barcode, scene color script

## Performance
- [ ] TransNetV2 inference blocks the UI in bursts (~30 min for a film). Run it
      out of process: `process.execPath` + `ELECTRON_RUN_AS_NODE=1` + a worker script.
- [ ] Thumbnails are made on the main thread. Move to a Web Worker.
- [ ] Slider drags re-render every strip cell and ribbon block. Reuse cells by index.
- [ ] Strip re-renders on any `ShotIndex` change, even for another clip.

## Cuts and scenes
- [ ] Strip has no playhead: the active shot follows clicks, not the video.
- [ ] Sensitivity preview: show the shot count while dragging the slider.
- [ ] **Re-cut** starts with no confirmation. Add one.
- [ ] Two marks that snap to one cut hide the second, with no sign.
- [ ] A scene whose cuts all fall past the end after a re-cut shows 0 cuts and no reason.
- [ ] Scene colors follow note order; deleting one shifts the rest.
- [ ] No reordering of scenes, or of cuts inside a scene.
- [ ] First click on a scene after opening shows *Its cuts*, not *All cuts*.
- [ ] Tags: no rename or reorder in the view; not shown in the settings tab.
- [ ] Strip shows no scenes or labels (only the film tab does).
- [ ] Ribbon: click plays the block; no exact seek to the click position.

## Sound
- [ ] Only the first audio track. Add a track picker.
- [ ] Re-analyse is a small icon; make it a **Re-analyse** button like **Re-cut**.
- [ ] Strip's sound tab has no silence slider (only the film tab does).
- [ ] `itemForFile` gives `kind: 'video'` for an mp3.

## Files and cache
- [ ] Caches are keyed by path: a rename re-analyses, and a rename while
      Obsidian is closed loses the cache (e.g. `cinema/4f6aef…-hd.mp4`).
- [ ] Model download shows no progress (`requestUrl` buffers 31 MB). Stream it.
- [ ] HEIC/HEIF shows a stub. Needs a wasm decoder.
- [ ] Old layouts with a `cinema-sound` leaf open empty.

## Grid
- [ ] Folder packing is one shelf pass; uneven folders leave gaps.

## Tests
- [ ] No automated tests. Start with the pure code: `layout.ts`, `scope.ts`,
      `buildShots`, `formatTimecode`.
