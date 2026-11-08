import { useEffect, useMemo, useState } from 'react';
import { engine, landOn, startStoryCampaign, useGame, useUi } from '../store/gameStore.ts';
import {
  BUILDINGS, UNIT_DEFS, footprint, opRepairBlocker, opTrainBlocker, repairPrice, sightOf, surfaceOf, xpLevel, xpRank,
  type BuildingId, type GameState, type GroundOp, type GroundUnit, type UnitId,
} from '../engine/index.ts';
import { Meter } from './common.tsx';
import { Minimap, Objectives, type MinimapLayer } from './missionParts.tsx';
import { CELL } from '../render/views/PlanetView.ts';
import { ANCIENT_COLOR } from '../render/views/GroundBattleView.ts';

const BUILDABLE: BuildingId[] = ['solar', 'extractor', 'converter'];

/** Planet mission HUD. Real time: the clock runs while this screen is open and not paused. */
export function OpHud() {
  const state = useGame((s) => s);
  const op = state.op;
  const sel = useUi((s) => s.groundSelection);
  const structId = useUi((s) => s.opStructure);
  const placing = useUi((s) => s.opPlacing);
  const [paused, setPaused] = useState(false);
  const over = !!op?.over;
  const layer = useMemo(() => (op ? groundLayer(state) : null), [op?.colonyId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    engine.setRealtime(!paused && !over);
    return () => engine.setRealtime(false);
  }, [paused, over]);
  useEffect(() => () => useUi.setState({ groundSelection: [], opStructure: null, opPlacing: null }), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === ' ') { e.preventDefault(); setPaused((p) => !p); }
      if (e.key === 'Escape') useUi.setState({ groundSelection: [], opStructure: null, opPlacing: null });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!op || !state.mission || !layer) return null;
  const planet = state.galaxy!.systems[state.mission.systemId].planets[op.planetId];
  const secs = Math.floor(op.tick / 20);
  const mine = op.units.filter((u) => u.alive && u.faction === op.player && sel.includes(u.id));
  const struct = structId === null ? null : op.structures.find((t) => t.id === structId) ?? null;
  const inc = income(op);
  const hasConverter = op.structures.some((t) => t.building === 'converter' && t.state === 'ready');

  return (
    <div className="battle-hud op-hud">
      <header className="op-top">
        <div className="op-res">
          <span className="res res-light" title="LIGHT Particles: collected wherever there is light">LIGHT <b>{Math.floor(op.light)}</b><em>{inc.light >= 0 ? '+' : ''}{inc.light.toFixed(1)}/s</em></span>
          <span className="res res-dark" title="DARK Energy: only from dark holes, or converted from LIGHT">DARK <b>{Math.floor(op.dark)}</b><em>+{inc.dark.toFixed(1)}/s</em></span>
          {hasConverter && (
            <button className={`btn btn-small converter-btn ${op.converterOn ? 'is-on' : ''}`} onClick={() => engine.dispatch({ type: 'OP_CONVERTER', on: !op.converterOn })}>
              Converter {op.converterOn ? 'ON · 10 LIGHT → 1 DARK' : 'OFF'}
            </button>
          )}
        </div>
        <div className="battle-title">
          <div className="battle-kicker">{planet.name}</div>
          <div className="battle-round">{String(Math.floor(secs / 60)).padStart(2, '0')}:{String(secs % 60).padStart(2, '0')} {paused && !over ? '· PAUSED' : ''}</div>
        </div>
        <div />
      </header>

      <div className="op-left">
        <Objectives mission={state.mission} compact />
        <Hint state={state} />
      </div>

      {!over && (
        <>
          <aside className="panel battle-unit op-panel">
            {struct ? <StructurePanel op={op} id={struct.id} state={state} />
              : mine.length ? <Selection units={mine} />
              : (
                <p className="panel-text">
                  <b>Left-click</b> a unit or building · <b>left-drag</b> to box-select · <b>right-click</b> to move or attack · <b>Space</b> pause · <b>F1</b> controls
                </p>
              )}
          </aside>
          <div className="op-build">
            {BUILDABLE.map((b) => {
              const d = BUILDINGS[b].op!;
              const noCmd = !op.structures.some((t) => t.building === 'command' && t.state === 'ready');
              const poor = op.light < d.light || op.dark < d.dark;
              const why = noCmd ? 'Repair the Command Center first' : poor ? 'Not enough resources' : '';
              return (
                <button key={b} className={`build-chip ${placing === b ? 'is-on' : ''}`} disabled={!!why} title={why || BUILDINGS[b].effect}
                  onClick={() => useUi.setState({ opPlacing: placing === b ? null : b, opStructure: null, groundSelection: [] })}>
                  <b>{BUILDINGS[b].name}</b>
                  <Cost light={d.light} dark={d.dark} />
                </button>
              );
            })}
            {placing && <div className="kv-hint op-place-hint">Click open, explored ground{BUILDINGS[placing].op!.onHole ? ' on a dark hole' : ''} · right-click / Esc cancels</div>}
          </div>
          <div className="mission-minimap"><Minimap layer={layer} label={planet.name} /></div>
          <div className="battle-actions">
            <button className="btn" onClick={() => useUi.setState({ opStructure: null, groundSelection: op.units.filter((u) => u.alive && u.faction === op.player).map((u) => u.id) })}>Select all</button>
            <button className={`btn ${paused ? 'btn-primary' : ''}`} onClick={() => setPaused((p) => !p)}>{paused ? '▶ Resume' : '❚❚ Pause'}</button>
          </div>
        </>
      )}

      {op.over && <Debrief state={state} />}
    </div>
  );
}

