import { useMemo } from 'react';
import { engine, landOn, useGame, useUi } from '../store/gameStore.ts';
import { missionLandBlocker, missionPlanetLock, type GameState } from '../engine/index.ts';
import { PLANET_SIZE_LABEL, PLANET_STYLE } from '../theme.ts';
import { planetArt } from './art.ts';
import { Briefing, Minimap, Objectives, type MinimapLayer } from './missionParts.tsx';
import { planetPos, SYSTEM_LAYOUT } from '../render/views/SystemView.ts';

/** Campaign, in space: the star system, the ship, the goals. Turn-based: the ship moves on End Turn. */
export function MissionHud() {
  const state = useGame((s) => s);
  const sel = useUi((s) => s.selectedPlanet);
  const m = state.mission;
  const layer = useMemo(() => spaceLayer(), []);
  if (!m || !state.galaxy) return null;
  const sys = state.galaxy.systems[m.systemId];
  const planet = sel === null ? null : sys.planets[sel];

  return (
    <div className="hud mission-hud">
      <header className="mission-top">
        <div className="battle-kicker">Campaign 1 · {sys.name} system</div>
        <div className="mission-turn">Turn {state.turn}</div>
      </header>
      <div className="mission-left">
        <Objectives mission={m} />
        <div className="panel stock">
          <span className="res res-light">LIGHT <b>{Math.floor(m.light)}</b></span>
          <span className="res res-dark">DARK <b>{Math.floor(m.dark)}</b></span>
        </div>
      </div>

      {planet && sel !== null && <PlanetPanel state={state} id={sel} />}
      {!planet && (
        <aside className="panel system-hint">
          <p className="panel-text"><b>Click</b> a planet to inspect it · <b>right-click</b> it to send your ship · <b>End Turn</b> to fly</p>
        </aside>
      )}

      <div className="mission-minimap"><Minimap layer={layer} label={sys.name} /></div>
      <button className={`btn btn-primary end-turn ${m.ship.dest !== null ? 'is-ready' : ''}`} onClick={() => engine.dispatch({ type: 'END_TURN' })}>
        End Turn ▸
      </button>

      {!m.briefed && <Briefing id="c1-briefing" mission={m} onClose={() => engine.dispatch({ type: 'MISSION_BRIEFED' })} />}
    </div>
  );
}

function PlanetPanel({ state, id }: { state: GameState; id: number }) {
  const m = state.mission!;
  const p = state.galaxy!.systems[m.systemId].planets[id];
  const lock = missionPlanetLock(state, id);
  const landBlock = missionLandBlocker(state, id);
  const here = m.ship.at === id, going = m.ship.dest === id;
  return (
    <aside className="panel system-panel planet-panel">
      <img className="planet-art" src={planetArt(p.type)} alt="" />
      <div className="panel-title">{p.name}</div>
      <div className="kv-hint">{PLANET_STYLE[p.type].label} · {PLANET_SIZE_LABEL[p.size]}</div>
      {lock ? (
        <p className="panel-text lock-note">🔒 {lock}</p>
      ) : m.completed.includes(id) ? (
        <p className="panel-text">The colony on {p.name} is ours again, and the rune is aboard.</p>
      ) : id === 0 ? (
        <p className="panel-text">A human colony. It stopped answering years ago.</p>
      ) : (
        <p className="panel-text">Reachable now. What waits down there is still unknown.</p>
      )}
      <div className="panel-row">
        {!here && !lock && (
          <button className={`btn ${going ? '' : 'btn-primary'}`} disabled={going} onClick={() => engine.dispatch({ type: 'MISSION_SHIP_MOVE', planetId: id })}>
            {going ? 'Ship en route · End Turn' : 'Send ship here'}
          </button>
        )}
        {here && (
          <button className="btn btn-primary" disabled={!!landBlock} title={landBlock ?? ''} onClick={() => landOn(id)}>
            ⤓ Land {landBlock && landBlock !== 'Fly the ship into orbit first' ? `· ${landBlock}` : ''}
          </button>
        )}
      </div>
    </aside>
  );
}

/** Space minimap: the sun, the orbits, the planets and the ship, seen from above. */
function spaceLayer(): MinimapLayer {
  const R = SYSTEM_LAYOUT.orbits[SYSTEM_LAYOUT.orbits.length - 1] + 8;
  const size = R * 2;
  const toWorld = (x: number, y: number) => ({ x: x - R, z: y - R });
  const fromWorld = (x: number, z: number) => ({ x: x + R, y: z + R });
  return {
    w: size, h: size, toWorld, fromWorld,
    background(g, px) {
      const k = px / size;
      g.fillStyle = '#04070d';
      g.fillRect(0, 0, px, px);
      g.strokeStyle = 'rgba(109,140,194,0.35)';
      for (const r of SYSTEM_LAYOUT.orbits) { g.beginPath(); g.arc(R * k, R * k, r * k, 0, Math.PI * 2); g.stroke(); }
      const sun = g.createRadialGradient(R * k, R * k, 0, R * k, R * k, 9);
      sun.addColorStop(0, '#fff6d8'); sun.addColorStop(0.4, '#ffc24a'); sun.addColorStop(1, 'rgba(255,150,40,0)');
      g.fillStyle = sun;
      g.beginPath(); g.arc(R * k, R * k, 9, 0, Math.PI * 2); g.fill();
    },
    overlay(g, px) {
      const s = engine.getState(), m = s.mission;
      if (!m) return;
      const k = px / size;
      const sel = useUi.getState().selectedPlanet;
      s.galaxy!.systems[m.systemId].planets.forEach((p, i) => {
        const pp = fromWorld(planetPos(i).x, planetPos(i).z);
        const locked = !!missionPlanetLock(s, i);
        g.fillStyle = locked ? '#5b6474' : PLANET_STYLE[p.type].light;
        g.beginPath(); g.arc(pp.x * k, pp.y * k, 3 + p.size * 0.7, 0, Math.PI * 2); g.fill();
        if (sel === i) { g.strokeStyle = '#8fe8ff'; g.beginPath(); g.arc(pp.x * k, pp.y * k, 8 + p.size, 0, Math.PI * 2); g.stroke(); }
      });
      const at = m.ship.at;
      const sp = at === null ? { x: Math.cos(SYSTEM_LAYOUT.parked.a) * SYSTEM_LAYOUT.parked.r, z: Math.sin(SYSTEM_LAYOUT.parked.a) * SYSTEM_LAYOUT.parked.r } : { x: planetPos(at).x + 4, z: planetPos(at).z };
      const q = fromWorld(sp.x, sp.z);
      g.fillStyle = '#5fd4ff';
      g.beginPath(); g.moveTo(q.x * k, q.y * k - 5); g.lineTo(q.x * k + 4, q.y * k + 4); g.lineTo(q.x * k - 4, q.y * k + 4); g.closePath(); g.fill();
    },
    onClick(x, y) {
      // clicking a planet selects it too
      const s = engine.getState();
      const n = s.galaxy?.systems[s.mission?.systemId ?? 0]?.planets.length ?? 0;
      for (let i = 0; i < n; i++) {
        const pp = fromWorld(planetPos(i).x, planetPos(i).z);
        if (Math.hypot(pp.x - x, pp.y - y) < 6) useUi.setState({ selectedPlanet: i });
      }
    },
  };
}


