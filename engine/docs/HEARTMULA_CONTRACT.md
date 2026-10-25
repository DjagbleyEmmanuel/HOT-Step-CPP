# HeartMuLa engine contract

The `/heartmula/*` routes in `hot-step-server`, the generate request,
progress and cancel behaviour, and the GGUF metadata every HeartMuLa component
carries. The server backend and UI build against this page while the engine is
ported; the engine slices implement it. Where an implementation has to differ,
change this page in the same commit.

Status: contract only. No route below exists yet.

## Model

HeartMuLa is autoregressive. A 3B global transformer reads the prompt (tags,
one zero MuQ slot, lyrics) and predicts codebook 0 of each 80 ms audio frame; a
3-layer local decoder predicts codebooks 1 to 7 for that frame. HeartCodec turns
the 8 x 12.5 Hz codes into 48 kHz stereo: shared RVQ lookup, a flow-matching
transformer (Euler, 29.76 s chunks with overlap), then a scalar waveform
decoder. Generation stops at audio EOS (any codebook id 8193 or above) or at the
frame limit.

Components, each its own GGUF so each loads at its own quant:

| Role | Architecture (`general.architecture`) | Needed for text generation |
|---|---|---|
| `global` | `heartmula-global` | yes |
| `local` | `heartmula-local` | yes |
| `tokenizer` | `heartmula-tokenizer` | yes |
| `rvq` | `heartcodec-rvq` | yes |
| `flow` | `heartcodec-flow` | yes |
| `scalar-decoder` | `heartcodec-scalar-decoder` | yes |
| `scalar-encoder` | `heartcodec-scalar-encoder` | no, kept for later |
| `muencoder`, `wavlm`, `whisper`, `query` | `heartcodec-<role>` | no, `/heartmula/encode` only |

## Files and discovery

Files live in `<models>/heartmula/`, then `<models>/` (same search order as YuE2).
Names follow the converter:

```
heartmula-<variant>-<role>-<QUANT>.gguf   global, local       e.g. heartmula-3b-global-Q4_K_M.gguf
heartcodec-<role>-<QUANT>.gguf            codec and encoder   e.g. heartcodec-flow-Q8_0.gguf
heartmula-tokenizer.gguf
```

`<variant>` is the lower-cased `heartmula.variant` (`3b`, `3b-happy-new-year`).
`<QUANT>` is the text after the last `-` and is what the pickers show. Identity
always comes from the metadata below, never from the name: a renamed file is
still checked, and a file whose name and metadata disagree is listed with an
error and is not selectable.

Discovery runs at start-up and on `GET /heartmula/models?rescan=1`. It reads
headers only.

## Routes

All bodies are JSON. Errors are `{"error": "<message>", "code": "<code>"}`
with the status below. Field names are snake_case.

| Route | Purpose |
|---|---|
| `GET /heartmula/props` | Backend state: availability, residency, current pick, VRAM |
| `GET /heartmula/models` | Component catalogue with compatibility per file |
| `POST /heartmula/select-model` | Set the variant, per-role quants and the adapter |
| `POST /heartmula/warm` | Load the current pick for the LM phase. Idempotent |
| `POST /heartmula/unload` | Free every HeartMuLa buffer. Idempotent |
| `POST /heartmula/synth` | Queue a generation; returns the shared job id |
| `GET /heartmula/job?id=` | HeartMuLa progress detail and failure reasons |
| `GET /job?id=`, `GET /job?id=&result=1` | Shared coarse status and the WAV result |
| `POST /job?id=&cancel=1` | Shared cancel |
| `POST /heartmula/encode` | Audio to codes (encoder pack). 501 until the encoder lands |
| `POST /heartmula/imatrix` | Arm, disarm and save imatrix collection, as `/yue2/imatrix`. 501 until the quant slice |

There is no HeartMuLa-only cancel route: cancel is the shared
`POST /job?id=&cancel=1`, the same as ACE, MM3 and YuE2, so the Node queue's
existing cancel path works unchanged.

### `GET /heartmula/props`

