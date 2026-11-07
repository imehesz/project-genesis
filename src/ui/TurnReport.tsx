import { useEffect, useState } from 'react';
import { useGame, useUi } from '../store/gameStore.ts';
import type { TurnEvent } from '../engine/index.ts';

const ICON: Record<TurnEvent['kind'], string> = {
  built: '▣', ship: '➤', researched: '✦', growth: '▲', arrived: '◎', colony: '✚', rival: '◆', warning: '!', victory: '★', defeat: '✖',
};

/** End-of-turn summary. Re-opens whenever a new turn report arrives. */
export function TurnReport() {
  const report = useGame((s) => s.report);
  const go = useUi((s) => s.go);
  const open = (e: TurnEvent) => {
    if (e.colonyId) return go({ name: 'colony', colonyId: e.colonyId });
    if (e.kind === 'researched') return go({ name: 'research' });
    go({ name: 'galaxy' });
    if (e.systemId !== undefined) useUi.getState().select(e.systemId);
    if (e.fleetId !== undefined) useUi.getState().selectFleet(e.fleetId);
  };
  const linkable = (e: TurnEvent) => !!e.colonyId || e.systemId !== undefined || e.kind === 'researched';
  const [closedTurn, setClosedTurn] = useState<number | null>(null);

  useEffect(() => {
    if (!report) return;
    const t = setTimeout(() => setClosedTurn(report.turn), 9000);
    return () => clearTimeout(t);
  }, [report]);

  if (!report || !report.events.length || closedTurn === report.turn) return null;
  return (
    <div className="panel turn-report" key={report.turn}>
      <div className="turn-report-head">
        <span>Turn {report.turn} report</span>
        <button className="panel-close" onClick={() => setClosedTurn(report.turn)} aria-label="Close">×</button>
      </div>
      <ul>
        {report.events.map((e, i) => (
          <li key={i} className={`ev ev-${e.kind}`}>
            <span className="ev-icon">{ICON[e.kind]}</span>
            {linkable(e) ? (
              <button className="ev-link" onClick={() => open(e)}>{e.text}</button>
            ) : (
              <span>{e.text}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
