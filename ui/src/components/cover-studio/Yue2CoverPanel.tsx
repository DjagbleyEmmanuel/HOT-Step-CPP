import React from 'react';
import { Loader2 } from 'lucide-react';
import { ParamLabel } from '../shared/ParamLabel';
import { StyledSelect } from '../shared/StyledSelect';
import { Toggle } from '../shared/Toggle';
import { EditableSlider } from '../shared/EditableSlider';
import { transposeKey } from './coverStudioUtils';
import type { Yue2SourceTrack } from '../../utils/yue2CaptionSource';
import type { Artist, AlbumPreset } from '../../services/lireekApi';
import { CoverArtistGrid } from './CoverArtistGrid';

interface Props {
  caption: string;
  onCaptionChange: (value: string) => void;
  captionMode: string;
  onCaptionMode: (value: string) => void;
  artists: Artist[];
  loadingArtists: boolean;
  selectedArtistId: number | null;
  onSelectArtist: (artist: Artist) => void;
  albums: Array<{ lsId: number; album: string; preset: AlbumPreset | null }>;
  selectedLyricsSetId: number | null;
  onSelectAlbum: (lyricsSetId: number) => void;
  coveringBand: string;
  onCoveringBand: (value: string) => void;
  captionTracks: Yue2SourceTrack[];
  instrumental: boolean;
  onInstrumentalChange: (value: boolean) => void;
  renderMode: 'base' | 'artist' | 'custom';
  onRenderMode: (value: 'base' | 'artist' | 'custom') => void;
  ar: string;
  nar: string;
  onAr: (value: string) => void;
  onNar: (value: string) => void;
  arOptions: Array<{ value: string; label: string }>;
  narOptions: Array<{ value: string; label: string }>;
  keepChords: boolean;
  onKeepChords: (value: boolean) => void;
  scoreAbc: string;
  scoreKeyLabel: string;
  voices: 'vocal' | 'both';
  onVoices: (value: 'vocal' | 'both') => void;
  tempoMode: 'free' | 'source' | 'set';
  onTempoMode: (value: 'free' | 'source' | 'set') => void;
  bpm: number;
  onBpm: (value: number) => void;
  keyShift: number;
  onKeyShift: (value: number) => void;
  cfgScale: number;
  onCfgScale: (value: number) => void;
  lyricSchedule: 'off' | 'bias' | 'mask';
  onLyricSchedule: (value: 'off' | 'bias' | 'mask') => void;
  canGenerate: boolean;
  isGenerating: boolean;
  genProgress: number;
  genStage: string;
  onGenerate: () => void;
  onCancel: () => void;
}

