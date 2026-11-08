// Planet missions: the real-time ground layer of the story campaign.
// No turns down here: the clock runs while the player is on the planet (engine.setRealtime), and
// everything (income, construction, repairs, training, fighting, fog of war) advances per 50 ms tick.

import type { BuildItem, Colony, FactionId, GameState, Structure } from './types.ts';
import { BUILDINGS, footprint, repairPrice, type BuildingId } from './data/buildings.ts';
import { UNITS, type UnitId } from './data/units.ts';
import { findPath, largestRegion, passable, separate, sightOf, step, TICK_S, type GroundUnit, type Shot } from './ground.ts';
import { surfaceOf } from './land.ts';
import { nextRandom } from './rng.ts';
import type { Surface } from './surface.ts';
import type { Mission, ObjectiveId } from './mission.ts';

/** Internal side id of the ancient defences. Never shown to the player (the species is revealed slowly). */
export const ANCIENTS: FactionId = 'apex';

const AGGRO = 3; // must match ground.ts sightOf
const REPATH_TICKS = 10;
const FOG_EVERY = 4; // ticks between fog-of-war updates
const RUNE_TOUCH = 1.1; // cells: how close the commander must get
const EXPLORE_GOAL = 0.5; // share of reachable land that counts as "explored"

/** XP (modelled on Beyond All Reason's modrules: damage share + kill bonus, scaled by target worth). */
const XP_MULT = 3;
const XP_HP = 0.5; // up to +50% max health
const XP_RELOAD = 0.3; // up to +30% rate of fire

export type OpStructureState = 'ruin' | 'repairing' | 'building' | 'ready';

export interface OpStructure {
  id: number;
  building: BuildingId;
  /** Top-left cell. */
  x: number;
  y: number;
  state: OpStructureState;
  /** Ticks of repair/construction done (complete at BUILDINGS[b].cost). */
  work: number;
  hp: number;
  maxHp: number;
  /** Training queue (head is in progress). */
  train: { unit: 'infantry' | 'tank'; t: number }[];
  /** Where freshly trained units head (cell coords), if set. */
  rally?: { x: number; y: number } | null;
}

export interface GroundOp {
  /** The colony record that holds this planet's surface (PlanetView renders it). */
  colonyId: string;
  planetId: number;
  player: FactionId;
  units: GroundUnit[];
  nextUnitId: number;
  structures: OpStructure[];
  nextStructureId: number;
  /** Dark holes: the only places DARK Energy comes out of the ground. */
  holes: { x: number; y: number }[];
  rune: { x: number; y: number; taken: boolean };
  light: number;
  dark: number;
  converterOn: boolean;
  /** Fog of war, per cell (row-major): ever seen / seen right now. */
  explored: number[];
  visible: number[];
  /** Share of reachable land explored, 0..1. */
  exploredShare: number;
  tick: number;
  rng: number;
  shots: Shot[];
  /** Combat stats for the debrief. */
  trained: number;
  lost: number;
  /** stranded: the player spent themselves into a corner and can no longer win (asked to restart). */
  over: { result: 'won' | 'lost'; reason: string; stranded?: boolean } | null;
}

// ---------------------------------------------------------------- setup

export interface OpLayout {
  base: { x: number; y: number };
  rune: { x: number; y: number };
}

/**
 * Campaign 1, planet 1: an abandoned human colony (ruins only), a dark hole beside it, two more out in
 * the wild, and the rune far away behind three ancient towers. The commander lands with two soldiers.
 */
