import type { FactionId, Fleet, GameState, TurnEvent } from './types.ts';
import { SHIPS, SHIP_IDS, type ShipId } from './data/ships.ts';
import { FACTIONS } from './factions.ts';
import { nextRandom } from './rng.ts';
import { dist, shipCount } from './fleets.ts';

export const BATTLE_W = 14;
export const BATTLE_H = 9;
export const MAX_ROUNDS = 15;

export interface BattleUnit {
  uid: number;
  faction: FactionId;
  fleetId: number;
  ship: ShipId;
  hp: number;
  maxHp: number;
  /** Apex only: absorbs damage, refills each round. */
  shield: number;
  x: number;
  y: number;
  moved: boolean;
  fired: boolean;
  alive: boolean;
}

export type BattleAction =
  | { t: 'move'; uid: number; x: number; y: number }
  | { t: 'fire'; uid: number; target: number; dmg: number; absorbed: number }
  | { t: 'destroyed'; uid: number }
  | { t: 'repair'; uid: number; amount: number }
  | { t: 'round'; n: number }
  | { t: 'retreat'; faction: FactionId; uid?: number };

export interface BattleResult {
  winner: FactionId | null;
  reason: 'destroyed' | 'retreat' | 'stalemate';
  losses: Partial<Record<FactionId, Partial<Record<ShipId, number>>>>;
}

export interface Battle {
  systemId: number;
  /** [first to act (the player, if involved), second]. */
  sides: [FactionId, FactionId];
  units: BattleUnit[];
  rocks: number[];
  round: number;
  /** Whose part of the round it is. */
  active: FactionId;
  log: BattleAction[];
  rng: number;
  over: BattleResult | null;
}

const idx = (x: number, y: number) => y * BATTLE_W + x;
const cheb = (ax: number, ay: number, bx: number, by: number) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));
export const armed = (s: ShipId) => SHIPS[s].attack > 0;
export const rangeOf = (u: BattleUnit) => SHIPS[u.ship].range + (u.faction === 'terran' && armed(u.ship) ? 1 : 0);
const APEX_SHIELD = 3;
const SAURIAN_REPAIR = 1;

function rand(b: Battle): number {
  const [v, n] = nextRandom(b.rng);
  b.rng = n;
  return v;
}

/** Build the tactical map: attacker on the left, defender on the right, warships in front. */
export function setupBattle(state: GameState, systemId: number, sides: [FactionId, FactionId]): Battle {
  const b: Battle = {
    systemId, sides, units: [], rocks: [], round: 1, active: sides[0], log: [{ t: 'round', n: 1 }],
    rng: (state.galaxy!.seed ^ Math.imul(systemId + 7, 2654435761) ^ Math.imul(state.turn, 40503)) | 0, over: null,
  };
  // asteroid field in the middle columns
  const nRocks = 6 + Math.floor(rand(b) * 6);
  while (b.rocks.length < nRocks) {
    const x = 4 + Math.floor(rand(b) * (BATTLE_W - 8)), y = Math.floor(rand(b) * BATTLE_H);
    if (!b.rocks.includes(idx(x, y))) b.rocks.push(idx(x, y));
  }
  let uid = 1;
  sides.forEach((f, side) => {
    const ships: [number, ShipId][] = [];
    for (const fl of fleetsAt(state, systemId, f))
      for (const s of SHIP_IDS) for (let i = 0; i < (fl.ships[s] ?? 0); i++) ships.push([fl.id, s]);
    // warships take the front column, support ships behind
    ships.sort((a, c) => Number(armed(c[1])) - Number(armed(a[1])));
    const cols = side === 0 ? [2, 1, 0] : [BATTLE_W - 3, BATTLE_W - 2, BATTLE_W - 1];
    const order = [4, 3, 5, 2, 6, 1, 7, 0, 8];
    ships.forEach(([fleetId, ship], i) => {
      const col = cols[Math.min(cols.length - 1, Math.floor(i / BATTLE_H))];
      const y = order[i % BATTLE_H];
      const hull = SHIPS[ship].hull;
      b.units.push({
        uid: uid++, faction: f, fleetId, ship, hp: hull, maxHp: hull, shield: f === 'apex' ? APEX_SHIELD : 0,
        x: col, y, moved: false, fired: false, alive: true,
      });
    });
  });
  return b;
}

export function fleetsAt(state: GameState, systemId: number, faction: FactionId): Fleet[] {
  return Object.values(state.fleets).filter((f) => f.faction === faction && f.at === systemId);
}

const unitAt = (b: Battle, x: number, y: number) => b.units.find((u) => u.alive && u.x === x && u.y === y);
const enemiesOf = (b: Battle, u: BattleUnit) => b.units.filter((e) => e.alive && e.faction !== u.faction);

