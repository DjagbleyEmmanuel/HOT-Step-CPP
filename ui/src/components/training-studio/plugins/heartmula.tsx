import type { HeartmulaStatusResponse } from '../../../../../server/src/contracts/heartmulaTraining';
import { HeartmulaPrepareCard, type HeartmulaPrepareCardProps } from '../HeartmulaPrepareCard';
import { HeartmulaPreviewCard, type HeartmulaPreviewCardProps } from '../HeartmulaPreviewCard';
import { HeartmulaTrainCard, type HeartmulaTrainCardProps } from '../HeartmulaTrainCard';
import type { TrainingPlugin, TrainingRenderContext } from '../trainingPluginTypes';
import { useTranslation } from 'react-i18next';

/** The integration owns Query snapshots, captured targets, commands and errors.
 * No leaf starts a second reader or job lifecycle beside that owner. */
export interface HeartmulaTrainingView {
  /** Dataset and worker identity; changing it discards the previous form. */
  scopeKey: string;
  status: HeartmulaStatusResponse | null;
  loading: boolean;
  error: string | null;
  busy: boolean;
  preparing: boolean;
  trainStarted: boolean;
  prepareBlockedReason?: string;
  trainBlockedReason?: string;
  onPrepare: HeartmulaPrepareCardProps['onPrepare'];
  onTrain: HeartmulaTrainCardProps['onTrain'];
  onCheckpoint: HeartmulaTrainCardProps['onCheckpoint'];
  onCancel: HeartmulaTrainCardProps['onCancel'];
  previews: HeartmulaPreviewCardProps['previews'];
  previewError?: string | null;
  /** A manual preview render is in flight (the server refuses a second one). */
  previewBusy?: boolean;
  onRenderPreview?: HeartmulaPreviewCardProps['onRender'];
}

export interface HeartmulaPluginIntegration {
  target: Pick<TrainingPlugin, 'id' | 'phases' | 'reachablePhases' | 'phaseLabels' | 'prepareStages' | 'trainStages' | 'recipeFields' | 'previewSource' | 'chips' | 'readiness'>;
  useController: (context: TrainingRenderContext) => HeartmulaTrainingView;
}

// eslint-disable-next-line react-refresh/only-export-components -- The registry exports a factory; leaf components have their own refresh boundaries.
function HeartmulaPage({ context, useController, review = false }: {
  context: TrainingRenderContext;
  useController: HeartmulaPluginIntegration['useController'];
  review?: boolean;
}) {
  const { t } = useTranslation();
  const view = useController(context);
  return <div className="flex flex-col gap-4">
    {view.error && <p role="alert" className="text-xs text-red-500">{view.error}</p>}
    {view.loading && !view.status && <p role="status" className="text-xs text-zinc-500">{t('trainingStudio.heartmula.loading', 'Loading HeartMuLa training status…')}</p>}
    {review ? <HeartmulaPreviewCard previews={view.previews} busy={view.busy || !!view.previewBusy} error={view.previewError} onRender={view.onRenderPreview} />
      : view.status && (context.section === 'prepare'
        ? <HeartmulaPrepareCard key={view.scopeKey} status={view.status.prepare} busy={view.busy} preparing={view.preparing}
          blockedReason={view.prepareBlockedReason} onPrepare={view.onPrepare} />
        : <HeartmulaTrainCard key={view.scopeKey} status={view.status} slug={context.slug} busy={view.busy}
          trainStarted={view.trainStarted} blockedReason={view.trainBlockedReason}
          onTrain={view.onTrain} onCheckpoint={view.onCheckpoint} onCancel={view.onCancel} />)}
  </div>;
}

/** The integration supplies its registry facts and existing state owner here; TrainPanel hosts the Review page. */
export function createHeartmulaPlugin({ target, useController }: HeartmulaPluginIntegration): TrainingPlugin {
  return {
    ...target,
    renderPrepare: context => <HeartmulaPage context={context} useController={useController} />,
    renderTrain: context => <HeartmulaPage context={context} useController={useController} />,
    renderReview: context => <HeartmulaPage context={context} useController={useController} review />,
  };
}
