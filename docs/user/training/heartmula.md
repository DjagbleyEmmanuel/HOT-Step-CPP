# HeartMuLa training

Train a LoRA adapter for the HeartMuLa 3B backbone from your own audio in
[Training Studio](../studios/training-studio.md). The base model, the local
decoder and the codec stay frozen. Only the adapter on the backbone trains. The
trainer is native: no Python runs at any point. The finished adapter appears in the
HeartMuLa adapter picker, see [Adapters](../adapters.md).

## Where to find it

Make HeartMuLa the active backend in the engine picker at the top of the sidebar.
Training Studio then shows three phase tabs after the dataset step:

| Tab | What it does |
|---|---|
| Prepare | Encodes each track to HeartCodec codes and builds its prompt. Nothing from ACE-Step preprocessing is used. |
| Train | Starts, pauses, resumes and cancels a run; shows loss, step time and memory. |
| Review | Lists the checkpoint previews of the run, so you can hear the adapter change. |

Each dataset card shows two chips: **Codes** (prepared samples that still match
the dataset) and **Adapter** (the newest published adapter).

## Requirements

- A CUDA build of the engine and the `ace-train` binary. Other backends (Metal,
  Vulkan, CPU) do not train HeartMuLa yet.
- A card with at least 11.9 GB of memory. The trainer measured 10.4 GiB at its
  smallest setting and 15.4 GiB at its fastest. It picks the fastest setting that
  fits the free memory on its own, so a smaller card trains slower, not worse.
- The HeartMuLa 3B global and local F16 models, the tokenizer and the HeartCodec
  RVQ file, installed as for generation. See [Models](../models.md).
- The HeartCodec encoder pack for Prepare: `heartcodec-muencoder-F16.gguf`,
  `heartcodec-wavlm-F16.gguf`, `heartcodec-whisper-F16.gguf` and
  `heartcodec-query-F16.gguf`. Generation does not need them. The Prepare card
  names any that are missing and how to build them with
  `engine/tools/convert-heartmula.py --only encoder`, see
  [the engine guide](../../dev/engine.md#heartmula-training).

The app stops the engine while a preparation or training job runs, because the
trainer needs the GPU to itself, and restarts it afterwards.

## Prepare

Prepare reads the dataset's captions and lyrics. The prompt for each track is its
trigger word, caption and genre as comma-separated tags, then its lyrics (empty
for an instrumental). A track is trained whole, never cut. A track is skipped, with
the reason shown, when its prompt is invalid, when it is too long for the model's
8192-position context, when its audio is missing or unreadable, or when encoding
fails. Changing a track's audio, caption, genre or lyrics makes its sample stale;
run Prepare again before training. Prepared codes are cached, so a second run is
cheap. The Prepare card uses the same live progress panel as YuE2: completed and
failed track counts, current track, phase, an ETA once enough tracks finish, and
the recent log remain visible while the settings are folded away.

## Train

The starting recipe is rank 64, alpha 64, learning rate 1e-4, 480 steps and four
micro-batches per step. The Train page uses YuE2's amber training panel. Choose
**Resume a previous run** or enter an adapter name, then set the steps, save
interval, seed, rank, alpha and learning rate in the visible parameter row.
Dropout and songs per update sit under **Advanced**.
Checkpoint preview settings follow the recipe, and the start, pause and cancel
controls stay below the form:

| Control | Meaning |
|---|---|
| Rank, Alpha | Adapter size and scaling. Higher ranks use more memory. |
| Learning rate, Gradient accumulation, Training seed | Usual meanings. Keep the seed fixed to compare recipes. |
| LoRA dropout | 0 turns it off (the default). 0.05 is a proven value; it adds about 8% to each step and 1.3 GiB of memory. |
| Save every, steps | Resumable checkpoint interval. 0 saves only when stopping or finishing. |

**Save and pause** writes a checkpoint and stops; **Resume run** continues it with
the saved recipe and optimizer state. **Cancel** stops at the next micro-step and
keeps the last checkpoint. A server restart or a failed run also keeps its
checkpoints and can be resumed. When the run finishes, the adapter is copied to
the adapter folder, where generation can pick it up.

Measured on an RTX 5090 with nothing else on the GPU, four 94-second samples, rank
64: about 1.0 s per step (median 1001 ms, four micro-batches) and 15.8 GiB allocated.
Step time scales with clip length, and the memory figure is the fastest setting; a
card with less free memory keeps fewer blocks resident and takes longer per step.

### Presets and resume

The recipe cards follow YuE2's layout. **HOT-Approved** selects the current
server recipe; **Fast** uses 240 updates with four songs per update;
**Balanced** uses 480 with four; **Thorough** uses 720 with eight. These change
the training budget, not the model or loss function. Save your own settings in
**Your presets**, or import and export HeartMuLa preset JSON files. Browser
presets store only recipe values, never dataset, adapter name or resume paths.
The changed-settings row shows differences from the server defaults and resets
each field independently.

Resume from the picker or paste a known run ID or run-folder path from this
dataset. The saved recipe is restored. Base model, GPU and adapter type are
shown in the same row as YuE2, but fixed to 3B F16, automatic CUDA and LoRA by the current
trainer. Attention mode and layer residency are automatic, with no per-run
controls exposed by this API.

The current HeartMuLa API does not provide a multi-dataset queue or an automatic
Prepare-then-Train command. **Train multiple** is unavailable; **Perform all
stages** on Train starts training only after preparation is complete. When the
cache is stale, use Prepare first. On Prepare, Perform all stages runs the
single encoding stage. The adjacent cache-clear card clears other backends'
caches while keeping HeartMuLa codes; **Rebuild all samples** regenerates them.

## Checkpoint previews

The checkpoint ladder uses the same preview cards and players as YuE2 on
Review. Train shows the live loss chart, step time and VRAM for an active run
or a run that finished within 15 minutes of opening the page. Use its **Run** picker to compare checkpoints from an earlier
run. HeartMuLa omits YuE2 scoring, alignment and decoder controls.

With previews on (the default is every 100 steps), the server pauses training at
each preview step, renders 30 seconds of audio from the saved checkpoint, then
resumes. Training never runs while a preview renders. Every take uses the same
tags, lyrics, seed and sampler, so takes differ only by their weights:

- **Base model** is rendered once before training starts.
- **Step N** is rendered at each preview step.
- **Final** is rendered when the run finishes, even if the last step is not a
  preview step.

Previews always render on the model the trainer used (3B, F16), whichever model
you generate with, because an adapter is bound to its base. The **Review** tab
lists the takes oldest first, each with its seed and sampler; **Retry preview** re-renders a failed or cancelled take. A render that fails
or is cancelled never stops the run, and the checkpoints are kept. Each pause costs
the render time plus the engine restart and the trainer reloading its models. On the
same card, a 30-second preview took about 13 s to render and paused training for 18
to 20 s in total.

A preview or a retry cannot start while a job runs on the dataset, and a job cannot
start while a preview renders.

If a preview retry is rejected, its error stays visible on that run's ladder even
after the preview list refreshes. Switching runs shows only the selected run's
retry error. Errors loading the list appear separately.