/** Cells a unit can still move to this round (8-way steps around rocks and ships). */
export function reachableCells(b: Battle, uid: number): { x: number; y: number }[] {
  const u = b.units.find((v) => v.uid === uid);
  if (!u || !u.alive || u.moved || b.over) return [];
  const steps = SHIPS[u.ship].move;
  const seen = new Map<number, number>([[idx(u.x, u.y), 0]]);
  const frontier = [[u.x, u.y]];
  const out: { x: number; y: number }[] = [];
  while (frontier.length) {
    const [x, y] = frontier.shift()!;
    const d = seen.get(idx(x, y))!;
    if (d >= steps) continue;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= BATTLE_W || ny >= BATTLE_H) continue;
        const i = idx(nx, ny);
        if (seen.has(i) || b.rocks.includes(i) || unitAt(b, nx, ny)) continue;
        seen.set(i, d + 1);
        out.push({ x: nx, y: ny });
        frontier.push([nx, ny]);
      }
  }
  return out;
}

export function targetsInRange(b: Battle, uid: number): BattleUnit[] {
  const u = b.units.find((v) => v.uid === uid);
  if (!u || !u.alive || u.fired || !armed(u.ship) || b.over) return [];
  return enemiesOf(b, u).filter((e) => cheb(u.x, u.y, e.x, e.y) <= rangeOf(u));
}

// ---------------------------------------------------------------- actions (mutate a cloned battle)

function doMove(b: Battle, u: BattleUnit, x: number, y: number): boolean {
  if (!reachableCells(b, u.uid).some((c) => c.x === x && c.y === y)) return false;
  u.x = x;
  u.y = y;
  u.moved = true;
  b.log.push({ t: 'move', uid: u.uid, x, y });
  return true;
}

function doFire(b: Battle, u: BattleUnit, targetUid: number): boolean {
  const t = targetsInRange(b, u.uid).find((e) => e.uid === targetUid);
  if (!t) return false;
  u.fired = true;
  let dmg = SHIPS[u.ship].attack + Math.floor(rand(b) * 3) - 1;
  const absorbed = Math.min(t.shield, dmg);
  t.shield -= absorbed;
  dmg -= absorbed;
  t.hp = Math.max(0, t.hp - dmg);
  b.log.push({ t: 'fire', uid: u.uid, target: t.uid, dmg, absorbed });
  if (t.hp <= 0) {
    t.alive = false;
    b.log.push({ t: 'destroyed', uid: t.uid });
  }
  return true;
}

/** Simple tactical AI: armed ships close in and shoot the weakest target; unarmed ships keep away. */
function aiAct(b: Battle, faction: FactionId) {
  for (const u of b.units.filter((v) => v.alive && v.faction === faction)) {
    if (b.over) return;
    const foes = enemiesOf(b, u);
    if (!foes.length) return;
    const nearest = (x: number, y: number) => Math.min(...foes.map((e) => cheb(x, y, e.x, e.y)));
    if (armed(u.ship)) {
      if (!targetsInRange(b, u.uid).length) {
        const cells = reachableCells(b, u.uid);
        const best = cells.sort((a, c) => nearest(a.x, a.y) - nearest(c.x, c.y) || a.y - c.y)[0];
        if (best && nearest(best.x, best.y) < nearest(u.x, u.y)) doMove(b, u, best.x, best.y);
      }
      const ts = targetsInRange(b, u.uid).sort((a, c) => a.hp + a.shield - (c.hp + c.shield) || a.uid - c.uid);
      if (ts[0]) doFire(b, u, ts[0].uid);
    } else {
      const cells = reachableCells(b, u.uid);
      const best = cells.sort((a, c) => nearest(c.x, c.y) - nearest(a.x, a.y) || a.y - c.y)[0];
      if (best && nearest(best.x, best.y) > nearest(u.x, u.y)) doMove(b, u, best.x, best.y);
    }
    checkOver(b);
  }
}

function checkOver(b: Battle) {
  if (b.over) return;
  const alive = (f: FactionId) => b.units.some((u) => u.alive && u.faction === f);
  const [p, q] = b.sides;
  if (!alive(p) || !alive(q)) b.over = { winner: alive(p) ? p : alive(q) ? q : null, reason: 'destroyed', losses: {} };
  else if (!b.units.some((u) => u.alive && armed(u.ship))) b.over = { winner: null, reason: 'stalemate', losses: {} };
}

/** End of one side's part: hand over, or start the next round (shields refill, Saurians repair). */
function endPart(b: Battle) {
  checkOver(b);
  if (b.over) return;
  if (b.active === b.sides[0]) {
    b.active = b.sides[1];
    return;
  }
  b.round++;
  if (b.round > MAX_ROUNDS) {
    b.over = { winner: null, reason: 'stalemate', losses: {} };
    return;
  }
  b.active = b.sides[0];
  b.log.push({ t: 'round', n: b.round });
  for (const u of b.units) {
    if (!u.alive) continue;
    u.moved = u.fired = false;
    if (u.faction === 'apex') u.shield = APEX_SHIELD;
    if (u.faction === 'saurian' && u.hp < u.maxHp) {
      const amount = Math.min(SAURIAN_REPAIR, u.maxHp - u.hp);
      u.hp += amount;
      b.log.push({ t: 'repair', uid: u.uid, amount });
    }
  }
}

