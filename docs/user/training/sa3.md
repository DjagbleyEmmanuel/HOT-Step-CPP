# Stable Audio 3 training

Train a Stable Audio 3 Medium DoRA-rows adapter from instrumental audio in
[Training Studio](../studios/training-studio.md). The base DiT, SAME audio encoder
and T5Gemma text encoder stay frozen. Only the adapter parameters train.
Small, SFX and other adapter families are outside this workflow.

## Where to find it

Open Training Studio with ACE-Step, MiniMax-Music3 or YuE2 selected in the top
bar. Open a dataset, go to Train and choose **Stable Audio 3 Medium · DoRA-rows**
under **Training target**. This target is independent of the generation backend.
The SA3 backend currently hides the Training Studio sidebar entry.

Training requires CUDA or CPU and the `ace-train` binary. The card lists missing
models. Install the SA3 Medium training base, inference DiT, SAME encoder,
T5Gemma encoder and tokenizer, and both SuperSep models through Model Manager.
See [Models](../models.md). Metal and Vulkan training are not supported by this
runner. No measured VRAM or step-time guarantee is available yet.

## Prepare and train

1. Create or open a dataset from your audio folder. Review its captions and
   musical metadata, and exclude tracks you do not want to train on.
2. Select the SA3 training target. You do not need ACE preprocessing or Build:
   the runner scans the current source files and prepares its own snapshot.
3. Choose **New run**, enter an adapter name and review the recipe below.
4. Click **Prepare and train**. Preparation strips vocals with SuperSep level 5,
   then resamples the derived instrumentals to 44.1 kHz stereo. Originals and
   their sidecars stay intact. Derived instrumentals are cached using source,
   model and separation-setting fingerprints.
5. Follow the preparation count, encoding count and training steps in the card.
   The loss chart updates during training. Expand **Training log** for details.
   Generation pauses while the trainer runs, and the engine restarts afterward.
6. A completed run validates and publishes its final inference export into
   `models/sa3-adapters/`. Click Refresh if the picker has not updated yet.

Vocal stripping is HOT-Step's preparation policy for this instrumental workflow.
It is not an upstream training requirement.

## Captions and sidecars

Keep HOT-Step's existing key/value sidecars and `dataset.json`. No new source
format is needed. Preparation maps the parsed caption, genre, BPM, key and time
signature into a prompt such as `warm analogue pad, synthwave, 96 BPM, A minor,
4/4`. Lyrics and bookkeeping fields are omitted. Duration conditioning comes
from the measured audio length, not a sidecar estimate.

Upstream-style plain caption `.txt` files exist only in the derived export.
Do not feed HOT-Step key/value sidecars directly to the upstream trainer: it
reads the entire file as prompt text.

## Recipe

Defaults come from the server. The initial recipe uses batch size 1.

| Control | Default | What it changes |
|---|---|---|
| Total steps | 1,000 | Total optimizer step target, including steps already completed on resume |
| Rank / Alpha | 16 / 16 | Adapter capacity and update scaling |
| Learning rate | 0.0001 | Optimizer update size |
| Crop seconds | 380 | Maximum crop, from 1 to 384 seconds; shorter crops use less memory |
| Training seed | 42 | Training randomness, preserved on resume |
| Checkpoint interval | 100 | Steps between saves of resumable optimizer state |
| Export interval | 0 | Periodic inference snapshots in the run folder; 0 disables periodic snapshots |

Start with a short crop when checking whether your hardware can train the model.
The recipe is a starting point; listening comparisons decide which adapter to keep.

## Cancel and resume

**Cancel training** stops the job. During training the runner requests a checkpoint
stop; cancellation during loading can terminate before a checkpoint exists. A run
appears in the resume picker only when saved state exists. Preparation failures
and runs without checkpoints must start again as a new run.

Select a saved run to resume. Its adapter name, rank, alpha, learning rate,
crop, seed and save intervals stay fixed. You can increase **Total steps**.
Resume uses the saved prepared snapshot, so later edits to the source dataset
do not silently change the resumed run. A new run gets a separate dated folder.

Raw adapter weights and optimizer state remain under the adapters training root.
They are separate from the validated inference GGUF and cannot be loaded in the
generation picker. Publication happens after successful completion; a cancelled
run may be resumable without having a published adapter.

## Audition

Choose a published adapter in **Adapter audition**. Enter a held-out instrumental
caption, keep a fixed seed and duration, and click **Render audition**. Switch
**Use adapter** off and render again for the strength-0 base comparison. Strength 1
applies the full adapter. Each result has an audio player and is saved in the
library. Auditions use SA3 text-to-audio at 8 steps with MD Pingpong Blend and no
post-processing, independently of the active generation backend.

Auditions and the picker use this PC's catalogue. When training on a worker,
copy its published GGUF into this PC's `models/sa3-adapters/`, select **This PC**
and Refresh before auditioning. Automatic worker mirroring is not provided here.

For generation, the same catalogue is available in StableStep's adapter controls.
The inference export stores row scales against the inference base; community raw
training checkpoints are not interchangeable with this export.

## Related

- [Adapters](../adapters.md)
- [Backends](../backends.md)
- [Training internals](../../dev/training-internals.md)
