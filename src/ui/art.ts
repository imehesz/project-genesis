import type { BuildItem, BuildingId, PlanetType, ShipId } from '../engine/index.ts';

export const planetArt = (t: PlanetType) => `art/planets/${t}.webp`;
export const buildingArt = (b: BuildingId) => `art/buildings/${b}.webp`;
export const shipArt = (s: ShipId) => `art/ships/${s}.webp`;
export const itemArt = (i: BuildItem) => (i.kind === 'building' ? buildingArt(i.id) : shipArt(i.id));