export function createOp(state: GameState, colony: Colony, layout: OpLayout, commanderXp: number, stock: { light: number; dark: number }): GroundOp {
  const s = surfaceOf(state, colony);
  const region = largestRegion(s);
  const inRegion = new Set(region);
  const taken = new Set<number>();
  const cellsNear = (p: { x: number; y: number }) =>
    region.filter((i) => !taken.has(i)).sort((a, b) => d2(a, p, s.w) - d2(b, p, s.w) || a - b);
  const fits = (b: BuildingId, x: number, y: number) => {
    const f = footprint(b);
    for (let dy = 0; dy < f; dy++)
      for (let dx = 0; dx < f; dx++) {
        const i = (y + dy) * s.w + x + dx;
        if (x + dx >= s.w || y + dy >= s.h || !inRegion.has(i) || taken.has(i)) return false;
      }
    return true;
  };
  const claim = (b: BuildingId, x: number, y: number) => {
    const f = footprint(b);
    for (let dy = -1; dy <= f; dy++) for (let dx = -1; dx <= f; dx++) taken.add((y + dy) * s.w + x + dx); // keep a lane free around it
  };

  const op: GroundOp = {
    colonyId: colony.id, planetId: colony.planetId, player: colony.faction, units: [], nextUnitId: 1,
    structures: [], nextStructureId: 1, holes: [], rune: { x: 0, y: 0, taken: false },
    light: stock.light, dark: stock.dark, converterOn: false,
    explored: new Array(s.w * s.h).fill(0), visible: new Array(s.w * s.h).fill(0), exploredShare: 0,
    tick: 0, rng: (state.galaxy!.seed ^ 0x5bd1e995) | 0, shots: [], trained: 0, lost: 0, over: null,
  };

  // the ruined colony: Command Center in the middle, the rest around it
  const ruins: BuildingId[] = ['command', 'barracks', 'vehiclebay', 'shelter', 'shelter'];
  let anchor = layout.base;
  for (const b of ruins) {
    const spot = cellsNear(anchor).find((i) => fits(b, i % s.w, Math.floor(i / s.w)));
    if (spot === undefined) continue;
    const x = spot % s.w, y = Math.floor(spot / s.w);
    claim(b, x, y);
    const hp = BUILDINGS[b].op!.hp;
    op.structures.push({ id: op.nextStructureId++, building: b, x, y, state: 'ruin', work: 0, hp: Math.round(hp * 0.25), maxHp: hp, train: [] });
    if (b === 'command') anchor = { x: x + 0.5, y: y + 0.5 };
  }
  // dark holes: one close to the colony (always), two further out
  const holeNear = cellsNear(anchor).find((i) => Math.sqrt(d2(i, anchor, s.w)) >= 4 && fits('extractor', i % s.w, Math.floor(i / s.w)));
  const spots = [holeNear, ...[[0.5, 0.5], [layout.rune.x / s.w + 0.05, layout.rune.y / s.h + 0.28]].map(([fx, fy]) =>
    cellsNear({ x: fx * s.w, y: fy * s.h }).find((i) => fits('extractor', i % s.w, Math.floor(i / s.w))))];
  for (const i of spots) {
    if (i === undefined) continue;
    const x = i % s.w, y = Math.floor(i / s.w);
    taken.add(i);
    op.holes.push({ x, y });
  }

  // the rune, ringed by three ancient towers
  const runeCell = cellsNear(layout.rune)[0];
  op.rune = { x: runeCell % s.w, y: Math.floor(runeCell / s.w), taken: false };
  taken.add(runeCell);
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + 0.5;
    const want = { x: op.rune.x + Math.cos(a) * 2.6, y: op.rune.y + Math.sin(a) * 2.6 };
    const cell = cellsNear(want)[0];
    taken.add(cell);
    addUnit(op, 'tower', ANCIENTS, cell % s.w, Math.floor(cell / s.w), 0);
  }

  // the landing party, just outside the ruins
  const lz = cellsNear({ x: anchor.x + (layout.rune.x - anchor.x) * 0.12, y: anchor.y + (layout.rune.y - anchor.y) * 0.12 + 3 });
  const party: UnitId[] = ['commander', 'infantry', 'infantry'];
  party.forEach((kind, i) => {
    const cell = lz[i];
    taken.add(cell);
    addUnit(op, kind, op.player, cell % s.w, Math.floor(cell / s.w), kind === 'commander' ? commanderXp : 0);
  });
  for (const u of op.units) if (u.speed > 0) u.facing = Math.atan2(anchor.y - u.y, anchor.x - u.x);
  updateFog(op, s);
  return op;
}

