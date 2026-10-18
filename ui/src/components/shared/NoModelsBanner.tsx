/**
 * NoModelsBanner.tsx — first run with an empty models folder.
 *
 * The engine exits at its model scan when nothing is installed. That is not a
 * crash and not a missing DLL, so say what is actually needed and open the Model
 * Manager. The server restarts the engine by itself when a download finishes;
 * this banner polls /api/health and disappears once the engine reports ready.
 */

import React, { useEffect, useState } from 'react';
import { PackageOpen } from 'lucide-react';
import { healthApi } from '../../services/api';
import { ModelManagerModal } from '../model-manager/ModelManagerModal';

const POLL_MS = 5000;

export const NoModelsBanner: React.FC = () => {
  const [noModels, setNoModels] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const h = await healthApi.check();
        if (alive) setNoModels(h.engine?.noModels === true);
      } catch { /* server restarting: keep the last state */ }
    };
    void poll();
    const t = setInterval(poll, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (!noModels) return null;

  return (
    <>
      <div className="flex items-center gap-3 px-4 py-2 border-b border-amber-500/30 bg-amber-500/10">
        <PackageOpen size={18} className="flex-shrink-0 text-amber-400" />
        <div className="min-w-0 flex-1 text-sm text-zinc-800 dark:text-zinc-100">
          No models installed yet. Download one in the Model Manager and the engine starts by itself.
        </div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold
                     bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 transition-colors"
        >
          Open Model Manager
        </button>
      </div>
      {open && <ModelManagerModal onClose={() => setOpen(false)} />}
    </>
  );
};
