# HOTSTEP-342 baseline evidence

Timing and logged scalar repeatability are measured. **The slice is blocked:**
the A4 fixture is missing, so its replay and a tensor-gradient tolerance cannot
be supplied for Reviewer acceptance. B must not start from this report alone.

## Revisions and protocol

Baseline parent `1ca695cc73cb5570d99052cd5f00830d01dab15e`; comparison parent
`7652d959ca1f17ddd33a26784548e404085d0a30`, captured as local master at task start.
Both use clean ggml `6d57c78a2c749cd7d9d58c2f7bd3178729171584`.
Later concurrent master commits, including attention reuse, are not measured here.
MacServer only. No production edits, Windows GPU work, pushes or releases.

Original HOTSTEP-338 argv and model/input hashes are archived. Each arm uses a
fresh seed-42 init and the same six-song dataset, full AR context, rank 64,
companion, optimizer and KL settings. Only output directory, step cap, save
cadence and preview pause change. Baseline ordinary seven-step runs passed three
times. Each revision then has three matched warm-song measurements: one full
seven-step sequence and two one-step repeats. Runs are grouped by revision,
not interleaved. See `results.json` for every timing and full-precision loss.

## Metric and timing

The ordinary first step includes cache-fill work. A diagnostic wrapper calls
the unchanged runtime twice in one process, first for one warmup update and then
with fresh model, adapter, optimizer and RNG state. Pipeline and frozen-teacher
caches survive. The warm baseline compiles zero additional pipelines and uses
2,528 BF16 GEMMs rather than 2,724. This is the matched warm-song metric required
by the parent plan, not an optimization saving. All seven warm-run losses and
gradient norms equal the ordinary baseline exactly.

Baseline warm seconds: **36.133547, 35.453133, 35.366556**. Median **35.453133 s**.
Spread is maximum minus minimum, **0.766990417 s**. Three times spread is
**2.300971251 s**. This proposal awaits Reviewer acceptance with the numeric gates.

Captured-master warm seconds: **35.846569, 35.650270, 35.615361**. Median
**35.650270 s**, spread **0.231208291 s**, median delta **+0.197138 s**.
This is a control with unchanged production sources. No speed gain or regression
is established by a difference this small.

The ordinary baseline first steps were 41.180014, 40.716133 and 40.724110 s,
median 40.724110 s and spread 0.463880876 s. The historical 40.8 s figure
reproduces, but is not the selected warm-song metric.

The full measured warm sequences follow. Losses and gradient norms are identical
between revisions; full-precision values are in `results.json`.

| Update | Baseline warm s | Captured master warm s | AR CE | NAR MSE | KL | Gradient norm |
|---|---|---|---|---|---|---|
| 1 | 36.134 | 35.847 | 5.772480878 | 1.217101485 | 0 | 0.123408541 |
| 2 | 45.047 | 45.109 | 5.863287221 | 1.237981920 | 0.000442632 | 0.125031038 |
| 3 | 82.390 | 82.295 | 4.376926734 | 0.877772738 | 0.000431848 | 0.090175342 |
| 4 | 52.656 | 52.622 | 4.203646537 | 0.902860446 | 0.000670208 | 0.089750939 |
| 5 | 42.698 | 42.784 | 4.017974430 | 1.242763772 | 0.000763822 | 0.091958349 |
| 6 | 26.367 | 26.369 | 5.699079020 | 1.041303273 | 0.001736564 | 0.105855706 |
| 7 | 51.999 | 51.933 | 5.920067774 | 1.173319216 | 0.004319192 | 0.103834331 |

Peak process RSS in the full warm runs was 16.285 GiB for both revisions,
including retained caches. Ordinary baseline peak was 15.060 GiB. This is not
isolated GPU allocation telemetry.

## Numeric gates and blocker

All logged AR CE, KL, NAR MSE and gradient norms are identical at every matched
update, with maximum observed absolute difference zero. This does not prove
sampled tensor-gradient repeatability or justify a nonzero split-K tolerance.
Those limits remain unset in `gates.json` pending the fixture and review.

Historical A4 limits are preserved: step-one loss/flow/AR CE relative error at
most 0.5%; each sampled B-gradient relative L2 below 3%; each sampled post-update
B relative L2 below 5%. Exact copy/rounding changes still require bitwise equality.
No threshold was loosened and no A4 pass is claimed.

The documented `.scratch/ruach-parity/fixtures` and `a4_gates.py` are absent.
Searches of the local project tree, prior scratch locations and both WSL home/temp
trees found no `onestep.json`, replay inputs or gate script. Restore the original
inputs and reference tensor outputs, run baseline A4 repeats, then obtain Reviewer
acceptance of the loss/gradient tolerance and metric before B.

## Verification and evidence

The Mac mirror was synced from a local git bundle. `engine/build-mac.sh` passed,
then `cmake --build engine/build --target ace-train` passed for the comparison.
The warm wrapper compiled with C++17/O3 against the selected trainer libraries.
All nine probe invocations exited 0, covering 45 updates including warmups.
Python compilation and `node tools/docs/check-docs.mjs` passed; the latter reports
11 existing missing screenshot warnings. No package suites were run for this
probe-only change.

At completion no trainer process remained; the worker was idle and the existing
dev stack reported engine ready. That stack retained its baseline startup
revision; the standalone comparison trainer used the rebuilt captured revision.

Non-Metal proof: this slice changes only tooling/report files. The two measured
revisions differ only in Metal test device selection, with identical production
sources and the same ggml pin. CUDA/CPU/Vulkan runtime checks were not run.

Private raw logs, exact argv JSON, source worker log, binary hashes and input
hashes are preserved under `.scratch/hs342/` locally and `.probe-logs/hs342/` on
MacServer. The latter also retains all generated adapters. Public numeric evidence
is `results.json`; the proposal and unresolved gates are `gates.json`. Public
argv substitutes private paths only; the archived argv retains the originals.
