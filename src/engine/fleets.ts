import type { FactionId, Fleet, FleetId, GameState, StarSystem, TurnEvent, Vec3 } from './types.ts';
import { SHIPS, SHIP_IDS, type ShipId } from './data/ships.ts';
import { FACTIONS } from './factions.ts';
import { colonyIdOf, habitability } from './planets.ts';

export const shipCount = (f: Fleet) => SHIP_IDS.reduce((n, s) => n + (f.ships[s] ?? 0), 0);

export function fleetSpeed(f: Fleet): number {
  const speeds = SHIP_IDS.filter((s) => (f.ships[s] ?? 0) > 0).map((s) => SHIPS[s].speed);
  return speeds.length ? Math.min(...speeds) : 0;
}

export function fleetUpkeep(f: Fleet): number {
  return SHIP_IDS.reduce((n, s) => n + (f.ships[s] ?? 0) * SHIPS[s].upkeep, 0);
}

export const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** Whole turns until the fleet reaches `to` (or its current destination). */
export function fleetEta(state: GameState, f: Fleet, to: number | null = f.dest): number | null {
  if (to === null) return null;
  const speed = fleetSpeed(f);
  if (!speed) return null;
  return Math.max(1, Math.ceil(dist(f.pos, state.galaxy!.systems[to].pos) / speed));
}

const ORD = ['th', 'st', 'nd', 'rd'];
const ordinal = (n: number) => n + (ORD[(n % 100 >= 11 && n % 100 <= 13) ? 0 : n % 10] ?? 'th');

/** Add ships to the faction's parked fleet at a system, or commission a new fleet there. */
export function addShips(state: GameState, faction: FactionId, systemId: number, ship: ShipId, n = 1): GameState {
  const parked = Object.values(state.fleets).find((f) => f.faction === faction && f.at === systemId && f.dest === null);
  if (parked) {
    const next = { ...parked, ships: { ...parked.ships, [ship]: (parked.ships[ship] ?? 0) + n } };
    return { ...state, fleets: { ...state.fleets, [parked.id]: next } };
  }
  const e = state.empires[faction]!;
  const num = e.fleetsCommissioned + 1;
  const sys = state.galaxy!.systems[systemId];
  const fleet: Fleet = {
    id: state.nextFleetId,
    name: `${ordinal(num)} Fleet`,
    faction,
    ships: { [ship]: n },
    pos: { ...sys.pos },
    at: systemId,
    dest: null,
  };
  return {
    ...state,
    nextFleetId: state.nextFleetId + 1,
    empires: { ...state.empires, [faction]: { ...e, fleetsCommissioned: num } },
    fleets: { ...state.fleets, [fleet.id]: fleet },
  };
}

export function moveFleet(state: GameState, actor: FactionId, id: FleetId, to: number): GameState {
  const f = state.fleets[id];
  if (!f || f.faction !== actor || !state.galaxy?.systems[to]) return state;
  if (f.at === to) return { ...state, fleets: { ...state.fleets, [id]: { ...f, dest: null } } };
  return { ...state, fleets: { ...state.fleets, [id]: { ...f, dest: to } } };
}

export function stopFleet(state: GameState, actor: FactionId, id: FleetId): GameState {
  const f = state.fleets[id];
  if (!f || f.faction !== actor) return state;
  return { ...state, fleets: { ...state.fleets, [id]: { ...f, dest: null } } };
}

/** Why this fleet can't colonize that planet right now, or null if it can. */
export function colonizeBlocker(state: GameState, f: Fleet, planetId: number): string | null {
  if (f.at === null) return 'Fleet is not at a star system';
  if (!(f.ships.colony ?? 0)) return 'Needs a Colony Ship';
  const p = state.galaxy!.systems[f.at].planets[planetId];
  if (!p) return 'No such planet';
  if (p.colony || state.colonies[colonyIdOf(f.at, planetId)]) return 'Already colonized';
  if (habitability(p.type, f.faction) <= 0) return 'Uninhabitable';
  return null;
}

export function colonizablePlanets(state: GameState, faction: FactionId, sys: StarSystem) {
  return sys.planets.filter((p) => !p.colony && habitability(p.type, faction) > 0);
}

export function colonize(state: GameState, actor: FactionId, id: FleetId, planetId: number, events?: TurnEvent[]): GameState {
  const f = state.fleets[id];
  if (!f || f.faction !== actor || colonizeBlocker(state, f, planetId)) return state;
  const sysId = f.at!;
  const galaxy = state.galaxy!;
  const sys = galaxy.systems[sysId];
  const planets = sys.planets.map((p) => (p.id === planetId ? { ...p, colony: { faction: actor, homeworld: false } } : p));
  const systems = galaxy.systems.map((s) => (s.id === sysId ? { ...s, planets, owner: s.owner ?? actor } : s));

  const left = (f.ships.colony ?? 0) - 1;
  const fleets: Partial<GameState['fleets']> = { ...state.fleets };
  const ships: Fleet['ships'] = { ...f.ships, colony: left };
  if (!left) delete ships.colony;
  if (shipCount({ ...f, ships }) === 0) delete fleets[id];
  else fleets[id] = { ...f, ships };

  const cid = colonyIdOf(sysId, planetId);
  const player = state.campaign?.playerFaction;
  const pname = sys.planets[planetId].name;
  if (events) {
    if (actor === player) events.push({ kind: 'colony', text: `Colony founded on ${pname}`, colonyId: cid, systemId: sysId });
    else events.push({ kind: 'rival', text: `The ${FACTIONS[actor].name} colonized ${pname}`, systemId: sysId });
  }
  return {
    ...state,
    galaxy: { ...galaxy, systems },
    fleets: fleets as GameState['fleets'],
    colonies: {
      ...state.colonies,
      [cid]: { id: cid, systemId: sysId, planetId, faction: actor, population: 1, morale: 60, taxRate: 15, structures: [], nextStructureId: 1, queue: [] },
    },
  };
}

/** Turn step: every fleet with a destination flies `speed` units toward it. */
export function moveFleets(state: GameState, events: TurnEvent[]): GameState {
  const player = state.campaign?.playerFaction;
  const fleets = { ...state.fleets };
  for (const f of Object.values(state.fleets)) {
    if (f.dest === null) continue;
    const target = state.galaxy!.systems[f.dest];
    const d = dist(f.pos, target.pos);
    const speed = fleetSpeed(f);
    if (d <= speed) {
      fleets[f.id] = { ...f, pos: { ...target.pos }, at: target.id, dest: null };
      if (f.faction === player) events.push({ kind: 'arrived', text: `${f.name} arrived at ${target.name}`, fleetId: f.id, systemId: target.id });
    } else {
      const k = speed / d;
      fleets[f.id] = {
        ...f,
        at: null,
        pos: { x: f.pos.x + (target.pos.x - f.pos.x) * k, y: f.pos.y + (target.pos.y - f.pos.y) * k, z: f.pos.z + (target.pos.z - f.pos.z) * k },
      };
    }
  }
  return { ...state, fleets };
}
