import type { BuildItem, Colony, ColonyId, Empire, FactionId, GameState, Planet, TurnEvent } from './types.ts';
import { BUILDINGS, BUILDING_IDS, type BuildingId } from './data/buildings.ts';
import { TECHS, TECH_IDS, type TechId } from './data/techs.ts';
import { SHIPS, type ShipId } from './data/ships.ts';
import { FACTION_IDS } from './factions.ts';
import { colonyIdOf, habitability } from './planets.ts';
import { addShips, fleetUpkeep, moveFleets } from './fleets.ts';
import { autoPlace, buildingCount, landStats, placeBlocker } from './land.ts';

export { colonyIdOf, habitability };
export const MAX_TAX = 50;
export const STARTING_CREDITS = 500;

export function planetOf(state: GameState, c: Colony): Planet {
  return state.galaxy!.systems[c.systemId].planets[c.planetId];
}

export const itemDef = (item: BuildItem) => (item.kind === 'building' ? BUILDINGS[item.id] : SHIPS[item.id]);

export interface ColonyStats {
  capacity: number;
  production: number;
  research: number;
  taxIncome: number;
  upkeep: number;
  /** taxIncome - upkeep */
  net: number;
  growth: number;
  moraleTarget: number;
  /** Buildable land cells in use (built + under construction) / total. */
  landUsed: number;
  landTotal: number;
}

const count = buildingCount;
const has = (e: Empire | undefined, t: TechId) => !!e?.techs.includes(t);

/** Pure: every number the colony screen shows. Also what END_TURN applies. */
export function colonyStats(state: GameState, c: Colony): ColonyStats {
  const planet = planetOf(state, c);
  const empire = state.empires[c.faction];
  const f = c.faction;

  const capacity = Math.round(planet.size * 4 * habitability(planet.type, f)) + count(c, 'habitat') * 4 + count(c, 'arcology') * 12;
  const moraleFactor = 0.5 + c.morale / 100;

  const fabEach = 3 + (has(empire, 'autofab') ? 1 : 0);
  let production = (2 + c.population * 0.5 + count(c, 'fabricator') * fabEach) * moraleFactor;
  if (has(empire, 'fusion')) production *= 1.15;

  const labEach = 4 + (has(empire, 'neural') ? 2 : 0);
  let research = count(c, 'lab') * labEach + c.population * 0.25;
  if (f === 'saurian') research *= 0.8;
  if (f === 'apex') research *= 1.2;

  let taxIncome = c.population * (c.taxRate / 100) * 8 * (1 + 0.2 * count(c, 'tradehub'));
  if (f === 'terran') taxIncome *= 1.2;

  const upkeep = BUILDING_IDS.reduce((sum, b) => sum + count(c, b) * BUILDINGS[b].upkeep, 0);

  let growth: number;
  if (f === 'apex') {
    growth = Math.min(count(c, 'foundry') * 0.6, Math.max(0, capacity - c.population));
  } else {
    const room = 1 - c.population / Math.max(1, capacity);
    growth = c.population * 0.08 * room * (c.morale >= 40 ? 1 : 0.3) * (f === 'saurian' ? 1.3 : 1);
    if (room > 0) growth = Math.max(growth, 0.05);
    if (c.population > capacity) growth = (capacity - c.population) * 0.25;
  }

  const crowded = c.population > capacity * 0.95;
  const moraleTarget = clamp(80 - c.taxRate * 1.2 + count(c, 'arena') * 10 - (crowded ? 15 : 0) + (f === 'apex' ? 15 : 0), 0, 100);

  const land = landStats(state, c);
  return {
    capacity, production, research, taxIncome, upkeep, net: taxIncome - upkeep, growth, moraleTarget,
    landUsed: land.used, landTotal: land.total,
  };
}

/** Why a building can't be queued here right now, or null if it can. */
export function buildBlocker(state: GameState, c: Colony, b: BuildingId): string | null {
  const def = BUILDINGS[b];
  const empire = state.empires[c.faction];
  if (def.onlyFaction && def.onlyFaction !== c.faction) return 'Not available to your faction';
  if (def.requires && !has(empire, def.requires)) return `Requires ${TECHS[def.requires].name}`;
  const queued = c.queue.filter((q) => q.kind === 'building' && q.id === b).length;
  if (def.max && count(c, b) + queued >= def.max) return 'Already built';
  if (!autoPlace(state, c, b)) return 'No free land for it';
  return null;
}

export function shipBlocker(c: Colony): string | null {
  return count(c, 'shipyard') > 0 ? null : 'Requires an Orbital Shipyard here';
}

export function researchBlocker(empire: Empire, t: TechId): string | null {
  if (empire.techs.includes(t)) return 'Researched';
  const req = TECHS[t].requires;
  if (req && !empire.techs.includes(req)) return `Requires ${TECHS[req].name}`;
  return null;
}

