import { useEffect, useState } from 'react';
import { CUTSCENES, cutsceneSrc } from '../cutscenes.ts';

const PLACEHOLDER_MS = 6000;

/** Full-screen narrative video. Falls back to a placeholder card when the file isn't there yet. */
export function Cutscene({ id, onDone }: { id: string; onDone: () => void }) {
  const def = CUTSCENES[id];
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === ' ' || e.key === 'Enter') onDone();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDone]);

  useEffect(() => {
    if (!missing) return;
    const t = setTimeout(onDone, PLACEHOLDER_MS);
    return () => clearTimeout(t);
  }, [missing, onDone]);

  return (
    <div className="cutscene">
      {!missing ? (
        <video
          className="cutscene-video"
          src={cutsceneSrc(id)}
          autoPlay
          playsInline
          onEnded={onDone}
          onError={() => setMissing(true)}
        />
      ) : (
        <div className="cutscene-placeholder">
          <div className="cutscene-tag">Cutscene placeholder</div>
          <h2>{def?.title ?? id}</h2>
          <p>{def?.note}</p>
          <code>public/{cutsceneSrc(id)}</code>
          <div className="cutscene-bar">
            <div style={{ animationDuration: `${PLACEHOLDER_MS}ms` }} />
          </div>
        </div>
      )}
      <button className="cutscene-skip" onClick={onDone}>
        Skip ▸
      </button>
    </div>
  );
}
