import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { gpusOptions, healthOptions } from '../../queries/shell-queue/settings';
import { useBackendStore } from '../../stores/backendStore';
import { useGlobalParamsStore } from '../../stores/globalParamsStore';

const NEW_ISSUE_URL = 'https://github.com/scragnog/HOT-Step-CPP/issues/new/choose';

const osName = () => {
  const ua = navigator.userAgent;
  return /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'unknown';
};
// A model setting can be a file path; the copied text keeps the file name only.
const baseName = (v: unknown) => String(v || '').split(/[\/]/).pop() || '';

export function ReportIssuePanel() {
  const { t } = useTranslation();
  const health = useQuery(healthOptions()).data;
  const gpus = useQuery(gpusOptions()).data?.gpus;
  const backendId = useBackendStore(s => s.activeBackendId);
  const { ditModel, lmModel, vaeModel } = useGlobalParamsStore(s => s) as Record<string, unknown>;
  const [copied, setCopied] = useState(false);
  const unknown = t('settings.report.unknown', 'unknown');
  const b = health?.build;
  const rows: Array<[string, string]> = [
    ['App version', health?.version || unknown],
    ['Build tag', b?.tag || unknown],
    ['Build sha', b?.sha || unknown],
    ['Build variant', b?.variant || unknown],
    ['Update channel', b?.channel || unknown],
    ['OS', osName()],
    ['GPU', gpus?.length ? gpus.map(g => `${g.name} (${Math.round(g.memoryMB / 1024)} GB)`).join(', ') : unknown],
    ['Compute backend', [health?.engine.backend, health?.engine.device].filter(Boolean).join(' / ') || unknown],
    ['Engine', backendId || unknown],
    ['DiT model', baseName(ditModel) || unknown],
    ['LM model', baseName(lmModel) || unknown],
    ['VAE model', baseName(vaeModel) || unknown],
  ];
  const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n');
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return <section className="settings-section">
    <div className="settings-section-header"><span className="settings-section-title">{t('settings.report.title', 'Report an issue')}</span></div>
    <div className="space-y-3 text-sm text-zinc-700 dark:text-zinc-300">
      <p>{t('settings.report.intro', 'Copy this system info and paste it into your GitHub issue. It holds no file paths, user names or keys.')}</p>
      <pre className="whitespace-pre-wrap break-all rounded border border-zinc-500/30 p-3 text-xs">{text}</pre>
      <div className="flex gap-3">
        <button className="settings-save-btn" onClick={copy}>{copied ? t('settings.report.copied', 'Copied') : t('settings.report.copy', 'Copy')}</button>
        <a className="settings-save-btn" href={NEW_ISSUE_URL} target="_blank" rel="noreferrer">{t('settings.report.open', 'Open GitHub issues')}</a>
      </div>
    </div>
  </section>;
}