/** Credits to finish the item at the head of the queue right now. */
export function rushCost(c: Colony): number | null {
  const head = c.queue[0];
  if (!head) return null;
  return Math.ceil((itemDef(head).cost - head.progress) * 2.5);
}

export function empireTotals(state: GameState, faction: FactionId) {
  let net = 0, research = 0, population = 0, colonies = 0, fleetCost = 0, fleets = 0;
  for (const c of Object.values(state.colonies)) {
    if (c.faction !== faction) continue;
    const st = colonyStats(state, c);
    net += st.net;
    research += st.research;
    population += c.population;
    colonies++;
  }
  for (const f of Object.values(state.fleets)) {
    if (f.faction !== faction) continue;
    fleetCost += fleetUpkeep(f);
    fleets++;
  }
  return { net: net - fleetCost, fleetCost, research, population, colonies, fleets };
}

/** Homeworld colonies, empires and a starting scout for a freshly generated galaxy. */
export function seedEmpires(state: GameState): GameState {
  const colonies: Record<ColonyId, Colony> = {};
  const homes: [FactionId, number][] = [];
  for (const sys of state.galaxy!.systems) {
    for (const p of sys.planets) {
      if (!p.colony) continue;
      const id = colonyIdOf(sys.id, p.id);
      homes.push([p.colony.faction, sys.id]);
      colonies[id] = {
        id, systemId: sys.id, planetId: p.id, faction: p.colony.faction,
        population: 8, morale: 65, taxRate: 20,
        structures: [], nextStructureId: 1,
        queue: [],
      };
    }
  }
  const empires: GameState['empires'] = {};
  for (const f of FACTION_IDS) {
    empires[f] = { faction: f, credits: STARTING_CREDITS, research: { current: null, progress: 0 }, techs: [], fleetsCommissioned: 0 };
  }
  let next: GameState = { ...state, colonies, empires };
  // starting districts, placed on real land around the colony centre
  for (const id of Object.keys(colonies)) {
    for (const b of ['shipyard', 'habitat', 'fabricator', 'fabricator', 'lab'] as BuildingId[]) {
      const c = next.colonies[id];
      const at = autoPlace(next, c, b);
      if (!at) continue;
      const placed = { ...c, structures: [...c.structures, { id: c.nextStructureId, building: b, ...at }], nextStructureId: c.nextStructureId + 1 };
      next = { ...next, colonies: { ...next.colonies, [id]: placed } };
    }
  }
  for (const [f, sysId] of homes) next = addShips(next, f, sysId, 'scout');
  return next;
}

/** The strategic turn: fleets move, then production, construction, growth, morale, taxes, research. */
export function endTurn(state: GameState, events: TurnEvent[] = []): GameState {
  const player = state.campaign?.playerFaction;
  state = moveFleets(state, events);

  const empires = structuredClone(state.empires);
  const colonies: GameState['colonies'] = {};
  const researchBy: Partial<Record<FactionId, number>> = {};
  const launches: [FactionId, number, ShipId][] = [];

  for (const c of Object.values(state.colonies)) {
    const st = colonyStats(state, c);
    const name = planetOf(state, c).name;
    const mine = c.faction === player;
    const next: Colony = { ...c, structures: [...c.structures], queue: c.queue.map((q) => ({ ...q })) };

    // construction: production flows down the queue, leftovers carry to the next item
    let pp = st.production;
    while (next.queue.length && pp > 0) {
      const head = next.queue[0];
      const need = itemDef(head).cost - head.progress;
      if (pp < need) {
        head.progress += pp;
        break;
      }
      pp -= need;
      next.queue.shift();
      if (head.kind === 'building') {
        next.structures.push({ id: next.nextStructureId, building: head.id, x: head.x, y: head.y });
        next.nextStructureId++;
        if (mine) events.push({ kind: 'built', text: `${BUILDINGS[head.id].name} completed on ${name}`, colonyId: c.id });
      } else {
        launches.push([c.faction, c.systemId, head.id]);
        if (mine) events.push({ kind: 'ship', text: `${SHIPS[head.id].name} launched from ${name}`, colonyId: c.id, systemId: c.systemId });
      }
    }

    next.population = Math.max(0.1, round2(c.population + st.growth));
    next.morale = round2(c.morale + (st.moraleTarget - c.morale) * 0.25);
    if (mine && Math.floor(next.population) > Math.floor(c.population))
      events.push({ kind: 'growth', text: `${name} grew to ${Math.floor(next.population)}M citizens`, colonyId: c.id });
    if (mine && next.morale < 30 && c.morale >= 30)
      events.push({ kind: 'warning', text: `Unrest on ${name}: morale is falling`, colonyId: c.id });

    empires[c.faction]!.credits = round2(empires[c.faction]!.credits + st.net);
    researchBy[c.faction] = (researchBy[c.faction] ?? 0) + st.research;
    colonies[c.id] = next;
  }

  for (const f of Object.values(state.fleets)) empires[f.faction]!.credits = round2(empires[f.faction]!.credits - fleetUpkeep(f));

  for (const f of FACTION_IDS) {
    const e = empires[f];
    if (!e) continue;
    const pts = researchBy[f] ?? 0;
    if (f === player && e.credits < 0) events.push({ kind: 'warning', text: 'The treasury is in debt' });
    if (!e.research.current) {
      if (f === player && pts > 0) events.push({ kind: 'warning', text: 'No research project selected: research points are being wasted' });
      continue;
    }
    e.research.progress += pts;
    const tech = TECHS[e.research.current];
    if (e.research.progress >= tech.cost) {
      e.techs.push(tech.id);
      e.research = { current: null, progress: e.research.progress - tech.cost };
      if (f === player) events.push({ kind: 'researched', text: `Breakthrough: ${tech.name}. ${tech.effect}` });
    }
  }

  let next: GameState = { ...state, turn: state.turn + 1, colonies, empires };
  for (const [f, sysId, ship] of launches) next = addShips(next, f, sysId, ship);
  return { ...next, report: { turn: state.turn, events } };
}

