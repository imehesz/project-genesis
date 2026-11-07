import { useEffect, useState } from 'react';
import { engine, useGame, useUi } from '../store/gameStore.ts';
import { FACTIONS, UNIT_DEFS, planetOf, type FactionId, type GroundUnit, type UnitId } from '../engine/index.ts';
import { FACTION_STYLE } from '../theme.ts';
import { Meter } from './common.tsx';

/** Real-time invasion HUD. The engine clock only runs while this screen is open and not paused. */
export function GroundHud() {
  const ground = useGame((s) => s.ground);
  const state = useGame((s) => s);
  const me = state.campaign?.playerFaction;
  const sel = useUi((s) => s.groundSelection);
  const go = useUi((s) => s.go);
  // dev/demo hook: ?scenario=ground&paused=1 opens the invasion paused
  const [paused, setPaused] = useState(() => import.meta.env.DEV && new URLSearchParams(location.search).get('paused') === '1');
  const [confirm, setConfirm] = useState(false);
  const over = !!ground?.over;

  useEffect(() => {
    engine.setRealtime(!paused && !over);
    return () => engine.setRealtime(false);
  }, [paused, over]);
  useEffect(() => () => useUi.setState({ groundSelection: [] }), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === ' ') { e.preventDefault(); setPaused((p) => !p); }
      if (e.key === 'Escape') useUi.setState({ groundSelection: [] });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!ground || !me || !state.galaxy) return null;
  const c = state.colonies[ground.colonyId];
  const planet = planetOf(state, c);
  const secs = Math.floor(ground.tick / 20);
  const mineSel = ground.units.filter((u) => u.alive && sel.includes(u.id));
  const won = ground.over && ground.over.winner === me;
  const close = () => {
    engine.dispatch({ type: 'GROUND_CLOSE' });
    go(won && ground.over!.captured ? { name: 'surface', colonyId: ground.colonyId } : { name: 'galaxy' });
  };

  return (
    <div className="battle-hud ground-hud">
      <header className="battle-top">
        <Side faction={ground.attacker} units={ground.units} label="Invaders" />
        <div className="battle-title">
          <div className="battle-kicker">Invasion of</div>
          <h1>{planet.name}</h1>
          <div className="battle-round">{String(Math.floor(secs / 60)).padStart(2, '0')}:{String(secs % 60).padStart(2, '0')} {paused && !over ? '· PAUSED' : ''}</div>
        </div>
        <Side faction={ground.defender} units={ground.units} label="Defenders" right />
      </header>

      {!over && (
        <>
          <aside className="panel battle-unit">
            {mineSel.length ? <Selection units={mineSel} /> : (
              <p className="panel-text">
                <b>Left-drag</b> to select troops · <b>right-click</b> ground to move, an enemy to attack · <b>middle-drag</b> pans, <b>Alt</b>+drag rotates · <b>Ctrl+A</b> all · <b>Space</b> pause · <b>F1</b> controls
              </p>
            )}
          </aside>
          <div className="battle-actions">
            {confirm ? (
              <>
                <span className="kv-hint">Troops still on the ground are lost.</span>
                <button className="btn btn-danger" onClick={() => engine.dispatch({ type: 'GROUND_RETREAT' })}>Abandon invasion</button>
                <button className="btn" onClick={() => setConfirm(false)}>Fight on</button>
              </>
            ) : (
              <>
                <button className="btn" onClick={() => setConfirm(true)}>⤺ Retreat</button>
                <button className="btn" onClick={() => useUi.setState({ groundSelection: ground.units.filter((u) => u.alive && u.faction === me).map((u) => u.id) })}>Select all</button>
                <button className={`btn ${paused ? 'btn-primary' : ''}`} onClick={() => setPaused((p) => !p)}>{paused ? '▶ Resume' : '❚❚ Pause'}</button>
              </>
            )}
          </div>
        </>
      )}

      {ground.over && (
        <div className="battle-modal">
          <div className="panel modal-card">
            <div className={`battle-kicker ${won ? 'win' : 'alert'}`}>
              {ground.over.captured ? (won ? 'Planet captured' : 'Colony lost') : won ? 'Invasion repelled' : 'Invasion failed'}
            </div>
            <h2>{planet.name}</h2>
            <div className="loss-grid">
              <Losses title="Your losses" kinds={ground.over.losses[me]} />
              <Losses title="Enemy losses" kinds={ground.over.losses[ground.attacker === me ? ground.defender : ground.attacker]} />
            </div>
            {won && ground.over.captured && <p className="panel-text">The colony and all its buildings are yours. Morale is low after the fighting.</p>}
            <div className="modal-actions">
              <button className="btn btn-primary" onClick={close}>{won && ground.over.captured ? 'Visit the colony ▸' : 'Continue ▸'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Side({ faction, units, label, right }: { faction: FactionId; units: GroundUnit[]; label: string; right?: boolean }) {
  const all = units.filter((u) => u.faction === faction);
  const alive = all.filter((u) => u.alive);
  const hp = alive.reduce((n, u) => n + u.hp, 0), max = all.reduce((n, u) => n + u.maxHp, 0);
  const count = (k: UnitId) => alive.filter((u) => u.kind === k).length;
  return (
    <div className={`battle-side ${right ? 'right' : 'left'}`} style={{ '--fc': FACTION_STYLE[faction].color } as React.CSSProperties}>
      <div className="side-name">{label} · {FACTIONS[faction].name}</div>
      <Meter value={hp} max={max} color={FACTION_STYLE[faction].color} />
      <div className="side-ships"><span>Infantry ×{count('infantry')}</span><span>Tanks ×{count('tank')}</span></div>
    </div>
  );
}

function Selection({ units }: { units: GroundUnit[] }) {
  const kinds = (['infantry', 'tank'] as UnitId[]).filter((k) => units.some((u) => u.kind === k));
  return (
    <div className="unit-card">
      <div className="panel-title">{units.length} selected</div>
      {kinds.map((k) => {
        const us = units.filter((u) => u.kind === k);
        const hp = us.reduce((n, u) => n + u.hp, 0), max = us.reduce((n, u) => n + u.maxHp, 0);
        return (
          <div key={k} className="kv">
            <div className="kv-row"><span>{UNIT_DEFS[k].name} ×{us.length}</span><b>{Math.round((hp / max) * 100)}%</b></div>
            <Meter value={hp} max={max} color={hp / max > 0.5 ? '#6fe0a0' : '#ff6b6b'} />
            <div className="kv-hint">Damage {UNIT_DEFS[k].damage} · range {UNIT_DEFS[k].range} · speed {UNIT_DEFS[k].speed}</div>
          </div>
        );
      })}
    </div>
  );
}

function Losses({ title, kinds }: { title: string; kinds?: Partial<Record<UnitId, number>> }) {
  const list = Object.entries(kinds ?? {}).filter(([, n]) => n);
  return (
    <div className="losses">
      <div className="panel-title small">{title}</div>
      {list.length === 0 ? <p className="panel-text">None</p> : list.map(([k, n]) => (
        <div key={k} className="loss-row"><span>{UNIT_DEFS[k as UnitId].name}</span><b>×{n}</b></div>
      ))}
    </div>
  );
}