function addUnit(op: GroundOp, kind: UnitId, faction: FactionId, x: number, y: number, xp: number): GroundUnit {
  const d = UNITS[kind];
  const u: GroundUnit = {
    id: op.nextUnitId++, faction, kind, x, y, hp: d.hp, maxHp: d.hp, damage: d.damage, range: d.range, speed: d.speed,
    cooldown: d.cooldown, reload: 0, order: null, target: null, path: [], repath: 0, facing: 0, alive: true,
    xp: 0, baseHp: d.hp, baseCooldown: d.cooldown,
  };
  applyXp(u, xp);
  u.hp = u.maxHp;
  op.units.push(u);
  return u;
}

/** Diminishing returns like BAR: bonus = xp / (xp + 1). */
export const xpLevel = (xp: number) => xp / (xp + 1);
/** 0..3 rank chevrons. */
export const xpRank = (xp: number) => { const l = xpLevel(xp); return l >= 0.7 ? 3 : l >= 0.45 ? 2 : l >= 0.2 ? 1 : 0; };

function applyXp(u: GroundUnit, xp: number) {
  const before = u.maxHp;
  u.xp = xp;
  const l = xpLevel(xp);
  u.maxHp = Math.round(u.baseHp! * (1 + XP_HP * l));
  u.cooldown = Math.max(4, Math.round(u.baseCooldown! / (1 + XP_RELOAD * l)));
  u.hp = Math.min(u.maxHp, u.hp + (u.maxHp - before));
}

function grantXp(u: GroundUnit, target: GroundUnit, dmg: number, kill: boolean) {
  if (u.speed === 0) return; // towers don't learn
  const ratio = UNITS[target.kind].power / UNITS[u.kind].power;
  let gain = 0.1 * XP_MULT * (dmg / target.maxHp) * ratio;
  if (kill) gain += 0.1 * XP_MULT * ratio;
  applyXp(u, (u.xp ?? 0) + gain);
}

// ---------------------------------------------------------------- commands

const isOp = (state: GameState, actor: FactionId) => !!state.op && !state.op.over && state.op.player === actor;
const clone = (state: GameState) => structuredClone(state.op!) as GroundOp;

export function opBuildBlocker(state: GameState, b: BuildingId, x: number, y: number): string | null {
  const op = state.op;
  if (!op) return 'No mission';
  const def = BUILDINGS[b].op;
  if (!def || def.ruinOnly) return 'Cannot be built';
  if (!op.structures.some((t) => t.building === 'command' && t.state === 'ready')) return 'Repair the Command Center first';
  if (op.light < def.light || op.dark < def.dark) return 'Not enough resources';
  const s = surfaceOf(state, state.colonies[op.colonyId]);
  const occ = opOccupancy(op, s);
  const f = footprint(b);
  for (let dy = 0; dy < f; dy++)
    for (let dx = 0; dx < f; dx++) {
      const cx = x + dx, cy = y + dy;
      if (cx < 0 || cy < 0 || cx >= s.w || cy >= s.h) return 'Off the map';
      const i = cy * s.w + cx;
      if (!op.explored[i]) return 'Unexplored ground';
      if (s.kinds[i] !== 'land') return s.kinds[i] === 'liquid' ? 'Cannot build on liquid' : 'Terrain too rough';
      if (occ[i]) return 'Occupied';
    }
  const onHole = op.holes.some((h) => h.x === x && h.y === y);
  if (def.onHole && !onHole) return 'Must stand on a dark hole';
  if (!def.onHole && op.holes.some((h) => h.x >= x && h.x < x + f && h.y >= y && h.y < y + f)) return 'Keep dark holes for extractors';
  return null;
}

