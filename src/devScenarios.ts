import { engine, useUi } from './store/gameStore.ts';
import { addShips, applyCommand, createInitialState, resolveEncounters } from './engine/index.ts';

/**
 * Dev-only shortcuts (vite dev server only): open the app with ?scenario=battle to jump straight
 * into a space battle at the Saurian homeworld, or ?scenario=ground for a planetary invasion of it.
 */
export function runDevScenario() {
  if (!import.meta.env.DEV) return;
  (window as unknown as Record<string, unknown>).__pg = { engine, useUi }; // poke at it from devtools
  const scenario = new URLSearchParams(location.search).get('scenario');
  if (scenario === 'ground') {
    let s = applyCommand(createInitialState(), { type: 'NEW_CAMPAIGN', seed: 4242, faction: 'terran' });
    const target = Object.values(s.colonies).find((c) => c.faction === 'saurian')!;
    s = addShips(s, 'terran', target.systemId, 'transport', 2);
    s = { ...s, report: { turn: 1, events: [] } };
    const fleet = Object.values(s.fleets).find((f) => f.faction === 'terran' && f.ships.transport)!;
    s = applyCommand(s, { type: 'INVADE', fleetId: fleet.id, planetId: target.planetId });
    engine.load(s);
    useUi.getState().go({ name: 'ground' });
    return;
  }
  if (scenario !== 'battle') return;
  let s = applyCommand(createInitialState(), { type: 'NEW_CAMPAIGN', seed: 4242, faction: 'terran' });
  const home = Object.values(s.colonies).find((c) => c.faction === 'saurian')!.systemId;
  s = addShips(s, 'terran', home, 'frigate', 4);
  s = addShips(s, 'terran', home, 'colony', 1);
  s = addShips(s, 'saurian', home, 'frigate', 3);
  s = resolveEncounters({ ...s, report: { turn: 1, events: [] } });
  engine.load(s);
  useUi.getState().go({ name: 'battle' });
}
