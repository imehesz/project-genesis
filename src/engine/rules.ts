import type { Command, Entity, FactionId, GameState, TurnEvent } from './types.ts';
import { nextRandom } from './rng.ts';
import { generateGalaxy } from './galaxy.ts';
import { createInitialState } from './state.ts';
import { cancelQueue, demolish, endTurn, queueBuilding, queueShip, rushBuy, seedEmpires, setResearch, setTax } from './economy.ts';
import { colonize, moveFleet, stopFleet } from './fleets.ts';
import { planAi } from './ai.ts';
import { battleAuto, battleClose, battleEndRound, battleFire, battleMove, battleRetreat, resolveEncounters } from './battle.ts';
import { FACTION_IDS } from './factions.ts';
import { groundClose, groundOrder, groundRetreat, groundTick, invade } from './ground.ts';
import { missionAfterOp, missionBriefed, missionEndTurn, missionLand, missionShipMove, newMission } from './mission.ts';
import { opBuild, opCancelTrain, opClose, opConverter, opOrder, opRally, opRepair, opTick, opTrain } from './op.ts';

export const CUBE_EVERY_CREDITS = 10;

/**
 * Pure reducer: (state, command, actor) -> new state. Never mutates its input.
 * `actor` is the faction issuing the command (defaults to the local player); every command is
 * validated against it, so the same code can later referee multiplayer.
 */
export function applyCommand(state: GameState, cmd: Command, actor?: FactionId, events?: TurnEvent[]): GameState {
  const who = actor ?? state.campaign?.playerFaction;
  switch (cmd.type) {
    case 'ADD_CREDITS':
      return addCredits(state, cmd.amount);
    case 'NEW_CAMPAIGN':
      return seedEmpires({
        ...createInitialState(cmd.seed),
        campaign: { seed: cmd.seed, playerFaction: cmd.faction },
        galaxy: generateGalaxy(cmd.seed),
      });
    case 'END_TURN':
      if (state.battle || state.ground || state.op) return state; // finish the fight first / no turns on a planet
      if (state.mission) return missionEndTurn(state);
      return state.campaign ? runTurn(state) : { ...state, turn: state.turn + 1 };
    case 'NEW_MISSION':
      return newMission(cmd.id);
  }
  if (!who || !state.campaign) return state;
  switch (cmd.type) {
    case 'SET_TAX':
      return setTax(state, who, cmd.colonyId, cmd.rate);
    case 'QUEUE_BUILDING':
      return queueBuilding(state, who, cmd.colonyId, cmd.building, cmd.at);
    case 'DEMOLISH':
      return demolish(state, who, cmd.colonyId, cmd.structureId);
    case 'QUEUE_SHIP':
      return queueShip(state, who, cmd.colonyId, cmd.ship);
    case 'CANCEL_QUEUE':
      return cancelQueue(state, who, cmd.colonyId, cmd.index);
    case 'RUSH_BUY':
      return rushBuy(state, who, cmd.colonyId);
    case 'SET_RESEARCH':
      return setResearch(state, who, cmd.tech);
    case 'MOVE_FLEET':
      return moveFleet(state, who, cmd.fleetId, cmd.to);
    case 'STOP_FLEET':
      return stopFleet(state, who, cmd.fleetId);
    case 'COLONIZE':
      return colonize(state, who, cmd.fleetId, cmd.planetId, events);
    case 'BATTLE_MOVE':
      return battleMove(state, who, cmd.uid, cmd.x, cmd.y);
    case 'BATTLE_FIRE':
      return battleFire(state, who, cmd.uid, cmd.target);
    case 'BATTLE_END_ROUND':
      return battleEndRound(state, who);
    case 'BATTLE_AUTO':
      return battleAuto(state, who);
    case 'BATTLE_RETREAT':
      return battleRetreat(state, who);
    case 'BATTLE_CLOSE':
      return battleClose(state);
    case 'INVADE':
      return invade(state, who, cmd.fleetId, cmd.planetId);
    case 'GROUND_ORDER':
      return groundOrder(state, who, cmd.ids, cmd.move, cmd.attack);
    case 'GROUND_RETREAT':
      return groundRetreat(state, who);
    case 'GROUND_CLOSE':
      return groundClose(state);
    case 'MISSION_BRIEFED':
      return missionBriefed(state);
    case 'MISSION_SHIP_MOVE':
      return missionShipMove(state, cmd.planetId);
    case 'MISSION_LAND':
      return missionLand(state, cmd.planetId);
    case 'OP_ORDER':
      return opOrder(state, who, cmd.ids, cmd.move, cmd.attack);
    case 'OP_BUILD':
      return opBuild(state, who, cmd.building, cmd.x, cmd.y);
    case 'OP_REPAIR':
      return opRepair(state, who, cmd.structureId);
    case 'OP_TRAIN':
      return opTrain(state, who, cmd.structureId, cmd.unit);
    case 'OP_CANCEL_TRAIN':
      return opCancelTrain(state, who, cmd.structureId, cmd.index);
    case 'OP_CONVERTER':
      return opConverter(state, who, cmd.on);
    case 'OP_RALLY':
      return opRally(state, who, cmd.structureId, cmd.at);
    case 'OP_CLOSE':
      return opClose(missionAfterOp(state));
  }
}

/** END_TURN: AI empires issue their orders, then the turn resolves for everyone. */
function runTurn(state: GameState): GameState {
  const events: TurnEvent[] = [];
  for (const f of FACTION_IDS) {
    if (f === state.campaign!.playerFaction) continue;
    for (const cmd of planAi(state, f)) state = applyCommand(state, cmd, f, events);
  }
  return resolveEncounters(endTurn(state, events));
}

function addCredits(state: GameState, amount: number): GameState {
  if (!Number.isFinite(amount) || amount === 0) return state;
  const before = state.credits;
  const after = Math.max(0, before + amount);
  let next: GameState = { ...state, credits: after };

  // Spawn one cube for every multiple of CUBE_EVERY_CREDITS crossed on the way up.
  const crossed =
    Math.floor(after / CUBE_EVERY_CREDITS) - Math.floor(before / CUBE_EVERY_CREDITS);
  for (let i = 0; i < crossed; i++) next = spawnCube(next);
  return next;
}

function spawnCube(state: GameState): GameState {
  let rng = state.rng;
  let a: number, r: number, h: number;
  [a, rng] = nextRandom(rng);
  [r, rng] = nextRandom(rng);
  [h, rng] = nextRandom(rng);
  const angle = a * Math.PI * 2;
  const radius = 2 + r * 7;
  const entity: Entity = {
    id: state.nextEntityId,
    kind: 'cube',
    pos: { x: Math.cos(angle) * radius, y: 0.5 + h * 2.5, z: Math.sin(angle) * radius },
    spawnedAtTick: state.tick,
  };
  return {
    ...state,
    rng,
    nextEntityId: state.nextEntityId + 1,
    entities: { ...state.entities, [entity.id]: entity },
  };
}

/** One fixed real-time simulation step. Ground-battle systems (movement, combat) will hook in here. */
export function simulateTick(state: GameState): GameState {
  const next = { ...state, tick: state.tick + 1 };
  if (next.op && !next.op.over) return opTick(next);
  return next.ground && !next.ground.over ? groundTick(next) : next;
}
