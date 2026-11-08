import type { Colony, FactionId, Fleet, GameState, TurnEvent } from './types.ts';
import { UNITS, TRANSPORT_LOAD, unitStats, type UnitId } from './data/units.ts';
import { FACTIONS } from './factions.ts';
import { nextRandom } from './rng.ts';
import { surfaceOf } from './land.ts';
import { armed } from './battle.ts';
import { colonyIdOf } from './planets.ts';
import { shipCount } from './fleets.ts';
import { SHIP_IDS } from './data/ships.ts';
import type { Surface } from './surface.ts';

export const TICK_S = 0.05;
const AGGRO = 3; // cells beyond weapon range at which idle units engage

/** How far a unit notices enemies and moves in on them by itself (its "sight"), in surface cells. */
export function sightOf(u: { range: number }): number {
  return u.range + AGGRO;
}
const HOLD_TICKS = 400; // defenders hold their ground for the first 20 s
const REPATH_TICKS = 10;

export interface GroundUnit {
  id: number;
  faction: FactionId;
  kind: UnitId;
  /** Continuous surface-cell coordinates (cell centres on integers). */
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  damage: number;
  range: number;
  speed: number;
  cooldown: number;
  reload: number;
  order: { type: 'move'; x: number; y: number } | { type: 'attack'; id: number } | null;
  target: number | null;
  path: [number, number][];
  repath: number;
  facing: number;
  alive: boolean;
}

export interface Shot {
  tick: number;
  from: number;
  to: number;
  kill: boolean;
}

export interface GroundBattle {
  colonyId: string;
  attacker: FactionId;
  defender: FactionId;
  units: GroundUnit[];
  tick: number;
  rng: number;
  /** Recent shots, for the renderer (trimmed). */
  shots: Shot[];
  over: { winner: FactionId; captured: boolean; losses: Partial<Record<FactionId, Partial<Record<UnitId, number>>>> } | null;
}

// ---------------------------------------------------------------- setup

export function invadeBlocker(state: GameState, f: Fleet, planetId: number): string | null {
  if (state.battle || state.ground) return 'Another battle is in progress';
  if (f.at === null) return 'Fleet is not at a star system';
  if (!(f.ships.transport ?? 0)) return 'Needs a Troop Transport';
  const c = state.colonies[colonyIdOf(f.at, planetId)];
  if (!c || c.faction === f.faction) return 'No enemy colony there';
  const guarded = Object.values(state.fleets).some(
    (o) => o.at === f.at && o.faction !== f.faction && SHIP_IDS.some((s) => armed(s) && (o.ships[s] ?? 0) > 0),
  );
  if (guarded) return 'Enemy warships control the orbit';
  return null;
}

export function garrisonOf(c: Colony): Record<UnitId, number> {
  const terran = c.faction === 'terran' ? 1.5 : 1;
  const fab = c.structures.some((s) => s.building === 'fabricator') ? 1 : 0;
  return {
    infantry: Math.round((2 + Math.floor(c.population / 2)) * terran),
    tank: Math.round((Math.floor(c.population / 4) + fab) * terran),
  };
}

/** Land every transport in the fleet on the planet; the colony's garrison deploys around its centre. */
export function invade(state: GameState, actor: FactionId, fleetId: number, planetId: number): GameState {
  const f = state.fleets[fleetId];
  if (!f || f.faction !== actor || invadeBlocker(state, f, planetId)) return state;
  const colonyId = colonyIdOf(f.at!, planetId);
  const c = state.colonies[colonyId];
  const s = surfaceOf(state, c);
  const transports = f.ships.transport ?? 0;

  const g: GroundBattle = {
    colonyId, attacker: actor, defender: c.faction, units: [], tick: 0, shots: [], over: null,
    rng: (state.galaxy!.seed ^ Math.imul(state.turn + 11, 2246822519) ^ Math.imul(f.at! + 3, 3266489917)) | 0,
  };
  // everyone deploys inside the largest connected land region, so every unit can reach every other
  const free = largestRegion(s);
  const region = new Set(free);
  const c0 = colonyCenter(c, s);
  const anchor = free.reduce((b, i) => (d2(i, c0, s.w) < d2(b, c0, s.w) ? i : b), free[0]);
  const center: [number, number] = region.has(Math.round(c0[1]) * s.w + Math.round(c0[0])) ? c0 : [anchor % s.w, Math.floor(anchor / s.w)];
  const taken = new Set<number>();
  const deploy = (faction: FactionId, kinds: Record<UnitId, number>, near: [number, number]) => {
    const cells = free
      .filter((i) => !taken.has(i))
      .sort((a, b) => d2(a, near, s.w) - d2(b, near, s.w) || a - b);
    let k = 0;
    for (const kind of ['tank', 'infantry'] as UnitId[])
      for (let n = 0; n < kinds[kind]; n++) {
        const cell = cells[k++];
        if (cell === undefined) return;
        taken.add(cell);
        const st = unitStats(kind, faction);
        g.units.push({
          id: g.units.length + 1, faction, kind, x: cell % s.w, y: Math.floor(cell / s.w),
          hp: st.hp, maxHp: st.hp, damage: st.damage, range: st.range, speed: st.speed, cooldown: st.cooldown,
          reload: 0, order: null, target: null, path: [], repath: 0, facing: 0, alive: true,
        });
      }
  };
  deploy(c.faction, garrisonOf(c), center);
  const lz = landingZone(s, center, free);
  deploy(actor, { infantry: TRANSPORT_LOAD.infantry * transports, tank: TRANSPORT_LOAD.tank * transports }, lz);
  for (const u of g.units) u.facing = Math.atan2(center[1] - u.y, center[0] - u.x);

  // the transports are spent landing the troops
  const ships: Fleet['ships'] = { ...f.ships };
  delete ships.transport;
  const fleets = { ...state.fleets } as Partial<GameState['fleets']>;
  if (!shipCount({ ...f, ships })) delete fleets[fleetId];
  else fleets[fleetId] = { ...f, ships };
  return { ...state, fleets: fleets as GameState['fleets'], ground: g };
}