/** Cells covered by structures, the rune and the towers. */
export function opOccupancy(op: GroundOp, s: Surface): boolean[] {
  const occ = new Array(s.w * s.h).fill(false);
  for (const t of op.structures) {
    const f = footprint(t.building);
    for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) occ[(t.y + dy) * s.w + t.x + dx] = true;
  }
  occ[op.rune.y * s.w + op.rune.x] = true;
  for (const u of op.units) if (u.alive && u.speed === 0) occ[Math.round(u.y) * s.w + Math.round(u.x)] = true;
  return occ;
}

export function opBuild(state: GameState, actor: FactionId, b: BuildingId, x: number, y: number): GameState {
  if (!isOp(state, actor) || opBuildBlocker(state, b, x, y)) return state;
  const op = clone(state);
  const def = BUILDINGS[b].op!;
  op.light -= def.light;
  op.dark -= def.dark;
  op.structures.push({ id: op.nextStructureId++, building: b, x, y, state: 'building', work: 0, hp: 1, maxHp: def.hp, train: [] });
  return mirror({ ...state, op });
}

export function opRepairBlocker(state: GameState, structureId: number): string | null {
  const t = state.op?.structures.find((x) => x.id === structureId);
  if (!t || t.state !== 'ruin') return 'Nothing to repair';
  const p = repairPrice(t.building);
  if (state.op!.light < p.light || state.op!.dark < p.dark) return 'Not enough resources';
  return null;
}

export function opRepair(state: GameState, actor: FactionId, structureId: number): GameState {
  if (!isOp(state, actor) || opRepairBlocker(state, structureId)) return state;
  const op = clone(state);
  const t = op.structures.find((x) => x.id === structureId)!;
  const p = repairPrice(t.building);
  op.light -= p.light;
  op.dark -= p.dark;
  t.state = 'repairing';
  t.work = 0;
  return mirror({ ...state, op });
}

export function opTrainBlocker(state: GameState, structureId: number, unit: 'infantry' | 'tank'): string | null {
  const t = state.op?.structures.find((x) => x.id === structureId);
  if (!t || t.state !== 'ready' || !BUILDINGS[t.building].op!.trains?.includes(unit)) return 'Cannot train that here';
  const p = UNITS[unit].price!;
  if (state.op!.light < p.light || state.op!.dark < p.dark) return 'Not enough resources';
  if (t.train.length >= 8) return 'Queue full';
  return null;
}

export function opTrain(state: GameState, actor: FactionId, structureId: number, unit: 'infantry' | 'tank'): GameState {
  if (!isOp(state, actor) || opTrainBlocker(state, structureId, unit)) return state;
  const op = clone(state);
  const t = op.structures.find((x) => x.id === structureId)!;
  const p = UNITS[unit].price!;
  op.light -= p.light;
  op.dark -= p.dark;
  t.train.push({ unit, t: 0 });
  return { ...state, op };
}

export function opCancelTrain(state: GameState, actor: FactionId, structureId: number, index: number): GameState {
  if (!isOp(state, actor)) return state;
  const op = clone(state);
  const t = op.structures.find((x) => x.id === structureId);
  const item = t?.train[index];
  if (!t || !item) return state;
  const p = UNITS[item.unit].price!;
  op.light += p.light;
  op.dark += p.dark;
  t.train.splice(index, 1);
  return { ...state, op };
}

/** Set (or clear, with null) where a training building sends its new units. */
export function opRally(state: GameState, actor: FactionId, structureId: number, at: { x: number; y: number } | null): GameState {
  if (!isOp(state, actor)) return state;
  const op = clone(state);
  const t = op.structures.find((x) => x.id === structureId);
  if (!t || !BUILDINGS[t.building].op!.trains) return state;
  t.rally = at ? { x: at.x, y: at.y } : null;
  return { ...state, op };
}

export function opConverter(state: GameState, actor: FactionId, on: boolean): GameState {
  if (!isOp(state, actor)) return state;
  return { ...state, op: { ...state.op!, converterOn: on } };
}

