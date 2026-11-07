import type { BuildingId } from './buildings.ts';

export type TechId =
  | 'holoent' | 'xenocommerce' | 'autofab' | 'neural' | 'deflectors' | 'orbital' | 'arcologies' | 'fusion';

export type TechField = 'Engineering' | 'Science' | 'Society';

export interface TechDef {
  id: TechId;
  name: string;
  field: TechField;
  cost: number;
  requires?: TechId;
  unlocks?: BuildingId;
  effect: string;
}

export const TECHS: Record<TechId, TechDef> = {
  autofab: { id: 'autofab', name: 'Automated Fabrication', field: 'Engineering', cost: 45, effect: 'Fabricator Plants give +1 production' },
  deflectors: { id: 'deflectors', name: 'Deflector Theory', field: 'Engineering', cost: 60, unlocks: 'shield', effect: 'Unlocks the Planetary Shield' },
  orbital: { id: 'orbital', name: 'Orbital Engineering', field: 'Engineering', cost: 80, requires: 'autofab', unlocks: 'shipyard', effect: 'Unlocks the Orbital Shipyard' },
  fusion: { id: 'fusion', name: 'Fusion Power', field: 'Engineering', cost: 120, requires: 'autofab', effect: '+15% production on every colony' },
  neural: { id: 'neural', name: 'Neural Networks', field: 'Science', cost: 50, effect: 'Research Labs give +1 research' },
  holoent: { id: 'holoent', name: 'Holo-Entertainment', field: 'Society', cost: 30, unlocks: 'arena', effect: 'Unlocks the Holo Arena' },
  xenocommerce: { id: 'xenocommerce', name: 'Xeno-Commerce', field: 'Society', cost: 40, unlocks: 'tradehub', effect: 'Unlocks the Trade Hub' },
  arcologies: { id: 'arcologies', name: 'Arcology Design', field: 'Society', cost: 90, requires: 'holoent', unlocks: 'arcology', effect: 'Unlocks the Arcology' },
};

export const TECH_IDS = Object.keys(TECHS) as TechId[];
