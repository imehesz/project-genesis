import type { FactionId } from '../types.ts';
import type { TechId } from './techs.ts';

export type BuildingId =
  | 'habitat' | 'fabricator' | 'lab' | 'tradehub' | 'arena' | 'shield' | 'shipyard' | 'arcology' | 'foundry';

export interface BuildingDef {
  id: BuildingId;
  name: string;
  /** Production points to build. */
  cost: number;
  /** Credits per turn. */
  upkeep: number;
  effect: string;
  requires?: TechId;
  onlyFaction?: FactionId;
  max?: number;
  /** Footprint on the surface grid: 1 = 1x1 cell, 2 = 2x2 cells. */
  size?: 1 | 2;
}

export const BUILDINGS: Record<BuildingId, BuildingDef> = {
  habitat: { id: 'habitat', name: 'Habitat Block', cost: 30, upkeep: 1, effect: '+4 population capacity' },
  fabricator: { id: 'fabricator', name: 'Fabricator Plant', cost: 40, upkeep: 2, effect: '+3 production' },
  lab: { id: 'lab', name: 'Research Lab', cost: 45, upkeep: 2, effect: '+3 research' },
  tradehub: { id: 'tradehub', name: 'Trade Hub', cost: 60, upkeep: 1, effect: '+20% tax income', requires: 'xenocommerce' },
  arena: { id: 'arena', name: 'Holo Arena', cost: 50, upkeep: 3, effect: '+10 morale', requires: 'holoent', size: 2 },
  shield: { id: 'shield', name: 'Planetary Shield', cost: 90, upkeep: 4, effect: 'Protects the colony from orbital bombardment', requires: 'deflectors', max: 1 },
  shipyard: { id: 'shipyard', name: 'Orbital Shipyard', cost: 120, upkeep: 2, effect: 'Required to build starships', requires: 'orbital', max: 1, size: 2 },
  arcology: { id: 'arcology', name: 'Arcology', cost: 150, upkeep: 4, effect: '+12 population capacity', requires: 'arcologies', size: 2 },
  foundry: { id: 'foundry', name: 'Assembly Foundry', cost: 60, upkeep: 6, effect: '+0.6 population per turn. Apex citizens are manufactured, not born', onlyFaction: 'apex' },
};

export const BUILDING_IDS = Object.keys(BUILDINGS) as BuildingId[];

export const footprint = (b: BuildingId) => BUILDINGS[b].size ?? 1;