export function opOrder(state: GameState, actor: FactionId, ids: number[], move?: { x: number; y: number }, attack?: number): GameState {
  if (!isOp(state, actor)) return state;
  const op = clone(state);
  const s = surfaceOf(state, state.colonies[op.colonyId]);
  const mine = op.units.filter((u) => u.alive && u.faction === actor && u.speed > 0 && ids.includes(u.id));
  if (!mine.length) return state;
  if (attack !== undefined) {
    const t = op.units.find((u) => u.id === attack && u.alive && u.faction !== actor);
    if (!t || !op.explored[Math.round(t.y) * s.w + Math.round(t.x)]) return state;
    for (const u of mine) { u.order = { type: 'attack', id: t.id }; u.target = t.id; u.path = []; u.repath = 0; }
  } else if (move) {
    const cols = Math.ceil(Math.sqrt(mine.length));
    mine.forEach((u, i) => {
      const ox = (i % cols) - (cols - 1) / 2, oy = Math.floor(i / cols) - (cols - 1) / 2;
      const tx = move.x + ox * 0.8, ty = move.y + oy * 0.8;
      u.order = { type: 'move', x: tx, y: ty };
      u.target = null;
      u.path = findPath(s, u.x, u.y, tx, ty);
    });
  } else return state;
  return { ...state, op };
}

/** After the debrief: the result goes back to the mission, the planet clock stops. */
export function opClose(state: GameState): GameState {
  return state.op?.over ? { ...state, op: null } : state;
}

// ---------------------------------------------------------------- dead end

/** Soldier-equivalents the commander needs to take the towers (balance: 8 lose narrowly, 10 win). */
const ARMY_NEEDED = 8;

/**
 * Can this mission still be won? A small search over what the player could still repair or build with
 * what is left (resources with a running income count as unlimited, given time). Returns why not, or null.
 * Deliberately generous: it only gives up when no order of purchases can get an army together.
 */
