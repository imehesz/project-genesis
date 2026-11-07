export type ShipId = 'scout' | 'frigate' | 'colony' | 'transport';

export interface ShipDef {
  id: ShipId;
  name: string;
  /** Production points to build (needs an Orbital Shipyard at the colony). */
  cost: number;
  upkeep: number;
  /** Galaxy units per turn. A fleet moves at its slowest ship's speed. */
  speed: number;
  attack: number;
  hull: number;
  /** Tactical battle: cells per round and weapon reach (Chebyshev distance). */
  move: number;
  range: number;
  effect: string;
}

export const SHIPS: Record<ShipId, ShipDef> = {
  scout: { id: 'scout', name: 'Scout', cost: 25, upkeep: 0.5, speed: 30, attack: 0, hull: 4, move: 5, range: 0, effect: 'Fast and cheap. Explores the galaxy.' },
  frigate: { id: 'frigate', name: 'Frigate', cost: 50, upkeep: 1.5, speed: 20, attack: 4, hull: 12, move: 3, range: 3, effect: 'Light warship for escort and patrol.' },
  colony: { id: 'colony', name: 'Colony Ship', cost: 90, upkeep: 2, speed: 14, attack: 0, hull: 6, move: 2, range: 0, effect: 'Founds a colony on a habitable planet. Consumed on landing.' },
  transport: { id: 'transport', name: 'Troop Transport', cost: 70, upkeep: 1.5, speed: 16, attack: 0, hull: 10, move: 2, range: 0, effect: 'Carries 6 infantry and 2 tanks to invade an enemy colony.' },
};

export const SHIP_IDS = Object.keys(SHIPS) as ShipId[];
