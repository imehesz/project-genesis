import { useEffect } from 'react';
import { engine, startNewCampaign, useGame, useUi } from '../store/gameStore.ts';
import {
  FACTIONS, colonyIdOf, empireTotals, fleetEta, habitability, shipCount,
  type FactionId, type GameState, type Planet, type StarSystem,
} from '../engine/index.ts';
import { FleetPanel } from './FleetPanel.tsx';
import { SurfaceHud } from './SurfaceHud.tsx';
import { FACTION_STYLE, PLANET_SIZE_LABEL, PLANET_STYLE, STAR_STYLE } from '../theme.ts';
import { Stat, signed } from './common.tsx';
import { ColonyScreen } from './ColonyScreen.tsx';
import { ResearchScreen } from './ResearchScreen.tsx';
import { TurnReport } from './TurnReport.tsx';

/** Strategic layer: empire bar, galaxy overlays, colony + research sheets, turn control. */
export function GalaxyHud() {
  const state = useGame((s) => s);
  const screen = useUi((s) => s.screen);
  const selectedId = useUi((s) => s.selectedSystem);
  const fleetId = useUi((s) => s.selectedFleet);
  const select = useUi((s) => s.select);
  const go = useUi((s) => s.go);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const ui = useUi.getState();
      if (ui.screen.name === 'surface' && ui.placing) ui.setPlacing(null);
      else if (ui.screen.name === 'surface' && ui.selectedStructure !== null) ui.selectStructure(null);
      else if (ui.screen.name !== 'galaxy') go({ name: 'galaxy' });
      else if (ui.selectedFleet !== null) ui.selectFleet(null);
      else select(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [select, go]);

  const { galaxy, campaign } = state;
  if (!galaxy || !campaign) return null;
  const me = campaign.playerFaction;
  const empire = state.empires[me]!;
  const totals = empireTotals(state, me);
  const owned = galaxy.systems.filter((s) => s.owner === me);
  const home = owned[0];
  const selected = selectedId === null ? null : galaxy.systems[selectedId];
  const onMap = screen.name === 'galaxy';
  const fleet = fleetId === null ? null : state.fleets[fleetId] ?? null;

  return (
    <div className="hud">
      <header className="hud-top">
        <button className="hud-back" onClick={() => go({ name: 'menu' })}>
          ◂ Menu
        </button>
        <div className="hud-stats">
          <div className="faction-badge" style={{ '--fc': FACTION_STYLE[me].color } as React.CSSProperties}>
            <span className="faction-dot" />
            {FACTIONS[me].name}
          </div>
          <Stat label="Credits" value={Math.floor(empire.credits).toLocaleString()} sub={`${signed(totals.net)} / turn`} accent />
          <Stat label="Research" value={totals.research.toFixed(0)} sub={empire.research.current ? 'per turn' : 'idle!'} />
          <Stat label="Population" value={`${totals.population.toFixed(0)}M`} sub={`${totals.colonies} colon${totals.colonies === 1 ? 'y' : 'ies'} · ${totals.fleets} fleet${totals.fleets === 1 ? '' : 's'}`} />
          <Stat label="Turn" value={state.turn} />
          <button className={`btn btn-small ${screen.name === 'research' ? 'btn-primary' : ''}`}
            onClick={() => go(screen.name === 'research' ? { name: 'galaxy' } : { name: 'research' })}>
            ✦ Research{!empire.research.current && <i className="dot-alert" />}
          </button>
        </div>
      </header>

      {onMap && selected && <SystemPanel state={state} sys={selected} me={me} onClose={() => select(null)} />}
      {onMap && fleet && <FleetPanel state={state} fleet={fleet} />}
      {screen.name === 'colony' && <ColonyScreen colonyId={screen.colonyId} />}
      {screen.name === 'research' && <ResearchScreen />}
      {screen.name === 'surface' && <SurfaceHud colonyId={screen.colonyId} />}

      {onMap && (
        <div className="hud-bottom-left">
          {home && (
            <button className="btn btn-small" onClick={() => select(home.id)}>
              ⌂ Home system
            </button>
          )}
          <button className="btn btn-small" title="Discard this galaxy and roll a new one" onClick={() => startNewCampaign()}>
            ↻ New galaxy
          </button>
          <div className="seed">
            Seed {galaxy.seed} · {galaxy.systems.length} systems · {galaxy.arms} arms
          </div>
        </div>
      )}

      <TurnReport />
      {state.ground ? (
        <button className="btn btn-primary end-turn battle-pending" onClick={() => go({ name: 'ground' })}>
          ⚔ Invasion in progress ▸
        </button>
      ) : state.battle ? (
        <button className="btn btn-primary end-turn battle-pending" onClick={() => go({ name: 'battle' })}>
          ⚔ Battle at {galaxy.systems[state.battle.systemId].name} ▸
        </button>
      ) : (
        <button className="btn btn-primary end-turn" onClick={() => {
          engine.dispatch({ type: 'END_TURN' });
          if (engine.getState().battle) go({ name: 'battle' });
        }}>
          End turn ▸
        </button>
      )}
    </div>
  );
}

