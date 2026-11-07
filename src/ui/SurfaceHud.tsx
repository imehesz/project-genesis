import { useEffect, useState } from 'react';
import { engine, useGame, useUi } from '../store/gameStore.ts';
import {
  BUILDINGS, BUILDING_IDS, SHIPS, SHIP_IDS, buildBlocker, colonyStats, planetOf, shipBlocker,
} from '../engine/index.ts';
import { PLANET_SIZE_LABEL, PLANET_STYLE } from '../theme.ts';
import { buildingArt, shipArt } from './art.ts';
import { BuildCard, ColonyVitals, QueueList, turnsFor } from './colonyParts.tsx';

/** On the planet: vitals left, queue + selection right, building palette along the bottom. */
export function SurfaceHud({ colonyId }: { colonyId: string }) {
  const state = useGame((s) => s);
  const go = useUi((s) => s.go);
  const placing = useUi((s) => s.placing);
  const setPlacing = useUi((s) => s.setPlacing);
  const selectedId = useUi((s) => s.selectedStructure);
  const setStructure = useUi((s) => s.selectStructure);
  const [confirm, setConfirm] = useState(false);
  const c = state.colonies[colonyId];

  useEffect(() => () => useUi.setState({ placing: null, selectedStructure: null }), []);
  useEffect(() => setConfirm(false), [selectedId]);

  if (!c || !state.galaxy) return null;
  const planet = planetOf(state, c);
  const sys = state.galaxy.systems[c.systemId];
  const st = colonyStats(state, c);
  const empire = state.empires[c.faction]!;
  const buildable = BUILDING_IDS.filter((b) => !BUILDINGS[b].onlyFaction || BUILDINGS[b].onlyFaction === c.faction);
  const sel = selectedId === null ? null : c.structures.find((s) => s.id === selectedId) ?? null;

  return (
    <div className="surface-hud">
      <div className="landing-card" key={colonyId}>
        <div className="landing-kicker">Landing on</div>
        <h1>{planet.name}</h1>
        <span>{sys.name} system · {PLANET_STYLE[planet.type].label} · {PLANET_SIZE_LABEL[planet.size]}</span>
      </div>

      <div className="surface-nav">
        <button className="btn btn-small" onClick={() => go({ name: 'galaxy' })}>⤒ Leave orbit</button>
        <button className="btn btn-small" onClick={() => go({ name: 'colony', colonyId })}>▤ Dashboard</button>
      </div>

      <aside className="panel surface-left">
        <div className="panel-title">{planet.name}</div>
        <ColonyVitals c={c} st={st} compact />
        <div className="kv-hint">{st.landUsed} / {st.landTotal} land in use</div>
      </aside>

      <aside className="panel surface-right">
        {sel ? (
          <div className="structure-info">
            <img src={buildingArt(sel.building)} alt="" />
            <div className="panel-title">{BUILDINGS[sel.building].name}</div>
            <p className="panel-text">{BUILDINGS[sel.building].effect}</p>
            <div className="kv-hint">Upkeep {BUILDINGS[sel.building].upkeep} ¢ per turn</div>
            <div className="panel-row">
              {confirm ? (
                <button className="btn btn-danger" onClick={() => { engine.dispatch({ type: 'DEMOLISH', colonyId, structureId: sel.id }); setStructure(null); }}>
                  Confirm demolish
                </button>
              ) : (
                <button className="btn" onClick={() => setConfirm(true)}>Demolish</button>
              )}
              <button className="btn" onClick={() => setStructure(null)}>Close</button>
            </div>
          </div>
        ) : (
          <>
            <div className="section-head"><h3>Build queue</h3></div>
            <QueueList c={c} st={st} empire={empire} />
            {!shipBlocker(c) && (
              <>
                <div className="section-head"><h3>Starships</h3></div>
                <div className="ship-mini">
                  {SHIP_IDS.map((sh) => (
                    <button key={sh} className="ship-mini-btn" title={`${SHIPS[sh].name}: ${SHIPS[sh].cost} prod`}
                      onClick={() => engine.dispatch({ type: 'QUEUE_SHIP', colonyId, ship: sh })}>
                      <img src={shipArt(sh)} alt="" />
                      <span>{SHIPS[sh].name}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </aside>

      <div className="build-bar">
        {placing ? (
          <div className="placing-hint">
            Placing <b>{BUILDINGS[placing].name}</b> · click open land (green) · right-click or Esc to cancel
          </div>
        ) : (
          <div className="placing-hint dim">Pick a building, then click where it should go</div>
        )}
        <div className="build-strip">
          {buildable.map((b) => (
            <BuildCard key={b} id={b} small active={placing === b} blocker={buildBlocker(state, c, b)}
              turns={turnsFor(st, BUILDINGS[b].cost)} onClick={() => setPlacing(placing === b ? null : b)} />
          ))}
        </div>
      </div>
    </div>
  );
}
