import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { backendModelsOptions } from '../../queries/global-models/options';
import { useBackendStore } from '../../stores/backendStore';
import { useGlobalParamsStore } from '../../stores/globalParamsStore';
import { ParamLabel } from '../shared/ParamLabel';
import { StyledSelect } from '../shared/StyledSelect';
import { BackendExtensionControls } from './BackendExtensionControls';

const fileName = (value: string) => value.split(/[\\/]/).pop() || value;

export function HeartmulaAdapterDropdown() {
  const { t } = useTranslation();
  const backend = useBackendStore(s => s.activeBackendId);
  const selectModels = useBackendStore(s => s.selectModels);
  const { data, error, isPending } = useQuery(backendModelsOptions(backend));
  const [busy, setBusy] = useState(false);
  const selected = String(data?.defaults?.lmAdapter ?? '');
  const adapters = data?.lmAdapters ?? [];
  // A pick whose file was deleted or renamed: shown, not silently read as None (YuE2 does the same).
  const missing = !!selected && !isPending && !error && !adapters.includes(selected);
  const hasMlp = !!data?.lmAdapterMeta?.[selected]?.mlp;
  return (
    <div className="space-y-3">
      <ParamLabel label={t('globalBar.heartmulaAdapter', 'HeartMuLa adapter')}
        info={t('globalBar.heartmulaAdapterInfo', 'Applies a compatible LoRA to the global language model. None uses the base model. Incompatible adapters are refused when selected.')}
        rootClassName="flex mb-1.5" />
      <StyledSelect accent="emerald" className="w-full" value={selected}
        disabled={busy || isPending || !!error || !data?.selectable}
        options={[
          { value: '', label: t('globalBar.heartmulaAdapterNone', 'None, base model') },
          ...(missing ? [{ value: selected, label: `${fileName(selected)} ${t('globalBar.fileNotFound', '(file not found)')}` }] : []),
          ...adapters.map(value => ({ value, label: data?.lmAdapterMeta?.[value]?.mlp ? `${fileName(value)} · MLP` : fileName(value) })),
        ]}
        onChange={async value => {
          setBusy(true);
          try { await selectModels({ lmAdapter: value }, backend); }
          finally { setBusy(false); }
        }} />
      {error && <p className="text-xs text-amber-500">{error.message}</p>}
      {missing && <p className="text-xs text-amber-500">{t('globalBar.heartmulaAdapterMissing', 'This adapter file is no longer installed. Pick another one, or None, before generating.')}</p>}
      {!isPending && !error && !adapters.length && (
        <p className="text-xs text-zinc-500">{t('globalBar.heartmulaNoAdapters', 'No HeartMuLa adapters installed yet. Train one on the Train page, or convert a PEFT LoRA with engine/tools/convert-heartmula-lora.py into the heartmula-lm-adapters folder.')}</p>
      )}
      {selected && !missing && <>
        <BackendExtensionControls group="adapter" accentColor="emerald" hide={hasMlp ? [] : ['heartmulaAdapterScaleMlp']} />
        {!hasMlp && <p className="text-[11px] text-zinc-500">{t('globalBar.heartmulaAdapterNoMlp', 'MLP: this adapter was trained on attention only, so it has no MLP dial. Turn on "Train MLP layers" when training to get one.')}</p>}
      </>}
    </div>
  );
}

export function HeartmulaAdapterBadge() {
  const selected = useBackendStore(s => s.models[s.activeBackendId]?.defaults?.lmAdapter);
  const strength = useGlobalParamsStore(s => s.backendParams?.heartmulaAdapterStrength ?? 1);
  const { t } = useTranslation();
  return <span className="text-[10px] text-zinc-500 font-mono truncate">{selected
    ? `${fileName(String(selected))} · ${strength}`
    : t('globalBar.heartmulaAdapterNone', 'None, base model')}</span>;
}
