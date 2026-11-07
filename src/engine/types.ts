// Pure data shapes for the game simulation.
// RULE: nothing in src/engine may import React, Three.js, Zustand or touch the DOM.
// The engine must run headless (Node) so it can move to a server in Phase 2.

import type { BuildingId } from './data/buildings.ts';
import type { TechId } from './data/techs.ts';
import type { ShipId } from './data/ships.ts';
import type { Battle } from './battle.ts';
import type { GroundBattle } from './ground.ts';

export type EntityId = number;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Entity {
  id: EntityId;
  kind: 'cube';
  pos: Vec3;
  spawnedAtTick: number;
}

export type FactionId = 'terran' | 'saurian' | 'apex';
export type StarClass = 'O' | 'B' | 'A' | 'F' | 'G' | 'K' | 'M';
export type PlanetType = 'terran' | 'ocean' | 'desert' | 'volcanic' | 'ice' | 'barren' | 'gas';

export interface Planet {
  id: number; // orbit index within its system
  name: string;
  type: PlanetType;
  size: number; // 1 (tiny) .. 5 (giant)
  /** Ownership marker. The colony's economy lives in GameState.colonies. */
  colony: { faction: FactionId; homeworld: boolean } | null;
}

export interface StarSystem {
  id: number;
  name: string;
  pos: Vec3;
  star: StarClass;
  planets: Planet[];
  owner: FactionId | null;
}

export interface Galaxy {
  seed: number;
  /** Spiral shape parameters, so views can draw dust that matches the star layout. */
  arms: number;
  twist: number;
  rotation: number;
  radius: number;
  systems: StarSystem[];
}

export type ColonyId = string; // `${systemId}-${planetId}`

/** A building on the colony's surface grid; (x, y) is its top-left cell. */
export interface Structure {
  id: number;
  building: BuildingId;
  x: number;
  y: number;
}

export type BuildItem = { kind: 'building'; id: BuildingId; x: number; y: number } | { kind: 'ship'; id: ShipId };

export interface Colony {
  id: ColonyId;
  systemId: number;
  planetId: number;
  faction: FactionId;
  /** Millions of citizens. */
  population: number;
  /** 0..100 */
  morale: number;
  /** Percent, 0..50 */
  taxRate: number;
  structures: Structure[];
  nextStructureId: number;
  queue: (BuildItem & { progress: number })[];
}

export type FleetId = number;

export interface Fleet {
  id: FleetId;
  name: string;
  faction: FactionId;
  ships: Partial<Record<ShipId, number>>;
  pos: Vec3;
  /** System the fleet is parked at, or null while in deep space. */
  at: number | null;
  /** System it is flying to, or null when holding position. */
  dest: number | null;
}

export interface Empire {
  faction: FactionId;
  credits: number;
  research: { current: TechId | null; progress: number };
  techs: TechId[];
  fleetsCommissioned: number;
}

export interface TurnEvent {
  kind: 'built' | 'ship' | 'researched' | 'growth' | 'arrived' | 'colony' | 'rival' | 'warning' | 'victory' | 'defeat';
  text: string;
  colonyId?: ColonyId;
  systemId?: number;
  fleetId?: FleetId;
}

export interface Campaign {
  seed: number;
  playerFaction: FactionId;
}

export interface GameState {
  /** Fixed-step simulation tick (real-time layer: ground battles). */
  tick: number;
  /** Strategic turn counter (turn-based layer: galaxy map + space battles). */
  turn: number;
  credits: number;
  campaign: Campaign | null;
  galaxy: Galaxy | null;
  colonies: Record<ColonyId, Colony>;
  empires: Partial<Record<FactionId, Empire>>;
  fleets: Record<FleetId, Fleet>;
  nextFleetId: FleetId;
  /** The tactical battle being fought (the player must finish it before ending the turn). */
  battle: Battle | null;
  battleQueue: { systemId: number; sides: [FactionId, FactionId] }[];
  /** A real-time planetary invasion in progress (runs on the engine's fixed tick). */
  ground: GroundBattle | null;
  /** What happened to the player at the end of the last turn. */
  report: { turn: number; events: TurnEvent[] } | null;
  entities: Record<EntityId, Entity>;
  nextEntityId: EntityId;
  /** RNG state lives in the game state so a save/replay/server reproduces it exactly. */
  rng: number;
}

/**
 * Everything that changes game state goes through a Command. In Phase 2 these travel over the network.
 * Every command is applied on behalf of an actor faction (see applyCommand) and validated against it.
 */
export type Command =
  | { type: 'ADD_CREDITS'; amount: number }
  | { type: 'END_TURN' }
  | { type: 'NEW_CAMPAIGN'; seed: number; faction: FactionId }
  | { type: 'SET_TAX'; colonyId: ColonyId; rate: number }
  | { type: 'QUEUE_BUILDING'; colonyId: ColonyId; building: BuildingId; at?: { x: number; y: number } }
  | { type: 'DEMOLISH'; colonyId: ColonyId; structureId: number }
  | { type: 'QUEUE_SHIP'; colonyId: ColonyId; ship: ShipId }
  | { type: 'CANCEL_QUEUE'; colonyId: ColonyId; index: number }
  | { type: 'RUSH_BUY'; colonyId: ColonyId }
  | { type: 'SET_RESEARCH'; tech: TechId | null }
  | { type: 'MOVE_FLEET'; fleetId: FleetId; to: number }
  | { type: 'STOP_FLEET'; fleetId: FleetId }
  | { type: 'COLONIZE'; fleetId: FleetId; planetId: number }
  | { type: 'BATTLE_MOVE'; uid: number; x: number; y: number }
  | { type: 'BATTLE_FIRE'; uid: number; target: number }
  | { type: 'BATTLE_END_ROUND' }
  | { type: 'BATTLE_AUTO' }
  | { type: 'BATTLE_RETREAT' }
  | { type: 'BATTLE_CLOSE' }
  | { type: 'INVADE'; fleetId: FleetId; planetId: number }
  | { type: 'GROUND_ORDER'; ids: number[]; move?: { x: number; y: number }; attack?: number }
  | { type: 'GROUND_RETREAT' }
  | { type: 'GROUND_CLOSE' };