function SystemPanel({ state, sys, me, onClose }: { state: GameState; sys: StarSystem; me: FactionId; onClose: () => void }) {
  const go = useUi((s) => s.go);
  const selectFleet = useUi((s) => s.selectFleet);
  const selFleetId = useUi((s) => s.selectedFleet);
  const selFleet = selFleetId === null ? null : state.fleets[selFleetId];
  const canSend = selFleet && selFleet.faction === me && selFleet.at !== sys.id && selFleet.dest !== sys.id;
  const here = Object.values(state.fleets).filter((f) => f.at === sys.id);
  const star = STAR_STYLE[sys.star];
  const owner = sys.owner;
  const myColony = sys.planets.map((p) => state.colonies[colonyIdOf(sys.id, p.id)]).find((c) => c?.faction === me);
  return (
    <aside className="panel system-panel" key={sys.id}>
      <button className="panel-close" onClick={onClose} aria-label="Close">
        ×
      </button>
      <div className="system-head">
        <span className="star-orb" style={{ '--sc': star.color } as React.CSSProperties} />
        <div>
          <h2 className="system-name">{sys.name}</h2>
          <div className="system-sub">
            {sys.star}-class · {star.label}
          </div>
        </div>
      </div>
      <div className="owner-tag" style={owner ? ({ '--fc': FACTION_STYLE[owner].color } as React.CSSProperties) : undefined}>
        {owner ? FACTIONS[owner].name : 'Unclaimed'}
      </div>

      <div className="panel-title small">Planets · {sys.planets.length}</div>
      {sys.planets.length === 0 ? (
        <p className="panel-text">No planets. Asteroid debris only.</p>
      ) : (
        <ul className="planet-list">
          {sys.planets.map((p) => {
            const col = state.colonies[colonyIdOf(sys.id, p.id)];
            const mine = col?.faction === me;
            return (
              <PlanetRow key={p.id} p={p} population={col?.population} hab={p.colony ? undefined : habitability(p.type, me)}
                onOpen={mine ? () => go({ name: 'colony', colonyId: col!.id }) : undefined} />
            );
          })}
        </ul>
      )}

      {here.length > 0 && (
        <>
          <div className="panel-title small">Fleets in orbit</div>
          <ul className="planet-list">
            {here.map((f) => (
              <li key={f.id}>
                <button className="planet-row is-link fleet-row" style={{ '--fc': FACTION_STYLE[f.faction].color } as React.CSSProperties}
                  onClick={() => selectFleet(f.id)}>
                  <span className="fleet-chevron">▲</span>
                  <div className="planet-info">
                    <div className="planet-name">{f.faction === me ? f.name : `${FACTION_STYLE[f.faction].short} fleet`}</div>
                    <div className="planet-sub">{shipCount(f)} ship{shipCount(f) === 1 ? '' : 's'}{f.dest !== null ? ' · departing' : ''}</div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {canSend && (
        <button className="btn btn-ghost" onClick={() => engine.dispatch({ type: 'MOVE_FLEET', fleetId: selFleet.id, to: sys.id })}>
          Send {selFleet.name} here · {fleetEta(state, selFleet, sys.id)} turn{fleetEta(state, selFleet, sys.id) === 1 ? '' : 's'}
        </button>
      )}

      {myColony && (
        <div className="panel-row">
          <button className="btn btn-primary" onClick={() => go({ name: 'surface', colonyId: myColony.id })}>
            ⤓ Land
          </button>
          <button className="btn" onClick={() => go({ name: 'colony', colonyId: myColony.id })}>
            Dashboard
          </button>
        </div>
      )}
    </aside>
  );
}

function PlanetRow({ p, population, hab, onOpen }: { p: Planet; population?: number; hab?: number; onOpen?: () => void }) {
  const st = PLANET_STYLE[p.type];
  const px = 14 + p.size * 4;
  const Tag = onOpen ? 'button' : 'div';
  return (
    <li>
      <Tag className={`planet-row ${onOpen ? 'is-link' : ''}`} onClick={onOpen}>
        <span className="planet-orb" style={{ width: px, height: px, '--pl': st.light, '--pd': st.dark } as React.CSSProperties} />
        <div className="planet-info">
          <div className="planet-name">
            {p.name}
            {p.colony?.homeworld && (
              <span className="home-tag" style={{ color: FACTION_STYLE[p.colony.faction].color }}>
                Homeworld
              </span>
            )}
          </div>
          <div className="planet-sub">
            {st.label} · {PLANET_SIZE_LABEL[p.size]}
            {population !== undefined && ` · ${population.toFixed(1)}M`}
            {hab !== undefined && (hab > 0 ? <span className="hab"> · habitable {Math.round(hab * 100)}%</span> : <span className="hab no"> · uninhabitable</span>)}
          </div>
        </div>
      </Tag>
    </li>
  );
}
