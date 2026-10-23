// ace.tsx — the ACE-Step plug-in: tensors, DiT and LM chips.
//
// Its Train page (DiT and LM cards, the preprocess-variant gate) still lives in
// TrainPanel until the ACE migration slice moves it here, so no renderTrain yet.

import { aceChips, aceReadiness } from './chips';
import { TRAINING_TARGETS } from '../trainingTargets';
import type { TrainingPlugin } from '../trainingPluginTypes';

export const acePlugin: TrainingPlugin = {
  ...TRAINING_TARGETS.ace,
  chips: aceChips,
  readiness: aceReadiness,
};