// ---------------------------------------------------------------- colony commands

const ownColony = (state: GameState, actor: FactionId, id: ColonyId) => {
  const c = state.colonies[id];
  return c && c.faction === actor ? c : null;
};
const withColony = (state: GameState, c: Colony): GameState => ({ ...state, colonies: { ...state.colonies, [c.id]: c } });

export function setTax(state: GameState, actor: FactionId, id: ColonyId, rate: number): GameState {
  const c = ownColony(state, actor, id);
  return c ? withColony(state, { ...c, taxRate: clamp(Math.round(rate), 0, MAX_TAX) }) : state;
}

/** Queue a building at a chosen cell, or at the best free spot when `at` is omitted. */
export function queueBuilding(state: GameState, actor: FactionId, id: ColonyId, b: BuildingId, at?: { x: number; y: number }): GameState {
  const c = ownColony(state, actor, id);
  if (!c || buildBlocker(state, c, b)) return state;
  const spot = at ?? autoPlace(state, c, b);
  if (!spot || placeBlocker(state, c, b, spot.x, spot.y)) return state;
  return withColony(state, { ...c, queue: [...c.queue, { kind: 'building', id: b, x: spot.x, y: spot.y, progress: 0 }] });
}

export function demolish(state: GameState, actor: FactionId, id: ColonyId, structureId: number): GameState {
  const c = ownColony(state, actor, id);
  if (!c || !c.structures.some((s) => s.id === structureId)) return state;
  return withColony(state, { ...c, structures: c.structures.filter((s) => s.id !== structureId) });
}

export function queueShip(state: GameState, actor: FactionId, id: ColonyId, s: ShipId): GameState {
  const c = ownColony(state, actor, id);
  if (!c || shipBlocker(c)) return state;
  return withColony(state, { ...c, queue: [...c.queue, { kind: 'ship', id: s, progress: 0 }] });
}

export function cancelQueue(state: GameState, actor: FactionId, id: ColonyId, index: number): GameState {
  const c = ownColony(state, actor, id);
  if (!c || !c.queue[index]) return state;
  return withColony(state, { ...c, queue: c.queue.filter((_, i) => i !== index) });
}

export function rushBuy(state: GameState, actor: FactionId, id: ColonyId): GameState {
  const c = ownColony(state, actor, id);
  const cost = c && rushCost(c);
  const e = c && state.empires[c.faction];
  if (!c || cost == null || !e || e.credits < cost) return state;
  const head = c.queue[0];
  // Rush-buy pays the rest of the cost; it completes at the start of next turn's construction.
  const done = { ...head, progress: itemDef(head).cost };
  return {
    ...withColony(state, { ...c, queue: [done, ...c.queue.slice(1)] }),
    empires: { ...state.empires, [c.faction]: { ...e, credits: e.credits - cost } },
  };
}

export function setResearch(state: GameState, actor: FactionId, tech: TechId | null): GameState {
  const e = state.empires[actor];
  if (!e || (tech && researchBlocker(e, tech))) return state;
  // Switching projects keeps accumulated points (simple and forgiving).
  return { ...state, empires: { ...state.empires, [actor]: { ...e, research: { ...e.research, current: tech } } } };
}

export { TECH_IDS };
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const round2 = (v: number) => Math.round(v * 100) / 100;
