import type { FactionId, PlanetType } from './types.ts';

export interface FactionDef {
  id: FactionId;
  name: string;
  /** Planet type the faction's homeworld is forced to. */
  homeType: PlanetType;
  homeworldName: string;
}

export const FACTIONS: Record<FactionId, FactionDef> = {
  terran: { id: 'terran', name: 'Terran Coalition', homeType: 'terran', homeworldName: 'New Terra' },
  saurian: { id: 'saurian', name: 'Saurian Dominion', homeType: 'volcanic', homeworldName: 'Skarrath' },
  apex: { id: 'apex', name: 'Apex Core', homeType: 'barren', homeworldName: 'Nexus Prime' },
};

export const FACTION_IDS = Object.keys(FACTIONS) as FactionId[];
