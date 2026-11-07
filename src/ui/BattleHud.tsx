import { useEffect, useState } from 'react';
import { engine, useGame, useUi } from '../store/gameStore.ts';
import {
  FACTIONS, MAX_ROUNDS, SHIPS, SHIP_IDS, armed, rangeOf, reachableCells, targetsInRange,
  type BattleUnit, type FactionId,
} from '../engine/index.ts';
import { FACTION_STYLE } from '../theme.ts';
import { shipArt } from './art.ts';
import { Meter } from './common.tsx';

export function BattleHud() {
  const battle = useGame((s) => s.battle);
  const galaxy = useGame((s) => s.galaxy);
  const me = useGame((s) => s.campaign?.playerFaction);
  const busy = useUi((s) => s.battleBusy);
  const sel = useUi((s) => s.battleUnit);
  const select = useUi((s) => s.selectBattleUnit);
  const go = useUi((s) => s.go);
  const [engaged, setEngaged] = useState(false);
  const [confirmRetreat, setConfirmRetreat] = useState(false);
  const key = battle ? `${battle.systemId}:${battle.sides.join()}` : '';

  useEffect(() => { setEngaged(false); setConfirmRetreat(false); select(null); }, [key, select]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') select(null);
      if (e.key === 'Enter' && engaged && !busy) engine.dispatch({ type: 'BATTLE_END_ROUND' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [select, engaged, busy]);

  if (!battle || !galaxy || !me) return null;
  const foe = battle.sides.find((f) => f !== me)!;
  const sys = galaxy.systems[battle.systemId];
  const unit = sel === null ? null : battle.units.find((u) => u.uid === sel && u.alive) ?? null;
  const myTurn = battle.active === me && !battle.over;
  const fresh = !engaged && battle.round === 1 && battle.log.length === 1;

  const close = () => {
    engine.dispatch({ type: 'BATTLE_CLOSE' });
    if (!engine.getState().battle) go({ name: 'galaxy' });
  };

  return (
    <div className="battle-hud">
      <header className="battle-top">
        <Side faction={me} units={battle.units} align="left" />
        <div className="battle-title">
          <div className="battle-kicker">Battle of</div>
          <h1>{sys.name}</h1>
          <div className="battle-round">
            Round {battle.round} / {MAX_ROUNDS} · {battle.over ? 'Battle over' : busy ? 'Resolving…' : myTurn ? 'Your orders' : 'Enemy moving'}
          </div>
        </div>
        <Side faction={foe} units={battle.units} align="right" />
      </header>

      {!fresh && !battle.over && (
        <>
          <aside className="panel battle-unit">
            {unit && unit.faction === me ? <UnitCard u={unit} battle={battle} /> : (
              <p className="panel-text">Click one of your ships. Green cells: where it can move. Red rings: enemies it can hit. Each ship moves once and fires once per round.</p>
            )}
          </aside>
          <div className="battle-actions">
            {confirmRetreat ? (
              <>
                <span className="kv-hint">Enemy warships in range get a parting shot.</span>
                <button className="btn btn-danger" onClick={() => engine.dispatch({ type: 'BATTLE_RETREAT' })}>Confirm retreat</button>
                <button className="btn" onClick={() => setConfirmRetreat(false)}>Stay</button>
              </>
            ) : (
              <>
                {busy && (
                  <button className="btn" onClick={() => useUi.setState((s) => ({ battleSkip: s.battleSkip + 1 }))}>Skip ▸▸</button>
                )}
                <button className="btn" disabled={busy} onClick={() => setConfirmRetreat(true)}>⤺ Retreat</button>
                <button className="btn" disabled={busy} onClick={() => engine.dispatch({ type: 'BATTLE_AUTO' })}>⟳ Auto-resolve</button>
                <button className="btn btn-primary" disabled={busy || !myTurn} onClick={() => { select(null); engine.dispatch({ type: 'BATTLE_END_ROUND' }); }}>
                  End round ▸
                </button>
              </>
            )}
          </div>
        </>
      )}

      {fresh && (
        <div className="battle-modal">
          <div className="panel modal-card">
            <div className="battle-kicker alert">⚠ Enemy contact</div>
            <h2>{FACTIONS[foe].name} forces at {sys.name}</h2>
            <p className="panel-text">
              Your {count(battle.units, me)} ship{count(battle.units, me) === 1 ? '' : 's'} against their {count(battle.units, foe)}.
            </p>
            <div className="modal-actions">
              <button className="btn btn-primary" onClick={() => setEngaged(true)}>⚔ Engage</button>
              <button className="btn" onClick={() => { setEngaged(true); engine.dispatch({ type: 'BATTLE_AUTO' }); }}>⟳ Auto-resolve</button>
              <button className="btn" onClick={() => { setEngaged(true); engine.dispatch({ type: 'BATTLE_RETREAT' }); }}>⤺ Retreat</button>
            </div>
          </div>
        </div>
      )}

      {battle.over && busy && (
        <div className="battle-actions">
          <button className="btn" onClick={() => useUi.setState((s) => ({ battleSkip: s.battleSkip + 1 }))}>Skip ▸▸</button>
        </div>
      )}

      {battle.over && !busy && (
        <div className="battle-modal">
          <div className="panel modal-card">
            <div className={`battle-kicker ${battle.over.winner === me ? 'win' : battle.over.winner ? 'alert' : ''}`}>
              {battle.over.winner === me ? 'Victory' : battle.over.reason === 'retreat' && battle.over.winner !== me ? 'Withdrawn' : battle.over.winner ? 'Defeat' : 'Standoff'}
            </div>
            <h2>{sys.name}</h2>
            <div className="loss-grid">
              <Losses title="Your losses" ships={battle.over.losses[me]} />
              <Losses title={`${FACTION_STYLE[foe].short} losses`} ships={battle.over.losses[foe]} />
            </div>
            <div className="modal-actions">
              <button className="btn btn-primary" onClick={close}>Continue ▸</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const count = (units: BattleUnit[], f: FactionId) => units.filter((u) => u.alive && u.faction === f).length;

function Side({ faction, units, align }: { faction: FactionId; units: BattleUnit[]; align: 'left' | 'right' }) {
  const alive = units.filter((u) => u.faction === faction && u.alive);
  const hp = alive.reduce((n, u) => n + u.hp, 0), max = units.filter((u) => u.faction === faction).reduce((n, u) => n + u.maxHp, 0);
  return (
    <div className={`battle-side ${align}`} style={{ '--fc': FACTION_STYLE[faction].color } as React.CSSProperties}>
      <div className="side-name">{FACTIONS[faction].name}</div>
      <Meter value={hp} max={max} color={FACTION_STYLE[faction].color} />
      <div className="side-ships">
        {SHIP_IDS.map((s) => {
          const n = alive.filter((u) => u.ship === s).length;
          return n ? <span key={s}>{SHIPS[s].name} ×{n}</span> : null;
        })}
      </div>
    </div>
  );
}

function UnitCard({ u, battle }: { u: BattleUnit; battle: NonNullable<ReturnType<typeof useGame.getState>['battle']> }) {
  const def = SHIPS[u.ship];
  const canMove = reachableCells(battle, u.uid).length > 0;
  const targets = targetsInRange(battle, u.uid).length;
  return (
    <div className="unit-card">
      <img src={shipArt(u.ship)} alt="" />
      <div className="panel-title">{def.name}</div>
      <div className="kv-row"><span>Hull</span><b>{u.hp} / {u.maxHp}</b></div>
      <Meter value={u.hp} max={u.maxHp} color={u.hp / u.maxHp > 0.5 ? '#6fe0a0' : '#ff6b6b'} />
      {u.faction === 'apex' && <div className="kv-hint">Shield {u.shield} (refills each round)</div>}
      {u.faction === 'saurian' && <div className="kv-hint">Regenerative armor: +1 hull per round</div>}
      <div className="unit-stats">
        <span className={u.moved ? 'used' : ''}>Move {def.move}{u.moved ? ' ✓' : canMove ? '' : ' (blocked)'}</span>
        {armed(u.ship) ? <span className={u.fired ? 'used' : ''}>Attack {def.attack} · range {rangeOf(u)}{u.fired ? ' ✓' : targets ? ` · ${targets} in range` : ''}</span> : <span>Unarmed</span>}
      </div>
    </div>
  );
}

function Losses({ title, ships }: { title: string; ships?: Partial<Record<string, number>> }) {
  const list = Object.entries(ships ?? {}).filter(([, n]) => n);
  return (
    <div className="losses">
      <div className="panel-title small">{title}</div>
      {list.length === 0 ? <p className="panel-text">None</p> : list.map(([s, n]) => (
        <div key={s} className="loss-row">
          <img src={shipArt(s as never)} alt="" />
          <span>{SHIPS[s as keyof typeof SHIPS].name}</span>
          <b>×{n}</b>
        </div>
      ))}
    </div>
  );
}