```json
{
  "backend": "heartmula",
  "available": true,
  "synth_ready": true,
  "max_duration_s": 240,
  "context_length": 8192,
  "defaults": { "temperature": 1.0, "topk": 50, "cfg_scale": 1.5,
                "codec_steps": 10, "codec_guidance": 1.25, "duration_s": 120 },
  "selected": { "variant": "3B", "global": "Q8_0", "local": "Q8_0",
                "flow": "Q8_0", "scalar_decoder": "F16" },
  "requested": { "variant": "3B", "global": "Q8_0", "local": "Q8_0",
                 "flow": "Q8_0", "scalar_decoder": "F16" },
  "adapter": { "requested": "", "loaded": "", "scale": 1.0, "in_force": false },
  "resident": { "global": false, "local": false, "flow": false,
                "scalar_decoder": false, "rvq": false, "tokenizer": true },
  "encode_ready": false,
  "vram": { "resident_bytes": 0, "free_bytes": 6979321856, "reserve_bytes": 1610612736 },
  "errors": []
}
```

- `synth_ready`: the tokenizer, RVQ and one compatible file for each of
  `global`, `local`, `flow` and `scalar-decoder` are present and pass the
  checks below. The Node backend reports the backend up from this key alone, as
  with YuE2 and MM3. It is not a VRAM claim.
- `selected` is what is in force after fallbacks; `requested` is what
  select-model was last told. They differ when a requested file is missing.
- `defaults` are heartlib's own defaults; the UI resets to them.
- `errors` lists discovery and compatibility problems as plain sentences.

### `GET /heartmula/models`

```json
{
  "variants": ["3B", "3B-happy-new-year"],
  "components": {
    "global": [ { "type": "Q4_K_M", "filename": "heartmula-3b-global-Q4_K_M.gguf",
                  "bytes": 2050000000, "variant": "3B", "file_type": 15,
                  "base_fingerprint": "<hex>", "compatible": true, "error": "" } ],
    "local": [], "flow": [], "scalar_decoder": [], "rvq": [], "tokenizer": [],
    "scalar_encoder": [], "muencoder": [], "wavlm": [], "whisper": [], "query": []
  }
}
```

Every file found is listed, compatible or not; `error` says why one is not.
`compatible` for `global` and `local` is judged against the tokenizer and RVQ
present; the pairing between global and local is judged at select time. Role
keys use `_` where the role name has `-`. Adapters are not listed here: the Node
server scans adapter folders, and select-model validates the file it is given.

### `POST /heartmula/select-model`

Every field is optional. An absent field leaves that pick alone; `""` or `null`
clears it back to the default (same rule as `/yue2/select-model`).

| Field | Type | Meaning |
|---|---|---|
| `variant` | string | `3B` or `3B-happy-new-year`. Never substituted: if the variant has no global and local file, the request is a 404 |
| `global_type`, `local_type` | string | Quant token for each LM part, chosen independently |
| `flow_type`, `scalar_decoder_type` | string | Quant token for each codec part, chosen independently |
| `adapter` | string or null | Absolute path to a HeartMuLa LoRA GGUF. `""`/`null` removes it. One adapter in v1 |
| `adapter_scale` | number | 0 to 2, default 1.0. 0 must give exactly the base logits |

Default pick, when nothing was requested: variant `3B`; each role uses `Q8_0` if
present, else `F16`, else the most precise type found. This keeps the default
inside the VRAM left when another application holds most of the GPU; F16 LM is an
explicit choice.

The handler validates the whole resulting pick before storing any of it, so a
rejected request changes nothing. A pick that changes a resident component
unloads that component; the next warm or synth loads the new one. Response: the
`selected`, `requested` and `adapter` blocks of `props`.

Errors: 400 malformed value (`bad_request`), 404 no such variant or type
(`not_found`), 409 files that exist but do not fit together (`incompatible`,
message names the two files and the check that failed), 503 while a job is
loading or running HeartMuLa weights (`busy`). The busy case matches YuE2:
callers retry, or put the pick on the synth request instead.

### `POST /heartmula/warm` and `POST /heartmula/unload`

Warm loads tokenizer, global, local and the adapter for the current pick, after
the same VRAM admission as a job (below); on refusal it returns 507 with the
admission object. Response `{"loaded": true, "already_loaded": bool,
"resident_bytes": N, "load_ms": N}`.

Unload waits for the GPU worker to be idle, frees every HeartMuLa buffer and
returns `{"unloaded": true}`. The tokenizer stays loaded; it is a few MB of host
memory.

### `POST /heartmula/synth`

Validates the request synchronously, then queues it on the single shared GPU
worker and returns `{"id": "<job id>"}`. Progress and results use the shared
job system plus `GET /heartmula/job`.