function colonyCenter(c: Colony, s: Surface): [number, number] {
  if (!c.structures.length) return [(s.w - 1) / 2, (s.h - 1) / 2];
  const x = c.structures.reduce((n, t) => n + t.x, 0) / c.structures.length;
  const y = c.structures.reduce((n, t) => n + t.y, 0) / c.structures.length;
  return [x, y];
}

function largestRegion(s: Surface): number[] {
  const seen = new Set<number>();
  let best: number[] = [];
  s.kinds.forEach((k, i) => {
    if (k !== 'land' || seen.has(i)) return;
    const r = flood(s, i);
    r.forEach((j) => seen.add(j));
    if (r.length > best.length) best = r;
  });
  return best.sort((a, b) => a - b);
}
const d2 = (i: number, p: [number, number], w: number) => ((i % w) - p[0]) ** 2 + (Math.floor(i / w) - p[1]) ** 2;

/** Far from the colony, on land that the colony can be reached from. */
function landingZone(s: Surface, center: [number, number], free: number[]): [number, number] {
  let best = free[0], bestD = -1;
  for (const i of free) {
    // prefer roomy spots: count land neighbours within 2 cells
    let room = 0;
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const x = (i % s.w) + dx, y = Math.floor(i / s.w) + dy;
        if (x >= 0 && y >= 0 && x < s.w && y < s.h && s.kinds[y * s.w + x] === 'land') room++;
      }
    const score = Math.sqrt(d2(i, center, s.w)) + room * 0.4;
    if (room >= 12 && score > bestD) [best, bestD] = [i, score];
  }
  return [best % s.w, Math.floor(best / s.w)];
}

function flood(s: Surface, start: number): number[] {
  const seen = new Set([start]);
  const q = [start];
  while (q.length) {
    const i = q.shift()!;
    const x = i % s.w, y = Math.floor(i / s.w);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, n = ny * s.w + nx;
      if (nx < 0 || ny < 0 || nx >= s.w || ny >= s.h || seen.has(n) || s.kinds[n] !== 'land') continue;
      seen.add(n);
      q.push(n);
    }
  }
  return [...seen];
}

// ---------------------------------------------------------------- pathfinding

const passable = (s: Surface, x: number, y: number) => x >= 0 && y >= 0 && x < s.w && y < s.h && s.kinds[y * s.w + x] === 'land';

/** A* over land cells, 8-way without cutting corners. Returns cell waypoints (excluding the start). */
export function findPath(s: Surface, sx: number, sy: number, tx: number, ty: number): [number, number][] {
  sx = Math.round(sx); sy = Math.round(sy); tx = Math.round(tx); ty = Math.round(ty);
  if (!passable(s, tx, ty)) {
    // aim for the nearest passable cell to the target
    let best: [number, number] | null = null, bd = Infinity;
    for (let r = 1; r < 6 && !best; r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++)
          if (passable(s, tx + dx, ty + dy) && dx * dx + dy * dy < bd) [best, bd] = [[tx + dx, ty + dy], dx * dx + dy * dy];
    if (!best) return [];
    [tx, ty] = best;
  }
  const w = s.w, start = sy * w + sx, goal = ty * w + tx;
  const g = new Map<number, number>([[start, 0]]);
  const came = new Map<number, number>();
  const open: [number, number][] = [[octile(sx, sy, tx, ty), start]];
  const closed = new Set<number>();
  while (open.length) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i][0] < open[bi][0]) bi = i;
    const [, cur] = open.splice(bi, 1)[0];
    if (cur === goal) break;
    if (closed.has(cur)) continue;
    closed.add(cur);
    const cx = cur % w, cy = Math.floor(cur / w);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = cx + dx, ny = cy + dy;
        if (!passable(s, nx, ny)) continue;
        if (dx && dy && (!passable(s, cx + dx, cy) || !passable(s, cx, cy + dy))) continue;
        const n = ny * w + nx;
        const cost = g.get(cur)! + (dx && dy ? Math.SQRT2 : 1);
        if (cost < (g.get(n) ?? Infinity)) {
          g.set(n, cost);
          came.set(n, cur);
          open.push([cost + octile(nx, ny, tx, ty), n]);
        }
      }
  }
  if (!came.has(goal) && goal !== start) return [];
  const path: [number, number][] = [];
  for (let c = goal; c !== start; c = came.get(c)!) path.push([c % w, Math.floor(c / w)]);
  return path.reverse();
}

