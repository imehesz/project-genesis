import { engine } from '../store/gameStore.ts';
import {
  BUILDINGS, MAX_TAX, SHIPS, itemDef, rushCost,
  type BuildingId, type Colony, type ColonyStats, type Empire, type ShipId,
} from '../engine/index.ts';
import { buildingArt, itemArt, shipArt } from './art.ts';
import { Meter, signed } from './common.tsx';

export const turnsFor = (st: ColonyStats, cost: number) => Math.max(1, Math.ceil(cost / Math.max(0.1, st.production)));

/** Population, morale, tax slider and per-turn yields. */
export function ColonyVitals({ c, st, compact }: { c: Colony; st: ColonyStats; compact?: boolean }) {
  const moraleColor = c.morale >= 60 ? '#6fe0a0' : c.morale >= 35 ? '#ffb35c' : '#ff5f5f';
  return (
    <>
      <div className="kv">
        <div className="kv-row">
          <span>Population</span>
          <b>{c.population.toFixed(1)}M <small>/ {st.capacity}M</small></b>
        </div>
        <Meter value={c.population} max={st.capacity} />
        <div className="kv-hint">{signed(st.growth, 2)}M per turn</div>
      </div>
      <div className="kv">
        <div className="kv-row">
          <span>Morale</span>
          <b style={{ color: moraleColor }}>{Math.round(c.morale)}%</b>
        </div>
        <Meter value={c.morale} max={100} color={moraleColor} marker={st.moraleTarget} />
        <div className="kv-hint">Heading toward {Math.round(st.moraleTarget)}%</div>
      </div>
      <div className="kv">
        <div className="kv-row">
          <span>Tax rate</span>
          <b>{c.taxRate}%</b>
        </div>
        <input className="slider" type="range" min={0} max={MAX_TAX} value={c.taxRate}
          onChange={(e) => engine.dispatch({ type: 'SET_TAX', colonyId: c.id, rate: +e.target.value })} />
        {!compact && <div className="kv-hint">Higher taxes earn more credits but lower morale.</div>}
      </div>
      <div className="yield-grid">
        <Yield label="Production" value={st.production.toFixed(1)} />
        <Yield label="Research" value={st.research.toFixed(1)} />
        <Yield label="Taxes" value={signed(st.taxIncome, 1)} />
        <Yield label="Upkeep" value={signed(-st.upkeep, 1)} />
        <Yield label="Net credits" value={signed(st.net, 1)} accent={st.net >= 0 ? 'good' : 'bad'} wide />
      </div>
    </>
  );
}

/** Build queue with progress, cancel and rush-buy. */
export function QueueList({ c, st, empire }: { c: Colony; st: ColonyStats; empire: Empire }) {
  const rush = rushCost(c);
  let acc = 0;
  return (
    <>
      {c.queue.length === 0 && <p className="panel-text">Empty. Pick a structure or starship to start construction.</p>}
      <ol className="queue">
        {c.queue.map((q, i) => {
          const def = itemDef(q);
          acc += def.cost - q.progress;
          const t = turnsFor(st, acc);
          return (
            <li key={i} className="queue-item">
              <img src={itemArt(q)} alt="" />
              <div className="queue-info">
                <div className="queue-name">{def.name}</div>
                <Meter value={q.progress} max={def.cost} />
                <div className="kv-hint">
                  {Math.floor(q.progress)} / {def.cost} · ready in {t} turn{t > 1 ? 's' : ''}
                </div>
              </div>
              <button className="queue-x" aria-label="Cancel"
                onClick={() => engine.dispatch({ type: 'CANCEL_QUEUE', colonyId: c.id, index: i })}>×</button>
            </li>
          );
        })}
      </ol>
      {rush !== null &&
        (rush === 0 ? (
          <div className="kv-hint">{itemDef(c.queue[0]).name} is paid for: it completes when you end the turn.</div>
        ) : (
          <button className="btn btn-ghost" disabled={empire.credits < rush}
            onClick={() => engine.dispatch({ type: 'RUSH_BUY', colonyId: c.id })}>
            Rush-buy {itemDef(c.queue[0]).name} · {rush.toLocaleString()} ¢
          </button>
        ))}
    </>
  );
}

export function BuildCard({ id, blocker, turns, onClick, active, small }: {
  id: BuildingId; blocker: string | null; turns: number; onClick: () => void; active?: boolean; small?: boolean;
}) {
  const def = BUILDINGS[id];
  return (
    <button className={`build-card ${blocker ? 'is-locked' : ''} ${active ? 'is-active' : ''} ${small ? 'is-small' : ''}`}
      disabled={!!blocker} onClick={onClick}>
      <img src={buildingArt(id)} alt="" />
      <div className="build-body">
        <div className="build-name">{def.name}</div>
        {!small && <div className="build-effect">{def.effect}</div>}
        <div className="build-cost">
          {blocker ? <span className="lock">{blocker}</span> : <>{def.cost} prod · ~{turns} turn{turns > 1 ? 's' : ''}{small ? '' : ` · upkeep ${def.upkeep} ¢`}{(def.size ?? 1) > 1 ? ' · 2×2' : ''}</>}
        </div>
        {small && !blocker && <div className="build-effect">{def.effect}</div>}
      </div>
    </button>
  );
}

export function ShipCard({ id, blocker, turns, onClick }: { id: ShipId; blocker: string | null; turns: number; onClick: () => void }) {
  const def = SHIPS[id];
  return (
    <button className={`build-card ship-card ${blocker ? 'is-locked' : ''}`} disabled={!!blocker} onClick={onClick}>
      <img src={shipArt(id)} alt="" />
      <div className="build-body">
        <div className="build-name">{def.name}</div>
        <div className="build-effect">{def.effect}</div>
        <div className="ship-stats">
          <span>Speed {def.speed}</span>
          {def.attack > 0 && <span>Attack {def.attack}</span>}
          <span>Hull {def.hull}</span>
        </div>
        <div className="build-cost">
          {blocker ? <span className="lock">Needs a shipyard</span> : <>{def.cost} prod · ~{turns} turn{turns > 1 ? 's' : ''} · upkeep {def.upkeep} ¢</>}
        </div>
      </div>
    </button>
  );
}

function Yield({ label, value, accent, wide }: { label: string; value: string; accent?: 'good' | 'bad'; wide?: boolean }) {
  return (
    <div className={`yield ${wide ? 'wide' : ''} ${accent ?? ''}`}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}