| Field | Default | Validation | Meaning |
|---|---|---|---|
| `tags` | required | non-empty string, at most 4096 bytes | Style tags. Lower-cased and wrapped in `<tag>...</tag>` unless already wrapped, as heartlib does |
| `lyrics` | `""` | string, at most 32768 bytes | Lower-cased, as heartlib does. Empty lyrics encode as BOS, EOS (heartlib itself fails on empty lyrics, so this case has no reference) |
| `duration_s` | 120 | number, 1 to 240 | Upper bound. Frames = floor(duration_s x 12.5). The song ends earlier if the model emits audio EOS |
| `seed` | random | non-negative integer, or a decimal string for values past 2^53 | Sampler seed for the LM |
| `noise_seed` | `seed` | as `seed` | Seed for the codec's flow noise |
| `temperature` | 1.0 | greater than 0, at most 4 | LM sampling temperature, all 8 codebooks |
| `topk` | 50 | integer, 1 to 8197 | Top-k before sampling, all 8 codebooks |
| `cfg_scale` | 1.5 | 1 to 10 | LM classifier-free guidance. 1.0 runs a single unguided branch (half the KV) |
| `codec_steps` | 10 | integer, 1 to 100 | Flow Euler steps per chunk |
| `codec_guidance` | 1.25 | 1 to 10 | Flow guidance scale |
| `variant`, `global_type`, `local_type`, `flow_type`, `scalar_decoder_type`, `adapter`, `adapter_scale` | absent | as select-model | The job's own pick, applied when the job starts. Absent keeps the current pick |
| `codes` | none | array of frames, each 8 integers 0 to 8191, 1 to 3000 frames | Skip the LM and decode these codes. Validation and round-trip use |
| `codes_only` | false | bool, not with `codes` | Stop after the LM; result is the codes as JSON, no codec load |
| `id` | `"heartmula"` | string | Request label for logs |

The ranges for `temperature`, `topk`, `cfg_scale`, `codec_steps` and
`codec_guidance` are engine bounds; heartlib accepts any value and exposes no
other sampler or codec knobs (top-p, repetition penalty and the flow noise
temperature are not part of the reference path, so they are left out).

Synchronous checks, each a 400 `bad_request` naming the field: missing or
wrongly typed field, value outside its range, unknown field (so a typo is not
silently ignored), `codes` with `codes_only`. Then the context check, which needs
the tokenizer: `len(tags ids) + 1 + len(lyrics ids) + frames + 1` must be at most
`context_length` (8192), else 400 `context_overflow` with `prompt_tokens`,
`frames` and `limit` in the body. At the 240 s cap there are 3000 frames, which
leaves 5191 prompt tokens. A pick given on the request is checked as
select-model would check it (404/409 as there). 503 `unavailable` when
`synth_ready` is false.

Result (`GET /job?id=&result=1`): `audio/wav`, 48 kHz stereo, 16-bit, the
same encoder YuE2 uses. With `codes_only`: `application/json`
`{"frames": N, "codebooks": 8, "frame_rate": 12.5, "codes": [[c0..c7], ...]}`.

Completed status (`GET /job?id=`) carries `end_reason`: `completed` (audio EOS),
`limit_hit` (reached the frame limit) or `cancelled`.

### `POST /heartmula/encode`

Reserved for the encoder slice; 501 `not_implemented` until then. Shape:
`multipart/form-data` with `audio` (WAV or MP3, any rate, mono or stereo) and an
optional `request` JSON part with the encoder pack types (`muencoder_type`,
`wavlm_type`, `whisper_type`, `query_type`). It queues a job; the result is the
`codes_only` JSON above. The encoder pack is never loaded for `/synth`.

## Progress

The shared `GET /job?id=` keeps working by mapping HeartMuLa phases onto the
existing `JobPhase` names by role, as MM3 does, so no member is added to the
enum in `hot-step-server.cpp`:

| HeartMuLa phase (`stage`) | Shared `phase` | `phase_step` / `phase_total` |
|---|---|---|
| `queued` | `queued` | 0 / 0 |
| `admission` | `loading_dit` | 0 / 0 |
| `loading_lm` | `loading_dit` | components loaded / to load |
| `loading_adapter` | `loading_adapter` | 0 / 0 |
| `prefill` | `encoding_cond` | prompt positions done / prompt positions |
| `frames` | `dit_inference` | frames done / frame limit |
| `loading_codec` | `loading_vae` | components loaded / to load |
| `codec_decode` | `vae_decode` | flow steps done / (chunks x `codec_steps`), then scalar chunks |
| `encoding_output` | `encoding_output` | 0 / 0 |

`frames` counts against the limit, so a song that ends at EOS jumps to the next
phase before 100%. That is expected; the UI should not treat it as an error.

`GET /heartmula/job?id=` gives the detail:

