import type { FactionId } from '../types.ts';

export type UnitId = 'infantry' | 'tank';

export interface UnitDef {
  id: UnitId;
  name: string;
  hp: number;
  damage: number;
  /** Weapon reach in surface cells. */
  range: number;
  /** Ticks between shots (20 ticks = 1 s). */
  cooldown: number;
  /** Surface cells per second. */
  speed: number;
}

export const UNITS: Record<UnitId, UnitDef> = {
  infantry: { id: 'infantry', name: 'Assault Infantry', hp: 60, damage: 4, range: 3, cooldown: 16, speed: 1.7 },
  tank: { id: 'tank', name: 'Hover Tank', hp: 180, damage: 11, range: 4.5, cooldown: 30, speed: 1.2 },
};

/** Faction flavour: Saurians are the best ground troops, Apex units hover fast. */
export function unitStats(id: UnitId, f: FactionId) {
  const d = UNITS[id];
  const tough = f === 'saurian' ? 1.25 : 1;
  return { hp: Math.round(d.hp * tough), damage: d.damage * tough, range: d.range, cooldown: d.cooldown, speed: d.speed * (f === 'apex' ? 1.2 : 1) };
}

/** What one Troop Transport lands. */
export const TRANSPORT_LOAD: Record<UnitId, number> = { infantry: 6, tank: 2 };
