import type { GameState } from './types.ts';

export function createInitialState(seed = 1): GameState {
  return { tick: 0, turn: 1, credits: 0, campaign: null, galaxy: null, colonies: {}, empires: {}, fleets: {}, nextFleetId: 1, battle: null, battleQueue: [], ground: null, report: null, entities: {}, nextEntityId: 1, rng: seed | 0 };
}
