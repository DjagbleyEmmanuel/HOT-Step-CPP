// MidiExportPanel.tsx — tempo, meter and bar corrections for a transcription
// that has a beat grid, plus quantize / gap fill for notation software.
//
// Rewrites the job's .mid on the server (POST /:jobId/export) from the kept
// note events and tracked beats: grid maths only, no model, about a second.
// The options are MuScriptor v0.4's export options (ace-midi --help).

import React, { useState } from 'react';
import { Loader2, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { midiJobsOptions, midiNotesOptions } from '../../queries/studios/midi';
import { queryManager } from '../../queries/invalidation';
import { exportMidi, type MidiExportOptions } from '../../services/midiStudioApi';
import { ParamLabel } from '../shared/ParamLabel';
import { StyledSelect } from '../shared/StyledSelect';
import { Toggle } from '../shared/Toggle';

interface Props {
  jobId: string;
  /** options the MIDI was last exported with */
  initial?: MidiExportOptions;
}

const input = 'w-full px-2.5 py-1.5 rounded-lg text-xs bg-zinc-100 dark:bg-black/30 border border-zinc-200 dark:border-white/10 text-zinc-900 dark:text-white placeholder-zinc-400 outline-none focus:border-purple-500/40';

export const MidiExportPanel: React.FC<Props> = ({ jobId, initial }) => {
  const { t } = useTranslation();
  const client = useQueryClient();
  const grid = useQuery(midiNotesOptions(jobId)).data?.grid;
  const [opts, setOpts] = useState<MidiExportOptions>(initial ?? {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!grid) return null;

  const set = (patch: MidiExportOptions) => setOpts(o => ({ ...o, ...patch }));
  const num = (v: string) => (v.trim() === '' ? undefined : Number(v));

  const apply = async (next: MidiExportOptions) => {
    setBusy(true);
    setError('');
    try {
      await exportMidi(jobId, next);
      setOpts(next);
      queryManager.keys(client, midiNotesOptions(jobId).queryKey);
      queryManager.keys(client, midiJobsOptions().queryKey);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const summary = [
    t('midiStudio.export.bpm', { bpm: grid.bpm.toFixed(1) }),
    grid.beatsPerBar ? `${grid.beatsPerBar}/4` : t('midiStudio.export.meterUnknown'),
    grid.steady ? t('midiStudio.export.fixedTempo') : t('midiStudio.export.tempoMap'),
  ].join(' · ');

  return (
    <div className="mt-2 rounded-lg border border-zinc-200 dark:border-white/5 bg-white dark:bg-black/20 p-3">
      <div className="flex items-center gap-2 flex-wrap mb-2.5">
        <span className="text-xs font-semibold text-zinc-800 dark:text-zinc-200">{t('midiStudio.export.title')}</span>
        <span className="text-[11px] text-zinc-500 dark:text-zinc-400">{summary}</span>
      </div>

      <div className="grid grid-cols-2 min-[1024px]:grid-cols-4 gap-x-3 gap-y-2.5">
        <label className="flex flex-col gap-1">
          <ParamLabel label={t('midiStudio.export.bpmLabel')} meta={t('midiStudio.export.blankDetected')}
            info={t('midiStudio.export.bpmInfo')} />
          <input className={input} type="number" min={20} max={400} step={0.1} placeholder={grid.bpm.toFixed(1)}
            value={opts.bpm ?? ''} onChange={e => set({ bpm: num(e.target.value) })} />
        </label>
        <label className="flex flex-col gap-1">
          <ParamLabel label={t('midiStudio.export.beatsPerBar')} meta={t('midiStudio.export.blankDetected')}
            info={t('midiStudio.export.beatsPerBarInfo')} />
          <input className={input} type="number" min={1} max={16} step={1} placeholder={grid.beatsPerBar ? String(grid.beatsPerBar) : '?'}
            value={opts.beatsPerBar ?? ''} onChange={e => set({ beatsPerBar: num(e.target.value) })} />
        </label>
        <div className="flex flex-col gap-1">
          <ParamLabel label={t('midiStudio.export.tempo')} info={t('midiStudio.export.tempoInfo')} />
          <StyledSelect size="sm" accent="purple" value={opts.tempoMode ?? 'auto'}
            onChange={v => set({ tempoMode: v })}
            options={[
              { value: 'auto', label: t('midiStudio.export.tempoAuto') },
              { value: 'map', label: t('midiStudio.export.tempoMap') },
              { value: 'fixed', label: t('midiStudio.export.fixedTempo') },
            ]} />
        </div>
        <div className="flex flex-col gap-1">
          <ParamLabel label={t('midiStudio.export.beatScale')} info={t('midiStudio.export.beatScaleInfo')} />
          <StyledSelect size="sm" accent="purple" value={opts.beatScale ?? 1}
            onChange={v => set({ beatScale: v === 1 ? undefined : v })}
            options={[
              { value: 0.5, label: t('midiStudio.export.halfTime') },
              { value: 1, label: t('midiStudio.export.asDetected') },
              { value: 2, label: t('midiStudio.export.doubleTime') },
            ]} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 mt-3">
        <Toggle size="sm" accent="purple" checked={!!opts.quantize} onChange={v => set({ quantize: v })}
          label={t('midiStudio.export.quantize')} info={t('midiStudio.export.quantizeInfo')} />
        {opts.quantize && (
          <>
            <div className="flex items-center gap-2">
              <ParamLabel label={t('midiStudio.export.grid')} info={t('midiStudio.export.gridInfo')} />
              <StyledSelect size="sm" accent="purple" value={opts.grid ?? 0} className="w-36"
                onChange={v => set({ grid: v || undefined })}
                options={[
                  { value: 0, label: grid.subdivision ? t('midiStudio.export.gridDetected', { n: grid.subdivision }) : t('midiStudio.export.gridAuto') },
                  { value: 2, label: t('midiStudio.export.grid8th') },
                  { value: 3, label: t('midiStudio.export.grid8thTriplet') },
                  { value: 4, label: t('midiStudio.export.grid16th') },
                  { value: 6, label: t('midiStudio.export.grid16thTriplet') },
                  { value: 8, label: t('midiStudio.export.grid32nd') },
                ]} />
            </div>
            <div className="flex items-center gap-2">
              <ParamLabel label={t('midiStudio.export.strength')} info={t('midiStudio.export.strengthInfo')} />
              <StyledSelect size="sm" accent="purple" value={opts.strength ?? 1} className="w-24"
                onChange={v => set({ strength: v === 1 ? undefined : v })}
                options={[1, 0.75, 0.5, 0.25].map(s => ({ value: s, label: `${s * 100}%` }))} />
            </div>
          </>
        )}
        <Toggle size="sm" accent="purple" checked={!!opts.fillGaps} onChange={v => set({ fillGaps: v ? 0.5 : undefined })}
          label={t('midiStudio.export.fillGaps')} info={t('midiStudio.export.fillGapsInfo')} />
        <Toggle size="sm" accent="purple" checked={!!opts.trimLeadingBars} onChange={v => set({ trimLeadingBars: v })}
          label={t('midiStudio.export.trimLeading')} info={t('midiStudio.export.trimLeadingInfo')} />
      </div>

      <div className="flex items-center gap-3 mt-3">
        <button onClick={() => apply(opts)} disabled={busy}
          className="px-4 py-1.5 rounded-lg text-xs font-semibold bg-purple-600 hover:bg-purple-500 text-white disabled:opacity-50 transition-colors flex items-center gap-1.5">
          {busy && <Loader2 size={12} className="animate-spin" />} {t('midiStudio.export.apply')}
        </button>
        <button onClick={() => apply({})} disabled={busy}
          className="px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-500 dark:text-zinc-400 hover:text-purple-600 dark:hover:text-purple-400 border border-zinc-200 dark:border-white/10 transition-colors flex items-center gap-1.5">
          <RotateCcw size={11} /> {t('midiStudio.export.reset')}
        </button>
        {error && <span className="text-xs text-red-500 dark:text-red-400">{error}</span>}
      </div>
    </div>
  );
};
