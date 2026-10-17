# Compare

Side-by-side listening for takes you already generated. Put two or more songs in a session, play them against one shared playhead, flip between them instantly, and score each one. Use it for seed sweeps, plugin A/B tests and checkpoint ladders, anywhere you need to hear small differences fairly.

## Where to find it

The "Compare" entry in the sidebar (`/compare`). From the Library you can also select two or more songs and press **Compare**, which opens a new session with those songs picked.

## Workflow

1. Press **New comparison**, search the library (results come a page at a time) and tap songs to pick them. The first pick is the baseline.
2. Give it a name and, optionally, a group. Sessions with the same group are listed together.
3. Press **Compare N songs**. The session opens and each take is analysed in the background.
4. Press play (or Space). Tap a take, or press 1 to 9, to switch which one you hear; the playhead does not move. The A/B button (or B / Tab) flips between the last two takes you heard.
5. Drag across any waveform to loop a region, or use **In** and **Out** while playing. **Clear loop** removes it.
6. Turn on **Level match** so every take plays at the loudness of the quietest one.
7. Score each take: 1 to 5 per criterion, a keep switch and a note. A session archives itself once every take is scored.

## Controls

| Control | What it does |
|---|---|
| Show archived | Lists fully scored sessions too. |
| Unscored chips | Quick links to sessions that still need scores. The dot is green for scored, amber for partial, grey for unscored. |
| Seek bar | Shared playhead for all takes, with the loop region shaded. |
| A/B button | Flips between the take you are hearing and the one you heard before it, at the same playhead. The button shows which takes are A and B (for example A: 1 / B: 2), and the take rows carry matching A and B badges. Until you pick a second take, A is the baseline and B is the next take. Keys: B or Tab. |
| Level match | Gains every take down to the quietest integrated loudness, so loudness alone does not win. |
| Metric chips | Integrated LUFS, short-term max, true peak (red above 0 dBTP), RMS, crest, spectral centroid, flatness, stereo correlation. |
| Difference trace | Active take against the baseline over time: loudness difference in LU and log-spectral distance in dB. |

## Tips and limits

- Score with level match on. A louder take nearly always sounds better at first.
- Analysis runs on first open of each song and is cached after that.
- Removing a take or deleting a session never deletes the song from the library.
