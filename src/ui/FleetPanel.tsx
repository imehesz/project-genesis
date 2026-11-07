import { engine, useUi } from '../store/gameStore.ts';
import {
  FACTIONS, SHIPS, SHIP_IDS, colonizablePlanets, colonizeBlocker, fleetEta, fleetSpeed, garrisonOf, habitability, invadeBlocker, shipCount, colonyIdOf,
  type Fleet, type GameState,
} from '../engine/index.ts';
import { FACTION_STYLE, PLANET_SIZE_LABEL, PLANET_STYLE } from '../theme.ts';
import { shipArt } from './art.ts';

export function FleetPanel({ state, fleet }: { state: GameState; fleet: Fleet }) {
  const selectFleet = useUi((s) => s.selectFleet);
  const go = useUi((s) => s.go);
  const select = useUi((s) => s.select);
  const galaxy = state.galaxy!;
  const mine = fleet.faction === state.campaign?.playerFaction;
  const color = FACTION_STYLE[fleet.faction].color;
  const at = fleet.at === null ? null : galaxy.systems[fleet.at];
  const dest = fleet.dest === null ? null : galaxy.systems[fleet.dest];
  const eta = fleetEta(state, fleet);
  const targets = mine && at && (fleet.ships.colony ?? 0) > 0 ? colonizablePlanets(state, fleet.faction, at) : [];
  const enemyColonies = mine && at && (fleet.ships.transport ?? 0) > 0
    ? at.planets.map((p) => state.colonies[colonyIdOf(at.id, p.id)]).filter((c) => c && c.faction !== fleet.faction)
    : [];

  return (
    <aside className="panel fleet-panel" style={{ '--fc': color } as React.CSSProperties} key={fleet.id}>
      <button className="panel-close" onClick={() => selectFleet(null)} aria-label="Close">×</button>
      <div className="fleet-head">
        <span className="fleet-chevron">▲</span>
        <div>
          <h2 className="system-name">{mine ? fleet.name : `${FACTION_STYLE[fleet.faction].short} fleet`}</h2>
          <div className="system-sub">
            {FACTIONS[fleet.faction].name} · {shipCount(fleet)} ship{shipCount(fleet) === 1 ? '' : 's'} · speed {fleetSpeed(fleet)}
          </div>
        </div>
      </div>

      <div className="fleet-status">
        {dest ? (
          <>
            En route to <LinkSys name={dest.name} onClick={() => select(dest.id)} /> · {eta} turn{eta === 1 ? '' : 's'}
          </>
        ) : at ? (
          <>
            Orbiting <LinkSys name={at.name} onClick={() => select(at.id)} />
          </>
        ) : (
          'Holding position in deep space'
        )}
      </div>

      <ul className="fleet-ships">
        {SHIP_IDS.filter((s) => (fleet.ships[s] ?? 0) > 0).map((s) => (
          <li key={s}>
            <img src={shipArt(s)} alt="" />
            <span>{SHIPS[s].name}</span>
            <b>×{fleet.ships[s]}</b>
          </li>
        ))}
      </ul>

      {mine && (
        <>
          {targets.length > 0 && (
            <div className="colonize">
              <div className="panel-title small">Colonize</div>
              {targets.map((p) => {
                const block = colonizeBlocker(state, fleet, p.id);
                const hab = habitability(p.type, fleet.faction);
                return (
                  <button key={p.id} className="btn btn-small colonize-btn" disabled={!!block}
                    onClick={() => engine.dispatch({ type: 'COLONIZE', fleetId: fleet.id, planetId: p.id })}>
                    <span className="planet-orb" style={{ width: 16, height: 16, '--pl': PLANET_STYLE[p.type].light, '--pd': PLANET_STYLE[p.type].dark } as React.CSSProperties} />
                    {p.name}
                    <em>{PLANET_STYLE[p.type].label} · {PLANET_SIZE_LABEL[p.size]} · {Math.round(hab * 100)}%</em>
                  </button>
                );
              })}
            </div>
          )}
          {enemyColonies.length > 0 && (
            <div className="colonize">
              <div className="panel-title small">Invade · {fleet.ships.transport! * 8} troops</div>
              {enemyColonies.map((c) => {
                const p = at!.planets[c!.planetId];
                const block = invadeBlocker(state, fleet, p.id);
                const gar = garrisonOf(c!);
                return (
                  <button key={p.id} className="btn btn-small colonize-btn invade-btn" disabled={!!block} title={block ?? ''}
                    onClick={() => { engine.dispatch({ type: 'INVADE', fleetId: fleet.id, planetId: p.id }); if (engine.getState().ground) go({ name: 'ground' }); }}>
                    ⚔ {p.name}
                    <em>{block ?? `${FACTIONS[c!.faction].name} · garrison ~${gar.infantry + gar.tank}`}</em>
                  </button>
                );
              })}
            </div>
          )}
          {mine && at && (fleet.ships.colony ?? 0) > 0 && targets.length === 0 && (
            <p className="panel-text">No planet here your people can live on. Find another system.</p>
          )}
          <div className="fleet-actions">
            {dest && (
              <button className="btn btn-small" onClick={() => engine.dispatch({ type: 'STOP_FLEET', fleetId: fleet.id })}>
                ■ Hold position
              </button>
            )}
            <div className="panel-hint">Right-click a star to set course</div>
          </div>
        </>
      )}
    </aside>
  );
}

function LinkSys({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <button className="ev-link" onClick={onClick}>
      {name}
    </button>
  );
}
