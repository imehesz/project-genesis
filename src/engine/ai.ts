import type { Colony, Command, FactionId, GameState } from './types.ts';
import { TECHS, TECH_IDS } from './data/techs.ts';
import type { BuildingId } from './data/buildings.ts';
import { buildBlocker, colonyStats, researchBlocker, shipBlocker } from './economy.ts';
import { colonizablePlanets, colonizeBlocker, dist } from './fleets.ts';
import { habitability } from './planets.ts';

const MAX_COLONIES = 10;
const MIN_HAB = 0.3;

/**
 * A simple, deterministic expansion AI. It never touches state directly: it returns the same
 * Commands a human would send, so it plays by exactly the same rules (and can later run server-side).
 */
export function planAi(state: GameState, faction: FactionId): Command[] {
  const cmds: Command[] = [];
  const empire = state.empires[faction];
  const galaxy = state.galaxy;
  if (!empire || !galaxy) return cmds;

  // research: cheapest available tech
  if (!empire.research.current) {
    const options = TECH_IDS.filter((t) => !researchBlocker(empire, t)).sort((a, b) => TECHS[a].cost - TECHS[b].cost);
    if (options[0]) cmds.push({ type: 'SET_RESEARCH', tech: options[0] });
  }

  const mine = Object.values(state.colonies).filter((c) => c.faction === faction);
  const fleets = Object.values(state.fleets).filter((f) => f.faction === faction);
  const colonyShipsOut =
    fleets.reduce((n, f) => n + (f.ships.colony ?? 0), 0) +
    mine.reduce((n, c) => n + c.queue.filter((q) => q.kind === 'ship' && q.id === 'colony').length, 0);

  const frigates =
    fleets.reduce((n, f) => n + (f.ships.frigate ?? 0), 0) +
    mine.reduce((n, c) => n + c.queue.filter((q) => q.kind === 'ship' && q.id === 'frigate').length, 0);

  // construction
  const capital = [...mine].sort((a, b) => b.population - a.population)[0];
  for (const c of mine) {
    if (c.queue.length) continue;
    if (c === capital && !shipBlocker(c) && colonyShipsOut < 1 && mine.length < MAX_COLONIES) {
      cmds.push({ type: 'QUEUE_SHIP', colonyId: c.id, ship: 'colony' });
      continue;
    }
    // escorts: roughly one frigate per three colonies (they ride along with the next colony ship)
    if (c === capital && !shipBlocker(c) && frigates < 1 + Math.floor(mine.length / 3) && empire.credits > 100) {
      cmds.push({ type: 'QUEUE_SHIP', colonyId: c.id, ship: 'frigate' });
      continue;
    }
    const pick = nextBuilding(state, c);
    if (pick) cmds.push({ type: 'QUEUE_BUILDING', colonyId: c.id, building: pick });
  }

  // colony ships: settle where they are, or fly to the nearest free habitable world
  const claimed = new Set(fleets.map((f) => f.dest).filter((d) => d !== null));
  for (const f of fleets) {
    if (!(f.ships.colony ?? 0)) continue;
    if (f.at !== null) {
      const target = bestPlanet(state, faction, f.at);
      if (target !== null && !colonizeBlocker(state, f, target)) {
        cmds.push({ type: 'COLONIZE', fleetId: f.id, planetId: target });
        continue;
      }
    }
    if (f.dest !== null) continue;
    let best: number | null = null, bestD = Infinity;
    for (const s of galaxy.systems) {
      if (claimed.has(s.id) || (s.owner && s.owner !== faction)) continue;
      if (bestPlanet(state, faction, s.id) === null) continue;
      const d = dist(f.pos, s.pos);
      if (d < bestD) [best, bestD] = [s.id, d];
    }
    if (best !== null) {
      claimed.add(best);
      cmds.push({ type: 'MOVE_FLEET', fleetId: f.id, to: best });
    }
  }
  return cmds;
}

function bestPlanet(state: GameState, faction: FactionId, systemId: number): number | null {
  const sys = state.galaxy!.systems[systemId];
  let best: number | null = null, score = 0;
  for (const p of colonizablePlanets(state, faction, sys)) {
    const h = habitability(p.type, faction);
    if (h < MIN_HAB) continue;
    if (h * p.size > score) [best, score] = [p.id, h * p.size];
  }
  return best;
}

function nextBuilding(state: GameState, c: Colony): BuildingId | null {
  const st = colonyStats(state, c);
  const order: BuildingId[] = [];
  if (c.faction === 'apex') order.push('foundry');
  if (c.population > st.capacity * 0.8) order.push('arcology', 'habitat');
  if (c.morale < 45) order.push('arena');
  order.push('fabricator', 'lab', 'tradehub', 'habitat');
  return order.find((b) => !buildBlocker(state, c, b)) ?? null;
}
