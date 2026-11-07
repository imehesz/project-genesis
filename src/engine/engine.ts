import type { Command, GameState } from './types.ts';
import { applyCommand, simulateTick } from './rules.ts';
import { createInitialState } from './state.ts';

export { createInitialState };

export const TICK_MS = 50; // 20 Hz real-time simulation
const MAX_STEPS_PER_ADVANCE = 10; // never spiral after a long tab switch

export type Listener = (state: GameState, prev: GameState) => void;

export interface Engine {
  getState(): GameState;
  dispatch(cmd: Command): void;
  /** Advance the real-time clock by dtMs; runs whole fixed ticks only. */
  advance(dtMs: number): void;
  /** The real-time clock only runs during real-time scenes (ground battles). */
  setRealtime(running: boolean): void;
  subscribe(fn: Listener): () => void;
  /** Replace the whole state (save games, dev scenarios, later: server snapshots). */
  load(state: GameState): void;
}

export function createEngine(initial: GameState = createInitialState()): Engine {
  let state = initial;
  let realtime = false;
  let acc = 0;
  const listeners = new Set<Listener>();

  const commit = (next: GameState) => {
    if (next === state) return;
    const prev = state;
    state = next;
    for (const fn of listeners) fn(state, prev);
  };

  return {
    getState: () => state,
    dispatch(cmd) {
      commit(applyCommand(state, cmd));
    },
    advance(dtMs) {
      if (!realtime) return;
      acc += dtMs;
      let steps = 0;
      let next = state;
      while (acc >= TICK_MS && steps < MAX_STEPS_PER_ADVANCE) {
        next = simulateTick(next);
        acc -= TICK_MS;
        steps++;
      }
      if (steps === MAX_STEPS_PER_ADVANCE) acc = 0;
      commit(next);
    },
    setRealtime(running) {
      realtime = running;
      acc = 0;
    },
    load(next) {
      commit(next);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