export function opDeadEnd(op: GroundOp): string | null {
  if (!op.units.some((u) => u.alive && u.kind === 'tower')) return null; // the way to the rune is open
  const army = op.units.filter((u) => u.alive && u.faction === op.player).reduce((n, u) => n + (u.kind === 'infantry' ? 1 : u.kind === 'tank' ? 2.5 : 0), 0);
  if (army >= ARMY_NEEDED) return null;
  const live = (t: OpStructure) => t.state !== 'ruin'; // ready, or already paid for and in progress
  const ruins = op.structures.filter((t) => t.state === 'ruin');
  const freeHoles = op.holes.filter((h) => !op.structures.some((t) => t.building === 'extractor' && t.x === h.x && t.y === h.y)).length;
  type Action = { key: string; cost: { light: number; dark: number }; gives: BuildingId; needsCommand: boolean };
  const actions: Action[] = [
    ...ruins.map((t) => ({ key: `r${t.id}`, cost: repairPrice(t.building), gives: t.building, needsCommand: false })),
    ...(['solar', 'converter'] as BuildingId[]).map((b) => ({ key: b, cost: { light: BUILDINGS[b].op!.light, dark: BUILDINGS[b].op!.dark }, gives: b, needsCommand: true })),
    ...(freeHoles ? [{ key: 'extractor', cost: { light: BUILDINGS.extractor.op!.light, dark: 0 }, gives: 'extractor' as BuildingId, needsCommand: true }] : []),
  ];
  const owned = new Set(op.structures.filter(live).map((t) => t.building));
  const seen = new Set<string>();
  const canWin = (L: number, D: number, have: Set<BuildingId>, done: string[]): boolean => {
    const key = done.slice().sort().join(',') + `|${Math.floor(L)}|${Math.floor(D)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    const lightInc = [...have].some((b) => (BUILDINGS[b].op!.lightPerSec ?? 0) > 0);
    const darkInc = have.has('extractor') || (have.has('converter') && lightInc);
    const trainer = have.has('barracks') || have.has('vehiclebay');
    if (trainer) {
      const p = UNITS.infantry.price!;
      const n = lightInc && darkInc ? Infinity : Math.min(lightInc ? Infinity : L / p.light, darkInc ? Infinity : D / p.dark);
      if (army + n >= ARMY_NEEDED) return true;
    }
    for (const a of actions) {
      if (done.includes(a.key) || (a.needsCommand && !have.has('command'))) continue;
      if ((!lightInc && L < a.cost.light) || (!darkInc && D < a.cost.dark)) continue;
      const next = new Set(have).add(a.gives);
      if (canWin(lightInc ? L : L - a.cost.light, darkInc ? D : D - a.cost.dark, next, [...done, a.key])) return true;
    }
    return false;
  };
  if (canWin(op.light, op.dark, owned, [])) return null;
  return 'There is not enough LIGHT and DARK left to raise an army that can take the towers.';
}

// ---------------------------------------------------------------- simulation

function rand(op: GroundOp) {
  const [v, n] = nextRandom(op.rng);
  op.rng = n;
  return v;
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const d2 = (i: number, p: { x: number; y: number }, w: number) => ((i % w) - p.x) ** 2 + (Math.floor(i / w) - p.y) ** 2;
const centerOf = (t: OpStructure) => { const f = footprint(t.building); return { x: t.x + (f - 1) / 2, y: t.y + (f - 1) / 2 }; };

/** One 50 ms step of the planet mission. Pure: returns a new state. */
export function opTick(state: GameState): GameState {
  const op0 = state.op;
  if (!op0 || op0.over) return state;
  const op = clone(state);
  const colony = state.colonies[op.colonyId];
  const s = surfaceOf(state, colony);
  op.tick++;
  let layoutChanged = false;

  // --- economy: income, conversion
  for (const t of op.structures) {
    if (t.state !== 'ready') continue;
    const d = BUILDINGS[t.building].op!;
    op.light += (d.lightPerSec ?? 0) * TICK_S;
    op.dark += (d.darkPerSec ?? 0) * TICK_S;
  }
  if (op.converterOn && op.structures.some((t) => t.building === 'converter' && t.state === 'ready')) {
    const n = op.structures.filter((t) => t.building === 'converter' && t.state === 'ready').length;
    const want = 5 * n * TICK_S;
    if (op.light >= want) { op.light -= want; op.dark += want / 10; }
  }

  // --- construction + repairs
  for (const t of op.structures) {
    if (t.state !== 'building' && t.state !== 'repairing') continue;
    t.work++;
    const total = BUILDINGS[t.building].cost;
    t.hp = Math.max(t.hp, Math.round(t.maxHp * (t.state === 'repairing' ? 0.25 + 0.75 * (t.work / total) : t.work / total)));
    if (t.work >= total) { t.state = 'ready'; t.hp = t.maxHp; layoutChanged = true; }
    else if (t.state === 'building') layoutChanged = true; // hologram progress
  }

  // --- training
  for (const t of op.structures) {
    if (t.state !== 'ready' || !t.train.length) continue;
    const head = t.train[0];
    head.t++;
    if (head.t < UNITS[head.unit].price!.ticks) continue;
    t.train.shift();
    const spawn = freeCellNear(op, s, centerOf(t), footprint(t.building));
    if (spawn) {
      const u = addUnit(op, head.unit, op.player, spawn.x, spawn.y, 0);
      u.facing = Math.atan2(spawn.y - centerOf(t).y, spawn.x - centerOf(t).x);
      op.trained++;
      if (t.rally) {
        // fan the arrivals out a little around the rally point so they don't queue on one spot
        const k = op.trained, a = k * 2.39996, r = 0.5 * Math.sqrt(k % 9);
        const tx = t.rally.x + Math.cos(a) * r, ty = t.rally.y + Math.sin(a) * r;
        u.order = { type: 'move', x: tx, y: ty };
        u.path = findPath(s, u.x, u.y, tx, ty);
      }
    }
  }

  // --- units
  const byId = new Map(op.units.map((u) => [u.id, u]));
  const live = op.units.filter((u) => u.alive);
  for (const u of live) {
    if (!u.alive) continue;
    const isTower = u.speed === 0;
    let target: GroundUnit | null = null;
    if (u.order?.type === 'attack') {
      const t = byId.get(u.order.id);
      if (t?.alive) target = t;
      else u.order = null;
    }
    if (!target && u.order?.type !== 'move') {
      const reach = isTower ? u.range : u.range + AGGRO;
      const cur = u.target !== null ? byId.get(u.target) : undefined;
      if (cur?.alive && dist(u, cur) <= reach) target = cur;
      else {
        let best: GroundUnit | null = null, bd = Infinity;
        for (const e of live) {
          if (!e.alive || e.faction === u.faction) continue;
          const d = dist(u, e);
          if (d <= reach && d < bd) [best, bd] = [e, d];
        }
        target = best;
      }
    }
    u.target = target?.id ?? null;
    u.reload = Math.max(0, u.reload - 1);

    if (target && dist(u, target) <= u.range) {
      u.path = [];
      u.facing = Math.atan2(target.y - u.y, target.x - u.x);
      if (u.reload === 0) {
        const dmg = Math.min(target.hp, Math.round(u.damage * (1 + 0.1 * xpLevel(u.xp ?? 0)) * (0.85 + rand(op) * 0.3)));
        target.hp -= dmg;
        u.reload = u.cooldown;
        const kill = target.hp <= 0;
        if (kill) {
          target.alive = false;
          if (target.faction === op.player) op.lost++;
        }
        grantXp(u, target, dmg, kill);
        op.shots.push({ tick: op.tick, from: u.id, to: target.id, kill });
      }
      continue;
    }
    if (isTower) continue;
    if (target) {
      if (--u.repath <= 0 || !u.path.length) {
        u.path = findPath(s, u.x, u.y, target.x, target.y);
        u.repath = REPATH_TICKS;
      }
    } else if (u.order?.type === 'move' && !u.path.length) {
      // keep looking for a way until the destination (or the closest reachable spot) is reached
      if (Math.hypot(u.x - u.order.x, u.y - u.order.y) < 0.6) u.order = null;
      else if (--u.repath <= 0) {
        u.path = findPath(s, u.x, u.y, u.order.x, u.order.y);
        u.repath = REPATH_TICKS;
        if (!u.path.length) u.order = null; // already as close as the terrain allows
      }
    }
    step(u);
    // not getting any closer to the next waypoint (the crowd keeps pushing back, or a corner): skip it,
    // and if it was the last one, call it arrived
    if (u.path.length) {
      const d = Math.hypot(u.path[0][0] - u.x, u.path[0][1] - u.y);
      if (u.wpd === undefined || d < u.wpd - 0.02) { u.wpd = d; u.stall = 0; }
      else if ((u.stall = (u.stall ?? 0) + 1) > 24) {
        u.path.shift();
        u.wpd = undefined;
        u.stall = 0;
        if (!u.path.length && u.order?.type === 'move' && !target) u.order = null;
      }
    }
  }
  separate(op.units.filter((u) => u.alive), s);
  if (op.shots.length > 80) op.shots = op.shots.slice(-80);

  // --- fog of war
  if (op.tick % FOG_EVERY === 0) updateFog(op, s);

  let next: GameState = { ...state, op };
  if (layoutChanged) next = mirror(next);

  // --- objectives + outcome
  const commander = op.units.find((u) => u.kind === 'commander');
  if (!commander?.alive) {
    op.over = { result: 'lost', reason: 'The commander has fallen.' };
    return next;
  }
  if (op.tick % 20 === 0) {
    const why = opDeadEnd(op);
    if (why) { op.over = { result: 'lost', reason: why, stranded: true }; return next; }
  }
  const m = next.mission;
  if (m) {
    const done = (id: ObjectiveId) => m.objectives.find((o) => o.id === id)?.done;
    const ready = (b: BuildingId) => op.structures.some((t) => t.building === b && t.state === 'ready');
    let mission: Mission | null = null;
    const patch = (id: ObjectiveId, p: Partial<Mission['objectives'][number]>) => {
      mission ??= structuredClone(m);
      Object.assign(mission.objectives.find((o) => o.id === id)!, p);
    };
    if (!done('revive') && ready('command') && ready('barracks')) patch('revive', { done: true });
    if (!done('explore') && op.exploredShare >= EXPLORE_GOAL) patch('explore', { done: true });
    const runeSeen = op.visible[op.rune.y * s.w + op.rune.x] === 1;
    if (runeSeen && !m.objectives.find((o) => o.id === 'rune')?.revealed) patch('rune', { revealed: true });
    if (dist(commander, op.rune) <= RUNE_TOUCH) {
      op.rune.taken = true;
      patch('rune', { revealed: true, done: true });
      op.over = { result: 'won', reason: 'The commander touched the rune.' };
    }
    if (mission) next = { ...next, mission };
  }
  return next;
}

function freeCellNear(op: GroundOp, s: Surface, c: { x: number; y: number }, f: number): { x: number; y: number } | null {
  const occ = opOccupancy(op, s);
  const r0 = f / 2 + 0.6;
  let best: { x: number; y: number } | null = null, bd = Infinity;
  for (let y = Math.floor(c.y - 4); y <= c.y + 4; y++)
    for (let x = Math.floor(c.x - 4); x <= c.x + 4; x++) {
      if (!passable(s, x, y) || occ[y * s.w + x]) continue;
      const d = Math.hypot(x - c.x, y - c.y);
      if (d < r0) continue;
      const crowd = op.units.filter((u) => u.alive && Math.hypot(u.x - x, u.y - y) < 0.6).length;
      const score = d + crowd * 2 + (y < c.y ? 0.5 : 0); // prefer the front (camera side)
      if (score < bd) [best, bd] = [{ x, y }, score];
    }
  return best;
}

function updateFog(op: GroundOp, s: Surface) {
  const vis = new Array(s.w * s.h).fill(0);
  const reveal = (cx: number, cy: number, r: number) => {
    const r2 = r * r;
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(s.h - 1, Math.ceil(cy + r)); y++)
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(s.w - 1, Math.ceil(cx + r)); x++)
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r2) vis[y * s.w + x] = 1;
  };
  for (const u of op.units) if (u.alive && u.faction === op.player) reveal(u.x, u.y, sightOf(u));
  for (const t of op.structures) if (t.state === 'ready') { const c = centerOf(t); reveal(c.x, c.y, BUILDINGS[t.building].op!.vision); }
  op.visible = vis;
  let land = 0, seen = 0;
  for (let i = 0; i < vis.length; i++) {
    if (vis[i]) op.explored[i] = 1;
    if (s.kinds[i] === 'land') { land++; if (op.explored[i]) seen++; }
  }
  op.exploredShare = land ? seen / land : 1;
}

/**
 * The colony record mirrors the mission's structures so the surface view (PlanetView) can draw them:
 * standing buildings (ruined or not) as structures, new construction as queue items with progress.
 */
function mirror(state: GameState): GameState {
  const op = state.op!;
  const c = state.colonies[op.colonyId];
  const structures: Structure[] = op.structures.filter((t) => t.state !== 'building').map((t) => ({ id: t.id, building: t.building, x: t.x, y: t.y }));
  const queue: (BuildItem & { progress: number })[] = op.structures
    .filter((t) => t.state === 'building')
    .map((t) => ({ kind: 'building', id: t.building, x: t.x, y: t.y, progress: t.work }));
  return { ...state, colonies: { ...state.colonies, [c.id]: { ...c, structures, queue, nextStructureId: op.nextStructureId } } };
}

export { mirror as mirrorOpColony };