function Cost({ light, dark }: { light: number; dark: number }) {
  return <span className="cost"><span className="res-light">{light} L</span> · <span className="res-dark">{dark} D</span></span>;
}

function income(op: GroundOp) {
  let light = 0, dark = 0;
  for (const t of op.structures) {
    if (t.state !== 'ready') continue;
    const d = BUILDINGS[t.building].op!;
    light += d.lightPerSec ?? 0;
    dark += d.darkPerSec ?? 0;
  }
  if (op.converterOn) {
    const n = op.structures.filter((t) => t.building === 'converter' && t.state === 'ready').length;
    light -= 5 * n;
    dark += 0.5 * n;
  }
  return { light, dark };
}

function StructurePanel({ op, id, state }: { op: GroundOp; id: number; state: GameState }) {
  const t = op.structures.find((x) => x.id === id)!;
  const def = BUILDINGS[t.building];
  const total = def.cost;
  return (
    <div className="struct-card">
      <div className="panel-title">{def.name}</div>
      <div className="kv-hint">{def.effect}</div>
      <div className="kv">
        <div className="kv-row"><span>Integrity</span><b>{Math.round((t.hp / t.maxHp) * 100)}%</b></div>
        <Meter value={t.hp} max={t.maxHp} color={t.state === 'ruin' ? '#8a8f99' : '#6fe0a0'} />
      </div>
      {t.state === 'ruin' && (() => {
        const p = repairPrice(t.building), block = opRepairBlocker(state, t.id);
        return (
          <>
            <p className="panel-text">Abandoned and damaged. It can be brought back.</p>
            <button className="btn btn-primary" disabled={!!block} title={block ?? ''} onClick={() => engine.dispatch({ type: 'OP_REPAIR', structureId: t.id })}>
              Repair · <Cost light={p.light} dark={p.dark} /> · {Math.round(total / 20)}s
            </button>
          </>
        );
      })()}
      {(t.state === 'repairing' || t.state === 'building') && (
        <div className="kv">
          <div className="kv-row"><span>{t.state === 'repairing' ? 'Repairing' : 'Under construction'}</span><b>{Math.floor((t.work / total) * 100)}%</b></div>
          <Meter value={t.work} max={total} />
        </div>
      )}
      {def.op!.trains && t.state !== 'ruin' && (
        <div className="rally-row">
          <span className="kv-hint">{t.rally ? 'Rally point set: new units head there.' : 'Right-click the map to set a rally point for new units.'}</span>
          {t.rally && <button className="link-x" title="Clear the rally point" onClick={() => engine.dispatch({ type: 'OP_RALLY', structureId: t.id, at: null })}>×</button>}
        </div>
      )}
      {t.state === 'ready' && def.op!.trains && (
        <>
          <div className="train-row">
            {def.op!.trains.map((u) => {
              const p = UNIT_DEFS[u].price!, block = opTrainBlocker(state, t.id, u);
              return (
                <button key={u} className="btn" disabled={!!block} title={block ?? ''} onClick={() => engine.dispatch({ type: 'OP_TRAIN', structureId: t.id, unit: u })}>
                  Train {UNIT_DEFS[u].name} · <Cost light={p.light} dark={p.dark} /> · {Math.round(p.ticks / 20)}s
                </button>
              );
            })}
          </div>
          {t.train.length > 0 && (
            <ul className="train-queue">
              {t.train.map((q, i) => (
                <li key={i}>
                  <span>{UNIT_DEFS[q.unit].name}</span>
                  {i === 0 && <Meter value={q.t} max={UNIT_DEFS[q.unit].price!.ticks} />}
                  <button className="link-x" title="Cancel (refund)" onClick={() => engine.dispatch({ type: 'OP_CANCEL_TRAIN', structureId: t.id, index: i })}>×</button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {t.state === 'ready' && t.building === 'converter' && (
        <button className={`btn ${op.converterOn ? 'btn-primary' : ''}`} onClick={() => engine.dispatch({ type: 'OP_CONVERTER', on: !op.converterOn })}>
          {op.converterOn ? 'Converting · click to stop' : 'Start converting 10 LIGHT → 1 DARK'}
        </button>
      )}
    </div>
  );
}

function Selection({ units }: { units: GroundUnit[] }) {
  const kinds = (['commander', 'infantry', 'tank'] as UnitId[]).filter((k) => units.some((u) => u.kind === k));
  return (
    <div className="unit-card">
      <div className="panel-title">{units.length} selected</div>
      {kinds.map((k) => {
        const us = units.filter((u) => u.kind === k);
        const hp = us.reduce((n, u) => n + u.hp, 0), max = us.reduce((n, u) => n + u.maxHp, 0);
        const vets = us.filter((u) => xpRank(u.xp ?? 0) > 0).length;
        const c = k === 'commander' ? us[0] : null;
        return (
          <div key={k} className="kv">
            <div className="kv-row"><span>{UNIT_DEFS[k].name}{k === 'commander' ? '' : ` ×${us.length}`}</span><b>{Math.round((hp / max) * 100)}%</b></div>
            <Meter value={hp} max={max} color={hp / max > 0.5 ? '#6fe0a0' : '#ff6b6b'} />
            <div className="kv-hint">
              {c ? <>Rank {'▲'.repeat(xpRank(c.xp ?? 0)) || '—'} · veterancy {Math.round(xpLevel(c.xp ?? 0) * 100)}% · </> : vets ? <>{vets} veteran{vets > 1 ? 's' : ''} · </> : null}
              <span className="rng-fire">range {UNIT_DEFS[k].range}</span> · <span className="rng-sight">sight {sightOf(UNIT_DEFS[k])}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** One line of guidance at a time: what the commander should be doing next. */
function Hint({ state }: { state: GameState }) {
  const op = state.op!, m = state.mission!;
  const st = (b: BuildingId) => op.structures.find((t) => t.building === b);
  const has = (b: BuildingId) => op.structures.some((t) => t.building === b && t.state !== 'ruin');
  const towers = op.units.filter((u) => u.kind === 'tower' && u.alive).length;
  const rune = m.objectives.find((o) => o.id === 'rune')!;
  const explore = m.objectives.find((o) => o.id === 'explore')!;
  // stuck for LIGHT? the ruined Shelters still have working solar roofs: the cheap way back
  const noLight = income(op).light <= 0;
  const shelterRuin = op.structures.some((t) => t.building === 'shelter' && t.state === 'ruin');
  const cmdRuin = st('command')?.state === 'ruin';
  const cmdPrice = repairPrice('command');
  let text = '';
  if (cmdRuin && noLight && shelterRuin && (op.light < cmdPrice.light || op.dark < cmdPrice.dark))
    text = `Not enough to repair the Command Center (${cmdPrice.light} LIGHT, ${cmdPrice.dark} DARK). Repair a Shelter first: its solar roof brings LIGHT back in, slowly.`;
  else if (rune.revealed && towers) text = `Ancient towers guard the rune (${towers} left). Two soldiers won't do: build an army first.`;
  else if (rune.revealed && !towers) text = 'The towers are down. Bring the commander to the rune.';
  else if (st('command')?.state === 'ruin') text = 'The Command Center is a ruin. Select it and repair it.';
  else if (st('barracks')?.state === 'ruin') text = 'Repair the Barracks to train soldiers.';
  else if (!has('solar')) text = 'Build Solar Collectors: they gather LIGHT anywhere in the sun.';
  else if (!has('extractor')) text = 'A dark hole lies near the colony. Build a Dark Extractor on it for DARK.';
  else if (!explore.done && !rune.revealed) text = `Send troops out to explore ${state.galaxy!.systems[m.systemId].planets[op.planetId].name}. Keep the commander safe.`;
  else text = 'Something is out there. Keep exploring.';
  return <div className="panel op-hint"><span className="op-hint-tag">Commander's log</span>{text}</div>;
}

function Debrief({ state }: { state: GameState }) {
  const op = state.op!, m = state.mission!;
  const go = useUi((s) => s.go);
  const won = op.over!.result === 'won';
  const stranded = !!op.over!.stranded;
  const sys = state.galaxy!.systems[m.systemId];
  const secs = Math.floor(op.tick / 20);
  const retry = () => {
    const snap = useUi.getState().landingSnapshot;
    if (!snap) return;
    engine.load(snap);
    landOn(op.planetId);
  };
  return (
    <div className="battle-modal">
      <div className="panel modal-card">
        <div className={`battle-kicker ${won ? 'win' : 'alert'}`}>{won ? 'Objective X complete' : 'Mission failed'}</div>
        <h2>{won ? 'The rune' : stranded ? 'Out of resources' : 'The commander has fallen'}</h2>
        <p className="panel-text">
          {won
            ? <>The commander touched the rune. {sys.planets.slice(1).map((p) => p.name).join(' and ')} are now within reach.</>
            : stranded
              ? <>{op.over!.reason} This mission can no longer be finished. Restart and spend LIGHT and DARK on what the colony needs first: the Command Center, the Barracks and a Dark Extractor.</>
              : <>Without the commander the mission is over. The colony on {sys.planets[op.planetId].name} stays silent.</>}
        </p>
        <div className="debrief-stats">
          <span>Time <b>{Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}</b></span>
          <span>Trained <b>{op.trained}</b></span>
          <span>Lost <b>{op.lost}</b></span>
        </div>
        <div className="modal-actions">
          {won ? (
            <button className="btn btn-primary" onClick={() => { engine.dispatch({ type: 'OP_CLOSE' }); useUi.setState({ selectedPlanet: 1 }); go({ name: 'cutscene', id: 'c1-rune', then: { name: 'system' } }); }}>Continue ▸</button>
          ) : (
            <>
              <button className="btn btn-primary" onClick={retry}>Restart from the landing</button>
              <button className="btn" onClick={() => { startStoryCampaign(); go({ name: 'cutscene', id: 'c1-intro', then: { name: 'system' } }); }}>Restart campaign</button>
              <button className="btn" onClick={() => { const snap = useUi.getState().landingSnapshot; if (snap) engine.load(snap); go({ name: 'menu' }); }}>Main menu</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Ground minimap: terrain, fog of war, buildings, dark holes, the rune, units. */
function groundLayer(state: GameState): MinimapLayer {
  const op = state.op!;
  const s = surfaceOf(state, state.colonies[op.colonyId]);
  const w = s.w, h = s.h;
  // map space: cell (x, y) covers [x, x+1) x [y, y+1)
  const toWorld = (x: number, y: number) => ({ x: (x - 0.5 - (w - 1) / 2) * CELL, z: (y - 0.5 - (h - 1) / 2) * CELL });
  const fromWorld = (x: number, z: number) => ({ x: x / CELL + (w - 1) / 2 + 0.5, y: z / CELL + (h - 1) / 2 + 0.5 });
  return {
    w, h, toWorld, fromWorld,
    background(g, px) {
      const k = px / Math.max(w, h);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const i = y * w + x, kind = s.kinds[i], ht = s.heights[i];
          g.fillStyle = kind === 'liquid' ? '#1d4f78' : kind === 'rough' ? `hsl(30, 8%, ${28 + Math.min(20, ht * 3)}%)` : `hsl(${100 - ht * 10}, 32%, ${26 + ht * 12}%)`;
          g.fillRect(x * k, y * k, Math.ceil(k), Math.ceil(k));
        }
    },
    overlay(g, px) {
      const o = engine.getState().op;
      if (!o) return;
      const k = px / Math.max(w, h);
      const explored = (x: number, y: number) => o.explored[Math.round(y) * w + Math.round(x)] === 1;
      for (const hole of o.holes) if (explored(hole.x, hole.y)) { g.fillStyle = '#9b5cff'; g.beginPath(); g.arc((hole.x + 0.5) * k, (hole.y + 0.5) * k, k * 0.45, 0, Math.PI * 2); g.fill(); }
      for (const t of o.structures) {
        const f = footprint(t.building);
        g.fillStyle = t.state === 'ruin' ? '#7d8390' : t.state === 'ready' ? '#5fd4ff' : '#2f7fa3';
        g.fillRect(t.x * k + 1, t.y * k + 1, f * k - 2, f * k - 2);
      }
      if (explored(o.rune.x, o.rune.y) && !o.rune.taken) {
        g.fillStyle = ANCIENT_COLOR;
        const cx = (o.rune.x + 0.5) * k, cy = (o.rune.y + 0.5) * k;
        g.beginPath(); g.moveTo(cx, cy - 5); g.lineTo(cx + 4, cy); g.lineTo(cx, cy + 5); g.lineTo(cx - 4, cy); g.closePath(); g.fill();
      }
      for (const u of o.units) {
        if (!u.alive) continue;
        const mine = u.faction === o.player;
        if (!mine && !(u.speed === 0 ? explored(u.x, u.y) : o.visible[Math.round(u.y) * w + Math.round(u.x)])) continue;
        g.fillStyle = u.kind === 'commander' ? '#ffc95a' : mine ? '#9fe6ff' : ANCIENT_COLOR;
        const r = u.kind === 'commander' ? 3.2 : u.kind === 'tower' ? 3.4 : 2.1;
        g.beginPath(); g.arc((u.x + 0.5) * k, (u.y + 0.5) * k, r, 0, Math.PI * 2); g.fill();
        if (u.kind === 'tower') { g.strokeStyle = '#000'; g.stroke(); }
      }
      // fog: black where never seen, dimmed where not watched right now
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (o.visible[i]) continue;
          g.fillStyle = o.explored[i] ? 'rgba(2,4,9,0.45)' : 'rgba(3,5,10,0.96)';
          g.fillRect(x * k, y * k, Math.ceil(k), Math.ceil(k));
        }
    },
  };
}
