# HeartMuLa publication staging

The model card is [heartmula-model-card.md](heartmula-model-card.md).
[heartmula-hf-manifest.json](heartmula-hf-manifest.json) inventories every file
in the active `models/heartmula/` folder with its exact size and SHA-256.
No repository has been created and no file has been uploaded by this slice.

## Exact upload set

The 123 entries whose `upload` field is true are the complete weight upload
list, at root-level repository paths. They total 150,260,222,528 bytes,
about 139.94 GiB. The three `*-quant-manifest.json` source files are recorded
for inventory completeness but excluded from upload because they contain
machine-local build paths. The publication manifest records the final weight
hashes without those paths.

Upload these metadata files too:

| Local file under `docs/dev/` | Repository path |
|---|---|
| `heartmula-model-card.md` | `README.md` |
| `heartmula-hf-manifest.json` | `manifest.json` |
| `heartmula-LICENSE` | `LICENSE` |
| `heartmula-NOTICE` | `NOTICE` |

## Command after approval

Lead must obtain approval for this exact upload first. The destination must
already exist as the approved `scragnog/HeartMuLa-GGUF` model repository.
The commands below are a plan, not evidence of publication. Run from the repo
root with `ACESTEPCPP_MODELS` resolved to the active models folder. Resolve it
with `cd server; npx tsx scripts/data-paths.ts`, then return to the repo root.

```powershell
hf upload scragnog/HeartMuLa-GGUF "$env:ACESTEPCPP_MODELS/heartmula" . --include "*.gguf"
hf upload scragnog/HeartMuLa-GGUF docs/dev/heartmula-model-card.md README.md
hf upload scragnog/HeartMuLa-GGUF docs/dev/heartmula-LICENSE LICENSE
hf upload scragnog/HeartMuLa-GGUF docs/dev/heartmula-NOTICE NOTICE
hf upload scragnog/HeartMuLa-GGUF docs/dev/heartmula-hf-manifest.json manifest.json
```

Before running, compare every source file against the committed inventory and
stop if a name, byte count or hash has changed. After publication, run
`node server/scripts/check-release-prereqs.mjs`, remove pending-upload labels
from the registry and UI, and verify a HeartMuLa download through the app.
Until publication, HF returns a missing-file error; a repository that has not
been created can answer 401 rather than 404. Do not mistake that for a need
to provide a token.

## Component gaps

The scalar decoder remains F16 and RVQ remains F32 because the current
quantizer has no 2-D matrices to reduce in either, as documented in
[the component contract](../../engine/docs/HEARTMULA_CONTRACT.md).
A duplicate file labelled Q8_0 would save no space. The four-file encoder
pack is available at F16. Q8_0 encoder files and a separate scalar encoder
are absent locally, so no invented sizes or registry entries are supplied.

## Other backends

ACE-Step 1.5, MiniMax-Music3 and YuE2 retain their existing source repositories
and download paths. Stable Audio 3 already has its GGUFs in
[the StableStep repository](https://huggingface.co/scragnog/HOT-Step-CPP-StableStep)
and its training base in
[the Medium Base repository](https://huggingface.co/scragnog/Stable-Audio-3-Medium-Base-GGUF).
The registry now groups both under Stable Audio 3. These are already hosted;
this change requires no SA3 re-hosting. Their model cards declare the
Stability AI Community License. License acceptance remains required in the
manager, including for starter packs.
