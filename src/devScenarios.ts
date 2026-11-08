import { engine, landOn, startStoryCampaign, useUi } from './store/gameStore.ts';
import * as E from './engine/index.ts';
import { addShips, applyCommand, createInitialState, resolveEncounters } from './engine/index.ts';

/**
 * Dev-only shortcuts (vite dev server only): open the app with ?scenario=battle to jump straight
 * into a space battle at the Saurian homeworld, or ?scenario=ground for a planetary invasion of it.
 */
export function runDevScenario() {
  if (!import.meta.env.DEV) return;
  Object.assign(((window as unknown as Record<string, object>).__pg ??= {}), { engine, useUi, E }); // poke at it from devtools / demo recorder
  const scenario = new URLSearchParams(location.search).get('scenario');
  // story campaign: ?scenario=c1 opens the star system, ?scenario=c1-land lands on planet 1 (&reveal=1 lifts the fog)
  if (scenario === 'c1' || scenario === 'c1-land') {
    startStoryCampaign();
    if (scenario === 'c1') { useUi.getState().go({ name: 'system' }); return; }
    engine.dispatch({ type: 'MISSION_BRIEFED' });
    engine.dispatch({ type: 'MISSION_SHIP_MOVE', planetId: 0 });
    engine.dispatch({ type: 'END_TURN' });
    landOn(0);
    if (new URLSearchParams(location.search).get('reveal') === '1') {
      const s = engine.getState();
      engine.load({ ...s, op: { ...s.op!, explored: s.op!.explored.map(() => 1), visible: s.op!.visible.map(() => 1) } });
    }
    return;
  }
  if (scenario === 'ground') {
    let s = applyCommand(createInitialState(), { type: 'NEW_CAMPAIGN', seed: 4242, faction: 'terran' });
    const target = Object.values(s.colonies).find((c) => c.faction === 'saurian')!;
    const transports = Math.max(1, Number(new URLSearchParams(location.search).get('transports')) || 2);
    s = addShips(s, 'terran', target.systemId, 'transport', transports);
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
