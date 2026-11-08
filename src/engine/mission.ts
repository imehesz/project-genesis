// Story campaign: hand-built star systems, scripted objectives, and the space half of the split
// (turn-based in space, real-time on the ground; see op.ts for the ground half).

import type { Colony, FactionId, Galaxy, GameState, Planet } from './types.ts';
import { createInitialState } from './state.ts';
import { colonyIdOf } from './planets.ts';
import { createOp, mirrorOpColony, type OpLayout } from './op.ts';

export type ObjectiveId = 'land' | 'revive' | 'explore' | 'rune';

export interface Objective {
  id: ObjectiveId;
  /** What the player reads. */
  label: string;
  /** Shown instead of `label` until revealed (the player doesn't know what Objective X is yet). */
  hidden?: string;
  revealed: boolean;
  done: boolean;
}

export interface Mission {
  id: 'c1';
  systemId: number;
  /** The commander's ship: the planet it orbits (null = parked by the star), and where it's flying. */
  ship: { at: number | null; dest: number | null };
  /** Planets the commander may land on. */
  unlocked: number[];
  objectives: Objective[];
  /** Carries over between planets and campaigns (nobody else's does). */
  commanderXp: number;
  /** Resource stock outside a planet mission (later: bought and sold at the market, in space only). */
  light: number;
  dark: number;
  /** Planets where the story for this campaign is finished. */
  completed: number[];
  briefed: boolean;
}

// ---------------------------------------------------------------- campaign 1 data (names are placeholders)

export const C1 = {
  seed: 1903, // terrain seed: picked for a big connected landmass (see scripts/mission-test.ts)
  star: 'Tessaly',
  planets: [
    { name: 'Aurelia', type: 'terran', size: 5, mapSide: 30, locked: '' },
    { name: 'Kharon', type: 'volcanic', size: 4, locked: 'Dense ion storms. No safe landing approach yet.' },
    { name: 'Nyx', type: 'ice', size: 3, locked: 'Something on the surface jams every landing beacon.' },
  ] as const,
  /** Planet 1 map layout as a share of the map side: colony one end, rune the far end. */
  layout: { base: { x: 0.3, y: 0.72 }, rune: { x: 0.72, y: 0.26 } },
  start: { light: 200, dark: 50 },
};

const OBJECTIVES = (p: string): Objective[] => [
  { id: 'land', label: `Land on ${p}`, revealed: true, done: false },
  { id: 'revive', label: 'Revive the colony', revealed: true, done: false },
  { id: 'explore', label: `Explore ${p}`, revealed: true, done: false },
  { id: 'rune', label: 'Touch the rune with the commander', hidden: 'Objective X', revealed: false, done: false },
];

export function newMission(id: 'c1'): GameState {
  const faction: FactionId = 'terran';
  const planets: Planet[] = C1.planets.map((p, i) => ({
    id: i, name: p.name, type: p.type, size: p.size, colony: null, ...('mapSide' in p ? { mapSide: p.mapSide } : {}),
  }));
  const galaxy: Galaxy = {
    seed: C1.seed, arms: 0, twist: 0, rotation: 0, radius: 0,
    systems: [{ id: 0, name: C1.star, pos: { x: 0, y: 0, z: 0 }, star: 'G', planets, owner: null }],
  };
  const mission: Mission = {
    id, systemId: 0, ship: { at: null, dest: null }, unlocked: [0], objectives: OBJECTIVES(planets[0].name),
    commanderXp: 0, light: C1.start.light, dark: C1.start.dark, completed: [], briefed: false,
  };
  return {
    ...createInitialState(C1.seed),
    campaign: { seed: C1.seed, playerFaction: faction },
    galaxy,
    mission,
    empires: { [faction]: { faction, credits: 0, research: { current: null, progress: 0 }, techs: [], fleetsCommissioned: 0 } },
  };
}

export const missionPlanetLock = (state: GameState, planetId: number): string | null => {
  const m = state.mission;
  if (!m) return 'No campaign';
  if (m.unlocked.includes(planetId)) return null;
  return C1.planets[planetId]?.locked || 'Locked';
};

export function missionBriefed(state: GameState): GameState {
  return state.mission ? { ...state, mission: { ...state.mission, briefed: true } } : state;
}

/** Order the commander's ship toward a planet. It arrives at the end of the turn. */
export function missionShipMove(state: GameState, planetId: number): GameState {
  const m = state.mission;
  if (!m || state.op || !state.galaxy!.systems[m.systemId].planets[planetId] || m.ship.at === planetId) return state;
  return { ...state, mission: { ...m, ship: { ...m.ship, dest: planetId } } };
}

/** END_TURN in a campaign: space is turn-based, the ship completes its flight. */
export function missionEndTurn(state: GameState): GameState {
  const m = state.mission!;
  const ship = m.ship.dest !== null ? { at: m.ship.dest, dest: null } : m.ship;
  return { ...state, turn: state.turn + 1, mission: { ...m, ship } };
}

export function missionLandBlocker(state: GameState, planetId: number): string | null {
  const m = state.mission;
  if (!m) return 'No campaign';
  if (state.op) return 'Already on a planet';
  const lock = missionPlanetLock(state, planetId);
  if (lock) return lock;
  if (m.ship.at !== planetId) return 'Fly the ship into orbit first';
  if (m.completed.includes(planetId)) return 'Nothing more to do here for now';
  if (planetId !== 0) return 'To be continued';
  return null;
}

/** Land the commander: the planet's clock starts (real time from here on). */
export function missionLand(state: GameState, planetId: number): GameState {
  const m = state.mission;
  if (!m || missionLandBlocker(state, planetId)) return state;
  const galaxy = state.galaxy!;
  const planet = galaxy.systems[m.systemId].planets[planetId];
  const id = colonyIdOf(m.systemId, planetId);
  // the abandoned colony: a human settlement nobody has answered from in years
  const colony: Colony = state.colonies[id] ?? {
    id, systemId: m.systemId, planetId, faction: state.campaign!.playerFaction,
    population: 0, morale: 0, taxRate: 0, structures: [], nextStructureId: 1, queue: [],
  };
  const side = planet.mapSide!;
  const layout: OpLayout = {
    base: { x: C1.layout.base.x * side, y: C1.layout.base.y * side },
    rune: { x: C1.layout.rune.x * side, y: C1.layout.rune.y * side },
  };
  let next: GameState = { ...state, colonies: { ...state.colonies, [id]: colony } };
  const op = createOp(next, colony, layout, m.commanderXp, { light: m.light, dark: m.dark });
  const objectives = m.objectives.map((o) => (o.id === 'land' ? { ...o, done: true } : o));
  next = { ...next, op, mission: { ...m, objectives } };
  return mirrorOpColony(next);
}

/**
 * Leave the planet after the debrief. A win carries the rune, the commander's XP and the stock back
 * up to the ship and unlocks the rest of the system; a loss is handled by the UI (retry from landing).
 */
export function missionAfterOp(state: GameState): GameState {
  const m = state.mission, op = state.op;
  if (!m || !op?.over) return state;
  if (op.over.result !== 'won') return state;
  const commander = op.units.find((u) => u.kind === 'commander');
  return {
    ...state,
    mission: {
      ...m,
      commanderXp: commander?.xp ?? m.commanderXp,
      light: Math.floor(op.light),
      dark: Math.floor(op.dark),
      unlocked: [...new Set([...m.unlocked, 1, 2])],
      completed: [...new Set([...m.completed, op.planetId])],
    },
  };
}

