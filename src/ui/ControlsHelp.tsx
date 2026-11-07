import { useEffect, useState } from 'react';

const SEEN_KEY = 'pg.controlsSeen';

const ROWS: [string, string][] = [
  ['Left click', 'Select (stars, fleets, buildings, units)'],
  ['Left-drag', 'Box-select troops (ground battles)'],
  ['Right click', 'Order: move / attack / set course · cancel placement'],
  ['Middle-drag', 'Pan the camera'],
  ['Alt + middle-drag', 'Rotate the camera (Alt + left-drag works too)'],
  ['Mouse wheel', 'Zoom toward the cursor'],
  ['Ctrl + wheel', 'Tilt the camera'],
  ['Arrows / WASD', 'Pan'],
  ['Alt + arrows', 'Rotate / tilt'],
  ['PgUp / PgDn', 'Zoom'],
  ['Ctrl+A · Space', 'Select all troops · pause (ground battles)'],
  ['Esc', 'Deselect / close'],
];

/** Camera + mouse reference (Beyond All Reason-style scheme). F1 or ? toggles; shown once automatically. */
export function ControlsHelp() {
  const [open, setOpen] = useState(() => {
    try { return !localStorage.getItem(SEEN_KEY); } catch { return false; }
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (e.key === 'F1' || e.key === '?') { e.preventDefault(); setOpen((o) => !o); }
      else if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const close = () => {
    setOpen(false);
    try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* private mode: fine */ }
  };
  if (!open) return null;
  return (
    <div className="controls-help" onClick={close}>
      <div className="panel controls-card" onClick={(e) => e.stopPropagation()}>
        <div className="section-head">
          <h3>Controls</h3>
          <span>F1 or ? to toggle</span>
        </div>
        <table>
          <tbody>
            {ROWS.map(([k, v]) => (
              <tr key={k}><td><kbd>{k}</kbd></td><td>{v}</td></tr>
            ))}
          </tbody>
        </table>
        <button className="btn btn-primary" onClick={close}>Got it</button>
      </div>
    </div>
  );
}