```json
{
  "id": "<hex>", "status": "running", "phase": "dit_inference", "stage": "frames",
  "prompt_tokens": 412, "prefill_done": 412,
  "frames_done": 731, "max_frames": 3000,
  "codec_chunk": 0, "codec_chunks": 0, "codec_step": 0, "codec_steps": 10,
  "seed": "1234", "noise_seed": "1234",
  "pick": { "variant": "3B", "global": "Q8_0", "local": "Q8_0",
            "flow": "Q8_0", "scalar_decoder": "F16", "adapter": "", "adapter_scale": 1.0 },
  "admission": null,
  "timings_ms": { "admission": 2, "load": 4100, "prefill": 380, "frames": 51000, "codec": 0, "encode": 0 },
  "end_reason": "",
  "error": null
}
```

`seed` and `noise_seed` are decimal strings so 64-bit values survive JSON. On
failure `error` is `{"code": "...", "message": "..."}`.

## Cancel

Cancel is a flag the worker checks at the points below; the job then ends with
status `cancelled` and no result. A cancel that arrives before the job is
marked done always wins, including during output encoding.

| Phase | Checked | Worst-case latency | State after |
|---|---|---|---|
| queued | when the worker picks the job up | 0 | nothing loaded |
| admission, loading | between components | one component load | no partly loaded component; fully loaded ones follow the residency rule below |
| prefill | between prefill chunks (at most 512 positions) | one chunk | LM KV freed |
| frames | after every frame (one global step plus the local decoder) | one frame, tens of ms | LM KV freed; no partial audio in v1 |
| codec decode | between flow steps and between scalar-decoder chunks | one step | codec scratch freed |

Residency after a cancel or failure is the same as after a successful job:
without `--keep-loaded`, every HeartMuLa buffer is freed. A cancel is often a
user reclaiming VRAM, so nothing is kept beyond the normal rule.

## Residency and VRAM admission

The job runs in two phases on the shared worker, so HeartMuLa serialises with
ACE, MM3, YuE2 and SA3. The LM phase holds tokenizer, global, local, adapter and
the KV cache. The codec phase holds RVQ, flow and scalar decoder. By default the
LM parts are freed before the codec loads. Under `--keep-loaded` they stay only
if admission says both phases fit together.

Before each phase loads anything, admission computes:

- `need`: tensor bytes of the files about to load, plus the KV for this request
  (global: 28 layers x 8 KV heads x 128 x 2 (K, V) x 2 bytes x positions, times 2
  with CFG; local: 8 positions), plus `reserve_bytes`. Positions = prompt tokens
  + frame limit + 1.
- `free`: free device memory now, plus what the engine can reclaim from idle
  resident weights of other backends (the ACE store, idle MM3/YuE2/SA3 weights).
  Nothing with work in flight is evicted; the YuE2 render lane is drained first.

`reserve_bytes` covers scratch and activations. Its default comes from the
measurement in the native pipeline slice and is reported in `props`;
`HEARTMULA_VRAM_RESERVE_MB` overrides it.

If `need > free`, nothing is evicted and nothing is loaded, and the job fails
with status `failed`:

```json
{ "code": "vram_insufficient",
  "message": "HeartMuLa needs 6.9 GB for this request; 4.1 GB is free and 0.3 GB can be reclaimed",
  "admission": { "phase": "lm", "need_bytes": 7400000000, "free_bytes": 4400000000,
                 "reclaimable_bytes": 320000000, "reserve_bytes": 1610612736,
                 "weights_bytes": 4190000000, "kv_bytes": 590000000,
                 "positions": 3413, "cfg": true } }
```

The same object appears as `admission` in `GET /heartmula/job`, and warm
returns it with status 507. The engine never falls back to a smaller quant, a
shorter song or CPU offload on its own; the server shows the numbers and the
user picks a smaller quant, a shorter duration or `cfg_scale` 1.0. When
admission passes and an allocation still fails, the job fails with
`vram_alloc_failed` and the same numbers, so the reserve can be corrected.

## GGUF metadata

Written by the converter, the tokenizer converter and the adapter converter;
copied unchanged by `quantize`. All keys are strings unless marked u32.

### Every component

