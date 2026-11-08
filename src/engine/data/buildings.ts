import type { FactionId } from '../types.ts';
import type { TechId } from './techs.ts';

export type BuildingId =
  | 'habitat' | 'fabricator' | 'lab' | 'tradehub' | 'arena' | 'shield' | 'shipyard' | 'arcology' | 'foundry'
  // planet-mission (real-time) buildings: never offered on the 4X colony screens
  | 'command' | 'barracks' | 'vehiclebay' | 'shelter' | 'solar' | 'extractor' | 'converter';

/** What a planet-mission building costs (LIGHT / DARK) and does. */
export interface OpBuildingDef {
  light: number;
  dark: number;
  /** Only found as a ruin (repair it); never built from scratch. */
  ruinOnly?: boolean;
  hp: number;
  /** Income while working, per second. */
  lightPerSec?: number;
  darkPerSec?: number;
  /** Units this building trains. */
  trains?: ('infantry' | 'tank')[];
  /** Must stand on a dark hole. */
  onHole?: boolean;
  /** Cells around it that it reveals. */
  vision: number;
}

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
  /** Planet-mission building. Its `cost` is then build/repair time in ticks (20 = 1 s). */
  op?: OpBuildingDef;
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

  // ---- planet mission (campaign). cost = ticks to build or repair. Repairs cost half the price.
  command: { id: 'command', name: 'Command Center', cost: 400, upkeep: 0, size: 2, effect: 'The colony\'s heart. Powers new construction. +1 LIGHT/s',
    op: { light: 200, dark: 20, ruinOnly: true, hp: 900, lightPerSec: 1, vision: 5 } },
  barracks: { id: 'barracks', name: 'Barracks', cost: 240, upkeep: 0, effect: 'Trains Assault Infantry',
    op: { light: 100, dark: 20, ruinOnly: true, hp: 450, trains: ['infantry'], vision: 4 } },
  vehiclebay: { id: 'vehiclebay', name: 'Vehicle Bay', cost: 320, upkeep: 0, size: 2, effect: 'Builds Hover Tanks',
    op: { light: 240, dark: 60, ruinOnly: true, hp: 650, trains: ['tank'], vision: 4 } },
  shelter: { id: 'shelter', name: 'Shelter', cost: 160, upkeep: 0, effect: 'Old living quarters. Its solar roof still works: +0.5 LIGHT/s',
    op: { light: 40, dark: 4, ruinOnly: true, hp: 250, lightPerSec: 0.5, vision: 3 } },
  solar: { id: 'solar', name: 'Solar Collector', cost: 200, upkeep: 0, effect: 'Collects LIGHT anywhere the sun reaches: +2 LIGHT/s',
    op: { light: 40, dark: 5, hp: 200, lightPerSec: 2, vision: 3 } },
  extractor: { id: 'extractor', name: 'Dark Extractor', cost: 300, upkeep: 0, effect: 'Pumps DARK Energy out of a dark hole: +0.5 DARK/s',
    op: { light: 60, dark: 0, hp: 300, darkPerSec: 0.5, onHole: true, vision: 3 } }, // LIGHT only: DARK can always be restarted
  converter: { id: 'converter', name: 'Converter', cost: 400, upkeep: 0, effect: 'Turns 10 LIGHT into 1 DARK (5 LIGHT/s -> 0.5 DARK/s). One way only',
    op: { light: 100, dark: 0, hp: 350, vision: 3 } }, // LIGHT only, same reason
};

/** The 4X colony buildings (colony screens, AI, economy). */
export const BUILDING_IDS = (Object.keys(BUILDINGS) as BuildingId[]).filter((b) => !BUILDINGS[b].op);
/** Planet-mission buildings. */
export const OP_BUILDING_IDS = (Object.keys(BUILDINGS) as BuildingId[]).filter((b) => !!BUILDINGS[b].op);
/** Repair price: half of what it would cost new. */
export const repairPrice = (b: BuildingId) => ({ light: Math.round(BUILDINGS[b].op!.light / 2), dark: Math.round(BUILDINGS[b].op!.dark / 2) });

export const footprint = (b: BuildingId) => BUILDINGS[b].size ?? 1;