function octile(ax: number, ay: number, bx: number, by: number) {
  const dx = Math.abs(ax - bx), dy = Math.abs(ay - by);
  return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
}

// ---------------------------------------------------------------- simulation

function rand(g: GroundBattle) {
  const [v, n] = nextRandom(g.rng);
  g.rng = n;
  return v;
}

const dist = (a: GroundUnit, b: GroundUnit) => Math.hypot(a.x - b.x, a.y - b.y);

/** One 50 ms step of the ground battle. Pure: returns a new state. */
export function groundTick(state: GameState): GameState {
  const g0 = state.ground;
  if (!g0 || g0.over) return state;
  const g: GroundBattle = structuredClone(g0);
  const c = state.colonies[g.colonyId];
  const s = surfaceOf(state, c);
  g.tick++;
  const player = state.campaign?.playerFaction;
  const byId = new Map(g.units.map((u) => [u.id, u]));
  const live = g.units.filter((u) => u.alive);

  for (const u of live) {
    if (!u.alive) continue;
    const foes = live.filter((e) => e.alive && e.faction !== u.faction);
    // pick a target
    let target: GroundUnit | null = null;
    if (u.order?.type === 'attack') {
      const t = byId.get(u.order.id);
      if (t?.alive) target = t;
      else u.order = null;
    }
    if (!target && u.order?.type !== 'move') {
      const cur = u.target !== null ? byId.get(u.target) : undefined;
      const reach = u.range + AGGRO;
      if (cur?.alive && dist(u, cur) <= reach) target = cur;
      else {
        const hunt = u.faction !== player && (u.faction !== g.defender || g.tick > HOLD_TICKS);
        let best: GroundUnit | null = null, bd = Infinity;
        for (const e of foes) {
          const d = dist(u, e);
          if ((d <= reach || hunt) && d < bd) [best, bd] = [e, d];
        }
        target = best;
      }
    }
    u.target = target?.id ?? null;
    u.reload = Math.max(0, u.reload - 1);

    if (target && dist(u, target) <= u.range) {
      // in range: stop and shoot
      u.path = [];
      u.facing = Math.atan2(target.y - u.y, target.x - u.x);
      if (u.reload === 0) {
        const dmg = Math.round(u.damage * (0.85 + rand(g) * 0.3));
        target.hp = Math.max(0, target.hp - dmg);
        u.reload = u.cooldown;
        const kill = target.hp <= 0;
        if (kill) target.alive = false;
        g.shots.push({ tick: g.tick, from: u.id, to: target.id, kill });
      }
      continue;
    }
    // move: toward the target, or along the ordered path
    if (target) {
      if (--u.repath <= 0 || !u.path.length) {
        u.path = findPath(s, u.x, u.y, target.x, target.y);
        u.repath = REPATH_TICKS;
      }
    } else if (u.order?.type === 'move' && !u.path.length) {
      if (Math.hypot(u.x - u.order.x, u.y - u.order.y) < 0.3) u.order = null;
    }
    step(u);
  }

  separate(g.units.filter((u) => u.alive), s);
  if (g.shots.length > 80) g.shots = g.shots.slice(-80);

  const alive = (f: FactionId) => g.units.some((u) => u.alive && u.faction === f);
  if (!alive(g.defender)) return finishGround(state, g, g.attacker);
  if (!alive(g.attacker)) return finishGround(state, g, g.defender);
  return { ...state, ground: g };
}

function step(u: GroundUnit) {
  let budget = u.speed * TICK_S;
  while (budget > 0 && u.path.length) {
    const [px, py] = u.path[0];
    const dx = px - u.x, dy = py - u.y, d = Math.hypot(dx, dy);
    u.facing = Math.atan2(dy, dx);
    if (d <= budget) {
      u.x = px; u.y = py;
      budget -= d;
      u.path.shift();
    } else {
      u.x += (dx / d) * budget;
      u.y += (dy / d) * budget;
      budget = 0;
    }
  }
}

