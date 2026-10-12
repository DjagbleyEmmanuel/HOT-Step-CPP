import type { Artist } from '../../services/lireekApi';
import { Loader2 } from 'lucide-react';
import { usePersistedState } from '../../hooks/usePersistedState';
import { CoverResizeHandle } from './CoverResizeHandle';
import { startDragResize } from './startDragResize';

// Three rows of 77px cards and their 8px gaps, plus the p-1 that keeps the
// selected card's ring inside the scroll box.
const THREE_ROWS = 3 * 77 + 2 * 8 + 8;

interface Props {
  artists: Artist[];
  loading: boolean;
  selectedArtistId: number | null;
  onSelectArtist: (artist: Artist) => void;
}

export function CoverArtistGrid({ artists, loading, selectedArtistId, onSelectArtist }: Props) {
  const [height, setHeight] = usePersistedState('hs-cover-artist-grid-height', THREE_ROWS);
  if (loading) return <div className="flex items-center justify-center py-8"><Loader2 className="w-5 h-5 text-zinc-500 animate-spin" /></div>;
  if (artists.length === 0) return <p className="text-xs text-zinc-500 py-4">Add an artist in Lyric Studio to use an album adapter pair.</p>;
  return <div>
  <div className="overflow-y-auto p-1 grid grid-cols-[repeat(auto-fill,minmax(72px,1fr))] content-start gap-2" style={{ height }}>
    {artists.map(artist => <button key={artist.id} type="button" onClick={() => onSelectArtist(artist)}
      className={`flex flex-col items-center gap-1.5 p-2 rounded-xl transition-all duration-200 ${selectedArtistId === artist.id
        ? 'bg-cyan-500/20 ring-2 ring-cyan-400 shadow-lg shadow-cyan-500/10'
        : 'bg-black/5 dark:bg-white/5 hover:bg-cyan-500/10 hover:ring-1 hover:ring-cyan-400/50'}`}>
      <div className="w-10 h-10 rounded-full bg-gradient-to-br from-cyan-500 to-teal-600 flex items-center justify-center overflow-hidden flex-shrink-0">
        {artist.image_url ? <img src={artist.image_url} alt={artist.name} className="w-full h-full object-cover" />
          : <span className="text-white text-sm font-bold">{artist.name.charAt(0)}</span>}
      </div>
      <span className="text-[10px] font-medium text-zinc-700 dark:text-zinc-300 truncate w-full text-center">{artist.name}</span>
    </button>)}
  </div>
  <CoverResizeHandle label="Resize artist grid" direction="vertical"
    onMouseDown={e => startDragResize(e, 'y', height, setHeight, 90, 900)} />
  </div>;
}
