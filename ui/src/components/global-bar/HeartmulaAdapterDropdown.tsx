import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { backendModelsOptions } from '../../queries/global-models/options';
import { useBackendStore } from '../../stores/backendStore';
import { useGlobalParamsStore } from '../../stores/globalParamsStore';
import { useCapabilities } from '../../hooks/useCapabilities';
import { ParamLabel } from '../shared/ParamLabel';
import { StyledSelect } from '../shared/StyledSelect';
import { Slider } from '../shared/Slider';

export function HeartmulaAdapterDropdown() {
  const { t } = useTranslation();
  const backend = useBackendStore(s => s.activeBackendId);
  const selectModels = useBackendStore(s => s.selectModels);
  const { data, error, isPending } = useQuery(backendModelsOptions(backend));
  const { capabilities } = useCapabilities();
  const params = useGlobalParamsStore(s => s.backendParams);
  const setParam = useGlobalParamsStore(s => s.setBackendParam);
  const [busy, setBusy] = useState(false);
  const selected = String(data?.defaults?.lmAdapter ?? '');
  const strength = capabilities?.extensions.find(p => p.key === 'heartmulaAdapterStrength');
  return (
    <div className="space-y-3">
      <ParamLabel label={t('globalBar.heartmulaAdapter', 'HeartMuLa adapter')}
        info={t('globalBar.heartmulaAdapterInfo', 'Applies a compatible LoRA to the global language model. None uses the base model. Incompatible adapters are refused when selected.')}
        rootClassName="flex mb-1.5" />
      <StyledSelect accent="emerald" className="w-full" value={selected}
        disabled={busy || isPending || !!error || !data?.selectable}
        options={[
          { value: '', label: t('globalBar.heartmulaAdapterNone', 'None, base model') },
          ...(data?.lmAdapters ?? []).map(value => ({ value, label: value.split(/[\\/]/).pop() || value })),
        ]}
        onChange={async value => {
          setBusy(true);
          try { await selectModels({ lmAdapter: value }, backend); }
          finally { setBusy(false); }
        }} />
      {error && <p className="text-xs text-amber-500">{error.message}</p>}
      {!isPending && !error && !data?.lmAdapters?.length && (
        <p className="text-xs text-zinc-500">{t('globalBar.heartmulaNoAdapters', 'No HeartMuLa GGUF adapters installed.')}</p>
      )}
      {strength && <Slider label={strength.label} info={strength.hint}
        value={Number(params?.heartmulaAdapterStrength ?? strength.default ?? 1)}
        min={strength.min ?? 0} max={strength.max ?? 2} step={strength.step ?? 0.05}
        defaultValue={Number(strength.default ?? 1)}
        onChange={value => setParam('heartmulaAdapterStrength', value)} />}
    </div>
  );
}

export function HeartmulaAdapterBadge() {
  const selected = useBackendStore(s => s.models[s.activeBackendId]?.defaults?.lmAdapter);
  const strength = useGlobalParamsStore(s => s.backendParams?.heartmulaAdapterStrength ?? 1);
  const { t } = useTranslation();
  return <span className="text-[10px] text-zinc-500 font-mono truncate">{selected
    ? `${String(selected).split(/[\\/]/).pop()} · ${strength}`
    : t('globalBar.heartmulaAdapterNone', 'None, base model')}</span>;
}