const clone = (b: Battle): Battle => structuredClone(b);

// ---------------------------------------------------------------- public reducers

export function battleMove(state: GameState, actor: FactionId, uid: number, x: number, y: number): GameState {
  const b0 = state.battle;
  if (!b0 || b0.over || b0.active !== actor) return state;
  const b = clone(b0);
  const u = b.units.find((v) => v.uid === uid && v.faction === actor);
  if (!u || !doMove(b, u, x, y)) return state;
  return { ...state, battle: b };
}

export function battleFire(state: GameState, actor: FactionId, uid: number, target: number): GameState {
  const b0 = state.battle;
  if (!b0 || b0.over || b0.active !== actor) return state;
  const b = clone(b0);
  const u = b.units.find((v) => v.uid === uid && v.faction === actor);
  if (!u || !doFire(b, u, target)) return state;
  checkOver(b);
  return finishIfOver(state, b);
}

/** Player ends their part; the opponent plays theirs; next round begins. */
export function battleEndRound(state: GameState, actor: FactionId): GameState {
  const b0 = state.battle;
  if (!b0 || b0.over || b0.active !== actor) return state;
  const b = clone(b0);
  endPart(b);
  if (!b.over) {
    aiAct(b, b.active);
    endPart(b);
  }
  return finishIfOver(state, b);
}

/** Let the computer fight both sides to the end. */
export function battleAuto(state: GameState, actor?: FactionId): GameState {
  const b0 = state.battle;
  if (!b0 || b0.over || (actor && !b0.sides.includes(actor))) return state;
  const b = clone(b0);
  resolve(b);
  return finishIfOver(state, b);
}

function resolve(b: Battle) {
  let guard = 0;
  while (!b.over && guard++ < MAX_ROUNDS * 2 + 4) {
    aiAct(b, b.active);
    endPart(b);
  }
}

/** Withdraw: every enemy warship with you in range gets one parting shot, then the fleet jumps out. */
export function battleRetreat(state: GameState, actor: FactionId): GameState {
  const b0 = state.battle;
  if (!b0 || b0.over || !b0.sides.includes(actor)) return state;
  const b = clone(b0);
  for (const e of b.units.filter((u) => u.alive && u.faction !== actor && armed(u.ship))) {
    e.fired = false;
    const ts = targetsInRange(b, e.uid).sort((a, c) => a.hp - c.hp);
    if (ts[0]) doFire(b, e, ts[0].uid);
  }
  b.log.push({ t: 'retreat', faction: actor });
  const other = b.sides[0] === actor ? b.sides[1] : b.sides[0];
  b.over = { winner: other, reason: 'retreat', losses: {} };
  return finishIfOver(state, b, actor);
}

/** Write the outcome back to the strategic map: lost ships leave their fleets; retreaters fly home. */
function finishIfOver(state: GameState, b: Battle, retreated?: FactionId): GameState {
  if (!b.over) return { ...state, battle: b };
  const losses: BattleResult['losses'] = {};
  for (const u of b.units) {
    if (u.alive) continue;
    const l = (losses[u.faction] ??= {});
    l[u.ship] = (l[u.ship] ?? 0) + 1;
  }
  b.over.losses = losses;

  const fleets = { ...state.fleets } as Partial<GameState['fleets']>;
  for (const fid of new Set(b.units.map((u) => u.fleetId))) {
    const f = fleets[fid];
    if (!f) continue;
    const ships: Fleet['ships'] = {};
    for (const u of b.units) if (u.fleetId === fid && u.alive) ships[u.ship] = (ships[u.ship] ?? 0) + 1;
    if (!shipCount({ ...f, ships })) delete fleets[fid];
    else fleets[fid] = { ...f, ships };
  }
  let next: GameState = { ...state, fleets: fleets as GameState['fleets'], battle: b };

  // the loser of a stalemate who has no guns, or whoever retreated, withdraws
  const withdrawing = new Set<FactionId>();
  if (retreated) withdrawing.add(retreated);
  if (b.over.reason === 'stalemate')
    for (const f of b.sides) if (!b.units.some((u) => u.alive && u.faction === f && armed(u.ship))) withdrawing.add(f);
  for (const f of withdrawing) next = withdraw(next, f, b.systemId);

  const ev = battleEvent(next, b);
  if (ev && next.report) next = { ...next, report: { ...next.report, events: [...next.report.events, ev] } };
  return next;
}