| Key | Value |
|---|---|
| `general.architecture` | as in the component table |
| `general.file_type` | the usual GGUF file type; the quant ladder sets it |
| `heartmula.format_version` | u32, 1. The engine rejects versions it does not know |
| `heartmula.component` | role name: `global`, `local`, `flow`, `rvq`, `scalar-decoder`, `scalar-encoder`, `muencoder`, `wavlm`, `whisper`, `query`, `tokenizer`, `lora` |
| `heartmula.variant` | `3B` or `3B-happy-new-year` for global, local and lora; `shared` for everything else |
| `heartmula.base_fingerprint` | sha256 hex of the source checkpoint, defined below. Quant-independent |
| `heartmula.source` | JSON: each source file's bytes, sha256 and HF revision |
| `heartmula.config_json` | the source `config.json` text. The engine reads hyperparameters from it |
| `heartmula.config_sha256` | sha256 of that text |
| `heartmula.dependencies` | JSON `{"tokenizer": {"tokenizer.json": "<sha256>", "gen_config.json": "<sha256>"}, "rvq_sha256": "<sha256 or null>"}` |
| `heartmula.tensor_layout`, `heartmula.tensor_manifest` | converter records; informational, not checked at load |

`heartmula.base_fingerprint` = sha256 of the UTF-8 bytes of
`json.dumps({name: sha256 for each *.safetensors file in the source checkpoint},
sort_keys=True, separators=(",", ":"))`. Global and local from one checkpoint
share it; the two LM variants differ; codec components share the HeartCodec
checkpoint's value and encoder-pack components share the encoder checkpoint's.
It does not change when a file is re-quantised, so an adapter trained on the
base works over every quant of that base and over no other.

`rvq_sha256` is the sha256 of the whole `heartcodec-rvq` GGUF file the
component was converted against; null in the RVQ file itself. The RVQ file is
never quantised, so its hash is stable.

### Tokenizer (`heartmula-tokenizer`)

The vocabulary and merge storage is the tokenizer slice's choice. The identity
and id keys are fixed:

| Key | Value |
|---|---|
| `heartmula.tokenizer.source_sha256` | JSON with the same shape as `heartmula.dependencies.tokenizer`: `{"tokenizer.json": "<sha256>", "gen_config.json": "<sha256>"}` |
| `heartmula.token.text_bos` | u32, 128000 |
| `heartmula.token.text_eos` | u32, 128001 |
| `heartmula.token.audio_eos` | u32, 8193 |
| `heartmula.token.empty` | u32, 0 (the pad id in audio frames) |

### Quantised files

`quantize` keeps every `heartmula.*` key and adds `heartmula.quant.imatrix_sha256`
(empty when no imatrix was used) and `heartmula.quant.source_sha256` (the F16
file it was made from). `heartmula.tensor_manifest` then describes the F16
source, not this file.

### LoRA adapter (`heartmula-lora`)

| Key | Value |
|---|---|
| `heartmula.component` | `lora` |
| `heartmula.variant` | the base variant it was trained on |
| `heartmula.base_fingerprint` | the base global's fingerprint |
| `heartmula.lora.target_component` | `global` (the only target in v1) |
| `heartmula.lora.rank` | u32 |
| `heartmula.lora.alpha` | f32 |
| `heartmula.lora.targets` | JSON array of base tensor names, e.g. the q, k, v and output projections of each backbone layer |

Tensors: `<base tensor name>.lora_a` with shape [rank, in] and
`<base tensor name>.lora_b` with shape [out, rank], in the GGUF's reversed
dimension order as usual. Applied at runtime as
`W x + (alpha / rank) x adapter_scale x B (A x)`, over any base quant; the
base weights are never modified.

### Load-time checks

The engine runs these at discovery (to fill `compatible`), at select-model and
again when a job loads, since files can change on disk in between:

1. `general.architecture` matches the role and `heartmula.format_version` is
   known.
2. Global and local have the same `heartmula.variant` and
   `heartmula.base_fingerprint`. Mixed quants are fine; mixed variants are not.
3. Each LM file's `heartmula.dependencies.tokenizer` equals the tokenizer's
   `heartmula.tokenizer.source_sha256` (compared as parsed JSON objects).
4. Flow, scalar decoder and every encoder-pack file have `rvq_sha256` equal to
   the sha256 of the RVQ file present. Flow and scalar decoder have the same
   `heartmula.base_fingerprint`.
5. The adapter's `heartmula.base_fingerprint` equals the selected global's, its
   target component is `global`, and every target tensor exists in the global
   file with matching `in` and `out`.
6. Hyperparameters parsed from `heartmula.config_json` match the tensor shapes
   the graph expects (layer count, heads, KV heads, widths, vocab sizes).

A failed check names both files and the key, for example
`heartmula-3b-local-Q8_0.gguf: base_fingerprint differs from heartmula-3b-happy-new-year-global-F16.gguf`.
