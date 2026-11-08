import type { FactionId } from '../types.ts';

export type UnitId = 'infantry' | 'tank' | 'commander' | 'tower';

/** Planet-mission prices (LIGHT / DARK) and training time. */
export interface UnitPrice { light: number; dark: number; ticks: number }

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
  /** Trainable on a planet mission: what it costs and how long it takes. */
  price?: UnitPrice;
  /** Its "worth" for XP: killing something worth more than you teaches you more (BAR's unit power). */
  power: number;
}

export const UNITS: Record<UnitId, UnitDef> = {
  // on foot: 80% of a tank's speed (the commander too)
  infantry: { id: 'infantry', name: 'Assault Infantry', hp: 60, damage: 4, range: 3, cooldown: 16, speed: 0.96, price: { light: 50, dark: 5, ticks: 160 }, power: 70 },
  tank: { id: 'tank', name: 'Hover Tank', hp: 180, damage: 11, range: 4.5, cooldown: 30, speed: 1.2, price: { light: 120, dark: 30, ticks: 360 }, power: 240 },
  // the campaign's commander: a veteran soldier, +10% health and firepower, grows with XP that carries over
  commander: { id: 'commander', name: 'Commander', hp: 66, damage: 4.4, range: 3, cooldown: 16, speed: 0.96, power: 150 },
  // ancient defence tower (campaign 1): static, out-ranges infantry, needs ~10 soldiers to bring down
  tower: { id: 'tower', name: 'Ancient Tower', hp: 360, damage: 11, range: 5, cooldown: 24, speed: 0, power: 500 },
};

/** Units the ground-battle screens list (invasions only field these). */
export const TROOP_IDS: UnitId[] = ['infantry', 'tank'];

/** Faction flavour: Saurians are the best ground troops, Apex units hover fast. */
export function unitStats(id: UnitId, f: FactionId) {
  const d = UNITS[id];
  const tough = f === 'saurian' ? 1.25 : 1;
  return { hp: Math.round(d.hp * tough), damage: d.damage * tough, range: d.range, cooldown: d.cooldown, speed: d.speed * (f === 'apex' ? 1.2 : 1) };
}

/** What one Troop Transport lands. */
export const TRANSPORT_LOAD: Partial<Record<UnitId, number>> = { infantry: 6, tank: 2 };