/** Keep units from stacking on one spot (only nudges onto land). */
function separate(units: GroundUnit[], s: Surface) {
  const R = 0.55;
  for (let i = 0; i < units.length; i++)
    for (let j = i + 1; j < units.length; j++) {
      const a = units[i], b = units[j];
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
      if (d >= R || d === 0) continue;
      const push = (R - d) / 2, nx = dx / d, ny = dy / d;
      if (passable(s, Math.round(a.x - nx * push), Math.round(a.y - ny * push))) { a.x -= nx * push; a.y -= ny * push; }
      if (passable(s, Math.round(b.x + nx * push), Math.round(b.y + ny * push))) { b.x += nx * push; b.y += ny * push; }
    }
}

// ---------------------------------------------------------------- orders + outcome

export function groundOrder(state: GameState, actor: FactionId, ids: number[], move?: { x: number; y: number }, attack?: number): GameState {
  const g0 = state.ground;
  if (!g0 || g0.over) return state;
  const g: GroundBattle = structuredClone(g0);
  const s = surfaceOf(state, state.colonies[g.colonyId]);
  const mine = g.units.filter((u) => u.alive && u.faction === actor && ids.includes(u.id));
  if (!mine.length) return state;
  if (attack !== undefined) {
    const t = g.units.find((u) => u.id === attack && u.alive && u.faction !== actor);
    if (!t) return state;
    for (const u of mine) { u.order = { type: 'attack', id: t.id }; u.target = t.id; u.path = []; u.repath = 0; }
  } else if (move) {
    // spread the group around the clicked point so they don't all fight for one cell
    const cols = Math.ceil(Math.sqrt(mine.length));
    mine.forEach((u, i) => {
      const ox = (i % cols) - (cols - 1) / 2, oy = Math.floor(i / cols) - (cols - 1) / 2;
      const tx = move.x + ox * 0.8, ty = move.y + oy * 0.8;
      u.order = { type: 'move', x: tx, y: ty };
      u.target = null;
      u.path = findPath(s, u.x, u.y, tx, ty);
    });
  } else return state;
  return { ...state, ground: g };
}

export function groundRetreat(state: GameState, actor: FactionId): GameState {
  const g0 = state.ground;
  if (!g0 || g0.over || g0.attacker !== actor) return state;
  const g: GroundBattle = structuredClone(g0);
  for (const u of g.units) if (u.faction === actor) u.alive = false; // stranded troops are lost
  return finishGround(state, g, g.defender);
}

function finishGround(state: GameState, g: GroundBattle, winner: FactionId): GameState {
  const losses: NonNullable<GroundBattle['over']>['losses'] = {};
  for (const u of g.units) {
    if (u.alive) continue;
    const l = (losses[u.faction] ??= {});
    l[u.kind] = (l[u.kind] ?? 0) + 1;
  }
  const captured = winner === g.attacker;
  g.over = { winner, captured, losses };
  let next: GameState = { ...state, ground: g };
  const c = state.colonies[g.colonyId];
  const planet = state.galaxy!.systems[c.systemId].planets[c.planetId];
  if (captured) next = capture(next, c, g.attacker);
  const player = state.campaign?.playerFaction;
  if (player && (g.attacker === player || g.defender === player)) {
    const ev: TurnEvent = captured
      ? { kind: g.attacker === player ? 'victory' : 'defeat', text: `${planet.name} captured by the ${FACTIONS[g.attacker].name}`, colonyId: c.id, systemId: c.systemId }
      : { kind: g.defender === player ? 'victory' : 'defeat', text: `Invasion of ${planet.name} repelled`, systemId: c.systemId };
    if (next.report) next = { ...next, report: { ...next.report, events: [...next.report.events, ev] } };
  }
  return next;
}

/** The colony changes hands, buildings and all; some citizens are lost in the fighting. */
function capture(state: GameState, c: Colony, by: FactionId): GameState {
  const galaxy = state.galaxy!;
  const systems = galaxy.systems.map((sys) => {
    if (sys.id !== c.systemId) return sys;
    const planets = sys.planets.map((p) => (p.id === c.planetId ? { ...p, colony: { faction: by, homeworld: false } } : p));
    const owners = planets.filter((p) => p.colony).map((p) => p.colony!.faction);
    return { ...sys, planets, owner: owners.includes(sys.owner!) ? sys.owner : by };
  });
  return {
    ...state,
    galaxy: { ...galaxy, systems },
    colonies: {
      ...state.colonies,
      [c.id]: { ...c, faction: by, population: Math.max(1, Math.round(c.population * 0.75 * 10) / 10), morale: 35, queue: [] },
    },
  };
}

export function groundClose(state: GameState): GameState {
  return state.ground?.over ? { ...state, ground: null } : state;
}

export { UNITS };
