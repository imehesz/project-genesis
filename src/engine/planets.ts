import type { ColonyId, FactionId, PlanetType } from './types.ts';

const HABITABILITY: Record<PlanetType, number> = {
  terran: 1, ocean: 0.8, desert: 0.5, ice: 0.35, volcanic: 0.3, barren: 0.2, gas: 0,
};
const FACTION_HABITABILITY: Partial<Record<FactionId, Partial<Record<PlanetType, number>>>> = {
  saurian: { volcanic: 1, desert: 0.8, ice: 0.15 },
  apex: { terran: 0.6, ocean: 0.6, desert: 0.6, ice: 0.6, volcanic: 0.6, barren: 1 },
};

/** 0 = uninhabitable, 1 = ideal, for that faction. */
export function habitability(type: PlanetType, faction: FactionId): number {
  return FACTION_HABITABILITY[faction]?.[type] ?? HABITABILITY[type];
}

export const colonyIdOf = (systemId: number, planetId: number): ColonyId => `${systemId}-${planetId}`;
