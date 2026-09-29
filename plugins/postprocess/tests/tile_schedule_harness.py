"""Standalone check of md_audio_tiled tile schedules (needs: pip install lupa).
Seam = any tile boundary strictly inside (0, W). PASS needs: coverage exactly
[0, W), no seam when W <= max_single, equal tiles (len spread <= 1) otherwise,
every tile <= max_single."""
import os, sys, lupa
here = os.path.dirname(os.path.abspath(__file__))
lua = lupa.LuaRuntime()
core = lua.execute(open(os.path.join(here, "..", "md_audio_tiled_core.lua"), encoding="utf-8").read())
mode = sys.argv[1] if len(sys.argv) > 1 else "new"
TILE, OV, MAX = 4096, 192, 15000
nan = float("nan")
cases = [("very short 10f", 10, MAX, OV), ("total<=tile 3000", 3000, MAX, OV),
         ("164s 4100", 4100, MAX, OV), ("user 4622", 4622, MAX, OV),
         ("exactly max", MAX, MAX, OV), ("max+1", MAX + 1, MAX, OV),
         ("2.5x max", 37500, MAX, OV), ("overlap>=tile", 20000, MAX, 99999),
         ("NaN params", 4622, nan, nan), ("zero params", 4622, 0, 0)]
fails = 0
for name, W, mx, ov in cases:
    if mode == "old":
        s = core.build_fixed_schedule(W, TILE, OV, 0); lim = mx if mx == mx and mx >= 16 else MAX
    else:
        s = core.build_auto_schedule(W, mx, ov); lim = mx if mx == mx and mx >= 16 else MAX
    tiles = [(s[i].start, s[i].end_) for i in range(1, len(s) + 1)]
    lens = [e - b for b, e in tiles]
    covered = tiles[-1][1] - tiles[0][0] if tiles else 0
    seams = [b for b, _ in tiles[1:]]
    ok = tiles[0][0] == 0 and tiles[-1][1] == W and all(tiles[i][0] < tiles[i-1][1] for i in range(1, len(tiles)))
    if W <= lim: ok = ok and not seams
    else: ok = ok and max(lens) - min(lens) <= 1 and max(lens) <= lim
    fails += not ok
    print(f"{'PASS' if ok else 'FAIL'} {name:18s} W={W:6d} tiles={len(tiles)} lens={lens} seams@{seams} covered={covered}")
print(f"{mode}: {fails} FAIL")
sys.exit(1 if fails else 0)