export const Yue2CoverPanel: React.FC<Props> = p => {
  const keyLabel = p.scoreKeyLabel;
  const sourceBpm = Number(p.scoreAbc.match(/^Q:[^=\r\n]*=\s*(\d+(?:\.\d+)?)/m)?.[1] ?? 120);
  return (
  <div className="w-full min-w-0 flex-1 overflow-y-auto scrollbar-hide p-4 space-y-4">
    {/* Layout rule: each section (caption, render mode, score-to-render) is one
        unbroken unit — it renders in one column or full width, never split
        across the column boundary. The caption and render-mode sections sit
        side by side as two independent flex stacks (not a CSS grid row), so a
        tall render-mode column (artist grid open) never stretches the short
        caption column to match — each stays its own natural height, top
        aligned, no dead space underneath. Below min-width the pair wraps to
        one column. */}
    <div className="flex flex-wrap items-start gap-4">
    <div className="min-w-0 flex-[1_1_300px] space-y-2">
      {/* ParamLabel's root is an inline-flex span — fine beside its own
          control, but two in a row with nothing block-level between them run
          together on one line. This wrapper div forces the line break. */}
      <div><ParamLabel label="YuE2 style caption" info="Describe the target genre, instruments, mood and vocal style. An adapter can also use a caption from its training dataset." /></div>
      {p.captionTracks.length > 0 && p.renderMode !== 'base' && (
        <>
          <ParamLabel label="Caption source" info="Use your own caption, the training track nearest the detected BPM, or a named training track." />
          <StyledSelect accent="pink" value={p.captionMode} onChange={p.onCaptionMode}
            options={[
              { value: 'custom', label: 'Custom caption' },
              { value: 'auto', label: 'Automatic from dataset' },
              ...p.captionTracks.map(track => ({ value: `track:${track.name}`, label: `Track: ${track.name}` })),
            ]} />
        </>
      )}
      <textarea value={p.caption} onChange={e => p.onCaptionChange(e.target.value)}
        placeholder="Describe the target sound"
        className="w-full h-24 resize-none rounded-xl bg-white dark:bg-black/20 border border-zinc-200 dark:border-white/10 px-3 py-2 text-xs text-zinc-900 dark:text-white" />
    <div className="flex items-center justify-between">
      <ParamLabel label="Instrumental" info="Skip lyrics and render the approved melody without vocals." />
      <Toggle accent="cyan" checked={p.instrumental} onChange={p.onInstrumentalChange} aria-label="Instrumental" />
    </div>
    </div>

    <div className="min-w-0 flex-[1_1_300px] space-y-2">
      <ParamLabel label="Render mode" info="Choose base YuE2, a trained Lyric Studio artist, or a custom adapter pair." />
      <div role="group" aria-label="Render mode" className="flex rounded-lg border border-zinc-200 dark:border-white/10 overflow-hidden">
        {([['base', 'Base YuE2'], ['artist', 'Existing Artist'], ['custom', 'Custom']] as const).map(([value, label]) =>
          <button key={value} type="button" aria-pressed={p.renderMode === value} onClick={() => p.onRenderMode(value)}
            className={`flex-1 px-2 py-2 text-xs ${p.renderMode === value ? 'bg-pink-500/20 text-pink-700 dark:text-pink-300' : 'text-zinc-600 dark:text-zinc-400'}`}>{label}</button>)}
      </div>
      {p.renderMode === 'artist' && <>
        <CoverArtistGrid artists={p.artists} loading={p.loadingArtists} selectedArtistId={p.selectedArtistId} onSelectArtist={p.onSelectArtist} />
        {p.albums.length > 1 && <>
          <ParamLabel label="Album" info="Choose which Lyric Studio album's paired YuE2 adapters to load." />
          <StyledSelect accent="pink" value={p.selectedLyricsSetId ?? ''} onChange={v => p.onSelectAlbum(Number(v))}
            options={p.albums.map(a => ({ value: a.lsId, label: a.album }))} />
        </>}
      </>}
      {p.renderMode !== 'artist' && <>
        <ParamLabel label="Covering band" info="Used in the saved filename." />
        <input value={p.coveringBand} onChange={e => p.onCoveringBand(e.target.value)}
          className="w-full rounded-xl bg-white dark:bg-black/20 border border-zinc-200 dark:border-white/10 px-3 py-2 text-xs text-zinc-900 dark:text-white" />
      </>}
      {p.renderMode === 'custom' && <>
        <ParamLabel label="AR composer" info="The AR adapter steers the musical plan and semantic tokens." />
        <StyledSelect accent="pink" value={p.ar} onChange={p.onAr} options={p.arOptions} />
        <ParamLabel label="NAR renderer" info="The NAR adapter steers the audio rendering stage." />
        <StyledSelect accent="pink" value={p.nar} onChange={p.onNar} options={p.narOptions} />
      </>}
    </div>
    </div>

    {p.isGenerating && (
      <div className="space-y-2 text-xs">
        <p>{p.genStage || 'Generating'} · {p.genProgress}%</p>
        <div className="h-2 bg-zinc-800 rounded-full"><div className="h-full bg-pink-500 rounded-full" style={{ width: `${p.genProgress}%` }} /></div>
        <button onClick={p.onCancel} className="text-red-400">Cancel current render</button>
      </div>
    )}
    <div className="min-w-0 space-y-3 border-t border-zinc-200 dark:border-white/10 pt-4">
      <p className="text-xs font-semibold text-zinc-700 dark:text-zinc-200">Score to render</p>
      <ParamLabel label="Voices" info="Vocal melody alone gives the new style room to choose its instruments. Both keeps the transcribed instrumental line too." />
      <StyledSelect accent="pink" value={p.voices} onChange={v => p.onVoices(v as 'vocal' | 'both')}
        options={[{ value: 'vocal', label: 'Vocal melody only' }, { value: 'both', label: 'Vocal + instrumental line' }]} />
      <div className="flex items-center justify-between">
        <ParamLabel label="Keep chords" info="Retain the original harmony; off lets the style decide." />
        <Toggle accent="cyan" checked={p.keepChords} onChange={p.onKeepChords} aria-label="Keep chords" />
      </div>
      <ParamLabel label="Tempo" info="Free removes the score tempo; Source retains it; Set writes a target BPM using the score's beat unit." />
      <StyledSelect accent="pink" value={p.tempoMode} onChange={v => {
        if (v === 'set' && p.tempoMode !== 'set') p.onBpm(Math.max(20, Math.min(300, sourceBpm)));
        p.onTempoMode(v as 'free' | 'source' | 'set');
      }} options={[{ value: 'free', label: 'Free (style decides)' }, { value: 'source', label: 'Source tempo' }, { value: 'set', label: 'Set BPM' }]} />
      {p.tempoMode === 'set' && <EditableSlider label="Target BPM" value={p.bpm} min={20} max={300} step={1}
        onChange={p.onBpm} helpText={`Source: ${sourceBpm} BPM`} />}
      <EditableSlider label="Pitch Shift" value={p.keyShift} min={-12} max={12} step={1}
        onChange={p.onKeyShift} defaultValue={0} disabled={!keyLabel}
        formatDisplay={v => v === 0 ? 'Source key' : `${v > 0 ? '+' : ''}${v} st → ${transposeKey(keyLabel, v)}`}
        helpText={keyLabel ? `Source: ${keyLabel}. Shift within twelve semitones.` : 'No supported score key found.'} />
      <details className="text-xs text-zinc-600 dark:text-zinc-400">
        <summary className="cursor-pointer">Advanced</summary>
        <EditableSlider label="Condition strength" value={p.cfgScale} min={0.1} max={2} step={0.05}
          onChange={p.onCfgScale} defaultValue={1}
          helpText="Tightens style, lyrics and score together." />
        <ParamLabel label="Lyric Timing (C6)" info="Ties each lyric block to its score section's timing. Off by default; condition strength 1 with it on ruins lyric adherence. Soft nudges the composer toward that timing; Hard hides a section's lyrics until its first Vocal note. Needs CFG 1." />
        <StyledSelect accent="pink" value={p.lyricSchedule} onChange={v => p.onLyricSchedule(v as 'off' | 'bias' | 'mask')}
          options={[
            { value: 'off', label: 'Off' },
            { value: 'bias', label: 'Soft (bias toward the score\'s timing)' },
            { value: 'mask', label: 'Hard (hide lyrics until timed)' },
          ]} />
      </details>
    </div>
    <button onClick={p.onGenerate} disabled={!p.canGenerate}
      className="w-full rounded-xl bg-gradient-to-r from-pink-600 to-purple-600 py-3 text-sm font-bold text-white disabled:opacity-40 disabled:cursor-not-allowed">
      {p.isGenerating ? <><Loader2 className="inline w-4 h-4 mr-1 animate-spin" /> Add to queue</> : 'Generate YuE2 cover'}
    </button>
    {!p.canGenerate && <p className="text-xs text-zinc-500">Choose audio, approve an ABC score, and enter lyrics or select Instrumental.</p>}
  </div>
  );
};
