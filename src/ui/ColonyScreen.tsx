import { engine, useGame, useUi } from '../store/gameStore.ts';
import {
  BUILDINGS, BUILDING_IDS, SHIPS, SHIP_IDS, buildBlocker, buildingCount, colonyStats, planetOf, shipBlocker,
} from '../engine/index.ts';
import { PLANET_SIZE_LABEL, PLANET_STYLE } from '../theme.ts';
import { buildingArt, planetArt } from './art.ts';
import { BuildCard, ColonyVitals, QueueList, ShipCard, turnsFor } from './colonyParts.tsx';

/** The colony dashboard: numbers and lists. The surface view is the spatial version. */
export function ColonyScreen({ colonyId }: { colonyId: string }) {
  const state = useGame((s) => s);
  const go = useUi((s) => s.go);
  const c = state.colonies[colonyId];
  if (!c || !state.galaxy) return null;

  const planet = planetOf(state, c);
  const sys = state.galaxy.systems[c.systemId];
  const st = colonyStats(state, c);
  const empire = state.empires[c.faction]!;
  const ptype = PLANET_STYLE[planet.type];
  const built = BUILDING_IDS.filter((b) => buildingCount(c, b) > 0);
  const buildable = BUILDING_IDS.filter((b) => !BUILDINGS[b].onlyFaction || BUILDINGS[b].onlyFaction === c.faction);

  return (
    <div className="sheet colony">
      <div className="sheet-head">
        <button className="hud-back" onClick={() => go({ name: 'galaxy' })}>◂ Galaxy</button>
        <div className="sheet-title">
          <h1>{planet.name}</h1>
          <span>{sys.name} system · {ptype.label} · {PLANET_SIZE_LABEL[planet.size]}</span>
        </div>
        <button className="btn btn-primary land-btn" onClick={() => go({ name: 'surface', colonyId })}>
          ⤓ Land on surface
        </button>
      </div>

      <div className="colony-grid">
        <section className="colony-world">
          <button className="planet-portrait" style={{ '--pl': ptype.light } as React.CSSProperties}
            title="Land on the surface" onClick={() => go({ name: 'surface', colonyId })}>
            <img src={planetArt(planet.type)} alt="" />
          </button>
          <ColonyVitals c={c} st={st} />
        </section>

        <section className="colony-build">
          <div className="section-head">
            <h3>Structures</h3>
            <span className={st.landUsed >= st.landTotal ? 'warn' : ''}>{st.landUsed} / {st.landTotal} land in use</span>
          </div>
          {built.length === 0 ? (
            <p className="panel-text">Nothing built yet.</p>
          ) : (
            <div className="built-row">
              {built.map((b) => (
                <div key={b} className="built-chip" title={BUILDINGS[b].effect}>
                  <img src={buildingArt(b)} alt="" />
                  <span>{BUILDINGS[b].name}</span>
                  <b>×{buildingCount(c, b)}</b>
                </div>
              ))}
            </div>
          )}

          <div className="section-head">
            <h3>Starships</h3>
            {shipBlocker(c) && <span>{shipBlocker(c)}</span>}
          </div>
          <div className="build-cards">
            {SHIP_IDS.map((sh) => (
              <ShipCard key={sh} id={sh} blocker={shipBlocker(c)} turns={turnsFor(st, SHIPS[sh].cost)}
                onClick={() => engine.dispatch({ type: 'QUEUE_SHIP', colonyId: c.id, ship: sh })} />
            ))}
          </div>

          <div className="section-head">
            <h3>Construct</h3>
            <span>Placed automatically. Land on the surface to choose the spot.</span>
          </div>
          <div className="build-cards">
            {buildable.map((b) => (
              <BuildCard key={b} id={b} blocker={buildBlocker(state, c, b)} turns={turnsFor(st, BUILDINGS[b].cost)}
                onClick={() => engine.dispatch({ type: 'QUEUE_BUILDING', colonyId: c.id, building: b })} />
            ))}
          </div>
        </section>

        <section className="colony-queue">
          <div className="section-head"><h3>Build queue</h3></div>
          <QueueList c={c} st={st} empire={empire} />
        </section>
      </div>
    </div>
  );
}