function withdraw(state: GameState, faction: FactionId, from: number): GameState {
  const home = Object.values(state.colonies)
    .filter((c) => c.faction === faction && c.systemId !== from)
    .map((c) => state.galaxy!.systems[c.systemId])
    .sort((a, c) => dist(a.pos, state.galaxy!.systems[from].pos) - dist(c.pos, state.galaxy!.systems[from].pos))[0];
  if (!home) return state;
  const fleets = { ...state.fleets };
  for (const f of fleetsAt(state, from, faction)) fleets[f.id] = { ...f, dest: home.id };
  return { ...state, fleets };
}

function battleEvent(state: GameState, b: Battle): TurnEvent | null {
  const player = state.campaign?.playerFaction;
  if (!player || !b.sides.includes(player) || !b.over) return null;
  const sys = state.galaxy!.systems[b.systemId].name;
  const lost = Object.values(b.over.losses[player] ?? {}).reduce((n, v) => n + (v ?? 0), 0);
  const foe = b.sides.find((f) => f !== player)!;
  const killed = Object.values(b.over.losses[foe] ?? {}).reduce((n, v) => n + (v ?? 0), 0);
  const text =
    b.over.winner === player ? `Victory at ${sys}: ${killed} ${FACTIONS[foe].name} ship${killed === 1 ? '' : 's'} destroyed, ${lost} lost`
    : b.over.reason === 'retreat' && b.over.winner !== player ? `Withdrew from ${sys} (${lost} ship${lost === 1 ? '' : 's'} lost)`
    : b.over.winner ? `Defeat at ${sys}: ${lost} ship${lost === 1 ? '' : 's'} lost`
    : `Standoff at ${sys}: ${killed} destroyed, ${lost} lost`;
  return { kind: b.over.winner === player ? 'victory' : 'defeat', text, systemId: b.systemId };
}

// ---------------------------------------------------------------- encounters

/** Pairs of factions with fleets at the same system where at least one side has guns. */
export function findEncounters(state: GameState): { systemId: number; sides: [FactionId, FactionId] }[] {
  const bySystem = new Map<number, Set<FactionId>>();
  for (const f of Object.values(state.fleets)) {
    if (f.at === null) continue;
    (bySystem.get(f.at) ?? bySystem.set(f.at, new Set()).get(f.at)!).add(f.faction);
  }
  const player = state.campaign?.playerFaction;
  const out: { systemId: number; sides: [FactionId, FactionId] }[] = [];
  for (const [systemId, set] of [...bySystem].sort((a, c) => a[0] - c[0])) {
    const fs = [...set].sort();
    for (let i = 0; i < fs.length; i++)
      for (let j = i + 1; j < fs.length; j++) {
        const gunsI = fleetsAt(state, systemId, fs[i]).some((f) => SHIP_IDS.some((s) => armed(s) && (f.ships[s] ?? 0) > 0));
        const gunsJ = fleetsAt(state, systemId, fs[j]).some((f) => SHIP_IDS.some((s) => armed(s) && (f.ships[s] ?? 0) > 0));
        if (!gunsI && !gunsJ) continue;
        const sides: [FactionId, FactionId] = fs[j] === player ? [fs[j], fs[i]] : [fs[i], fs[j]];
        out.push({ systemId, sides });
      }
  }
  return out;
}

/** End-of-turn combat: AI-vs-AI fights resolve at once; the player's fights queue up to be played. */
export function resolveEncounters(state: GameState): GameState {
  const player = state.campaign?.playerFaction;
  const queue: GameState['battleQueue'] = [];
  for (const enc of findEncounters(state)) {
    if (player && enc.sides.includes(player)) {
      queue.push(enc);
      continue;
    }
    // re-check: an earlier fight this turn may already have removed one side
    if (!fleetsAt(state, enc.systemId, enc.sides[0]).length || !fleetsAt(state, enc.systemId, enc.sides[1]).length) continue;
    state = battleAuto({ ...state, battle: setupBattle(state, enc.systemId, enc.sides) });
    state = { ...state, battle: null };
  }
  return startNextBattle({ ...state, battleQueue: queue });
}

/** Close the finished battle and open the next queued one that still has two sides present. */
export function startNextBattle(state: GameState): GameState {
  const queue = [...state.battleQueue];
  while (queue.length) {
    const enc = queue.shift()!;
    const still = findEncounters(state).some((e) => e.systemId === enc.systemId && e.sides.includes(enc.sides[0]) && e.sides.includes(enc.sides[1]));
    if (still) return { ...state, battle: setupBattle(state, enc.systemId, enc.sides), battleQueue: queue };
  }
  return { ...state, battle: null, battleQueue: [] };
}

export function battleClose(state: GameState): GameState {
  if (!state.battle?.over) return state;
  return startNextBattle(state);
}
