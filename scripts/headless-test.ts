// Proves the engine runs with no browser, no Three.js, no React: `npm run headless`
import { createEngine, CUBE_EVERY_CREDITS } from '../src/engine/index.ts';

const engine = createEngine();
let spawned = 0;
engine.subscribe((s, prev) => {
  spawned += Object.keys(s.entities).length - Object.keys(prev.entities).length;
});

for (let i = 0; i < 25; i++) engine.dispatch({ type: 'ADD_CREDITS', amount: 1 });
engine.dispatch({ type: 'ADD_CREDITS', amount: 17 }); // 25 -> 42 crosses 30 and 40
engine.dispatch({ type: 'END_TURN' });
engine.setRealtime(true);
for (let i = 0; i < 50; i++) engine.advance(20); // 1 s of 50 fps frames

const s = engine.getState();
const expected = Math.floor(s.credits / CUBE_EVERY_CREDITS);
console.log({ credits: s.credits, turn: s.turn, tick: s.tick, cubes: spawned });
if (spawned !== expected || s.tick !== 20 || s.turn !== 2) {
  console.error(`FAIL: expected ${expected} cubes, 20 ticks, turn 2`);
  process.exit(1);
}
console.log('OK: engine ran headless');

// --- galaxy generation: deterministic per seed, varied across seeds ---
import { generateGalaxy } from '../src/engine/index.ts';
const g1 = generateGalaxy(12345);
const g2 = generateGalaxy(12345);
const g3 = generateGalaxy(999);
const homes = g1.systems.filter((s) => s.owner);
const names = new Set(g1.systems.map((s) => s.name));
console.log({ systems: g1.systems.length, arms: g1.arms, homes: homes.map((h) => `${h.owner}@${h.name}`) });
if (JSON.stringify(g1) !== JSON.stringify(g2)) { console.error('FAIL: same seed gave different galaxies'); process.exit(1); }
if (JSON.stringify(g1) === JSON.stringify(g3)) { console.error('FAIL: different seeds gave the same galaxy'); process.exit(1); }
if (homes.length !== 3 || names.size !== g1.systems.length || g1.systems.length < 60) { console.error('FAIL: galaxy shape'); process.exit(1); }
for (let seed = 1; seed <= 200; seed++) {
  const g = generateGalaxy(seed);
  if (g.systems.filter((s) => s.owner).length !== 3 || g.systems.length < 60) { console.error(`FAIL: seed ${seed}`); process.exit(1); }
}
engine.dispatch({ type: 'NEW_CAMPAIGN', seed: 777, faction: 'terran' });
if (engine.getState().galaxy?.seed !== 777 || engine.getState().empires.terran?.credits !== 500) { console.error('FAIL: NEW_CAMPAIGN'); process.exit(1); }
console.log('OK: galaxy generation deterministic, 200 seeds valid');

// --- economy: build, research, taxes over 30 turns ---
import { colonyStats } from '../src/engine/index.ts';
const home = Object.values(engine.getState().colonies).find((c) => c.faction === 'terran')!;
engine.dispatch({ type: 'QUEUE_BUILDING', colonyId: home.id, building: 'fabricator' });
engine.dispatch({ type: 'QUEUE_BUILDING', colonyId: home.id, building: 'habitat' });
engine.dispatch({ type: 'QUEUE_BUILDING', colonyId: home.id, building: 'arena' }); // locked: must be ignored
engine.dispatch({ type: 'SET_RESEARCH', tech: 'holoent' });
engine.dispatch({ type: 'SET_TAX', colonyId: home.id, rate: 99 });
const s0 = engine.getState();
if (s0.colonies[home.id].queue.length !== 2 || s0.colonies[home.id].taxRate !== 50) { console.error('FAIL: queue/tax guards'); process.exit(1); }
engine.dispatch({ type: 'SET_TAX', colonyId: home.id, rate: 25 });
for (let i = 0; i < 30; i++) engine.dispatch({ type: 'END_TURN' });
const s1 = engine.getState();
const h = s1.colonies[home.id];
const st = colonyStats(s1, h);
console.log({ turn: s1.turn, pop: h.population, cap: st.capacity, morale: h.morale, credits: s1.empires.terran!.credits, techs: s1.empires.terran!.techs, structures: h.structures.length, net: +st.net.toFixed(1), prod: +st.production.toFixed(1) });
if (h.queue.length || h.structures.filter((x) => x.building === 'fabricator').length !== 3 || !s1.empires.terran!.techs.includes('holoent') || h.population <= 8) { console.error('FAIL: economy'); process.exit(1); }
console.log('OK: economy ran 30 turns');

// --- fleets, colonization and AI expansion ---
engine.dispatch({ type: 'NEW_CAMPAIGN', seed: 4242, faction: 'terran' });
{
  const s = engine.getState();
  const homeCol = Object.values(s.colonies).find((c) => c.faction === 'terran')!;
  const scout = Object.values(s.fleets).find((f) => f.faction === 'terran')!;
  if (!scout || scout.ships.scout !== 1) { console.error('FAIL: starting scout'); process.exit(1); }
  // AI fleets must refuse player orders
  const aiFleet = Object.values(s.fleets).find((f) => f.faction !== 'terran')!;
  engine.dispatch({ type: 'MOVE_FLEET', fleetId: aiFleet.id, to: 0 });
  if (engine.getState().fleets[aiFleet.id].dest !== null) { console.error('FAIL: moved a rival fleet'); process.exit(1); }

  engine.dispatch({ type: 'QUEUE_SHIP', colonyId: homeCol.id, ship: 'colony' });
  let turns = 0;
  while (!Object.values(engine.getState().fleets).some((f) => f.faction === 'terran' && f.ships.colony) && turns < 20) {
    engine.dispatch({ type: 'END_TURN' });
    turns++;
  }
  const fleet = Object.values(engine.getState().fleets).find((f) => f.faction === 'terran' && f.ships.colony)!;
  if (!fleet) { console.error('FAIL: colony ship never launched'); process.exit(1); }
  // nearest system with a planet we can settle
  const st = engine.getState();
  const { colonizablePlanets, dist } = await import('../src/engine/index.ts');
  const target = st.galaxy!.systems
    .filter((sys) => sys.id !== homeCol.systemId && !sys.owner && colonizablePlanets(st, 'terran', sys).length)
    .sort((a, b) => dist(a.pos, fleet.pos) - dist(b.pos, fleet.pos))[0];
  engine.dispatch({ type: 'MOVE_FLEET', fleetId: fleet.id, to: target.id });
  let hops = 0;
  while (engine.getState().fleets[fleet.id].at !== target.id && hops < 30) {
    engine.dispatch({ type: 'END_TURN' });
    hops++;
  }
  const planet = colonizablePlanets(engine.getState(), 'terran', engine.getState().galaxy!.systems[target.id])[0];
  engine.dispatch({ type: 'COLONIZE', fleetId: fleet.id, planetId: planet.id });
  const after = engine.getState();
  const mineNow = Object.values(after.colonies).filter((c) => c.faction === 'terran').length;
  console.log({ shipTurns: turns, travelTurns: hops, target: target.name, planet: planet.name, terranColonies: mineNow });
  if (mineNow !== 2 || after.galaxy!.systems[target.id].owner !== 'terran') { console.error('FAIL: colonize'); process.exit(1); }

  for (let i = 0; i < 40; i++) engine.dispatch({ type: 'END_TURN' });
  const end = engine.getState();
  const per = (f: string) => Object.values(end.colonies).filter((c) => c.faction === f).length;
  console.log({ turn: end.turn, saurian: per('saurian'), apex: per('apex'), aiTechs: end.empires.saurian!.techs.length, saurianCredits: Math.round(end.empires.saurian!.credits) });
  if (per('saurian') < 2 || per('apex') < 2) { console.error('FAIL: AI did not expand'); process.exit(1); }
  console.log('OK: ships, fleets, colonization, AI expansion');
}

// --- surfaces + placement ---
import { planetSurface, placeBlocker, occupancy } from '../src/engine/index.ts';
{
  const a = planetSurface(1, 2, 3, 'terran', 4), b = planetSurface(1, 2, 3, 'terran', 4);
  if (a !== b || a.w !== 18) { console.error('FAIL: surface'); process.exit(1); }
  const s = engine.getState();
  for (const c of Object.values(s.colonies)) {
    const occ = occupancy(s, c);
    const cells = c.structures.reduce((n, st) => n + (st.building === 'shipyard' || st.building === 'arcology' || st.building === 'arena' ? 4 : 1), 0);
    if (occ.filter((o) => typeof o === 'number').length !== cells) { console.error('FAIL: overlapping structures on', c.id); process.exit(1); }
  }
  const home = Object.values(s.colonies).find((c) => c.faction === 'terran')!;
  const sf = (await import('../src/engine/index.ts')).surfaceOf(s, home);
  const water = sf.kinds.findIndex((k) => k !== 'land');
  const taken = home.structures[0];
  if (water >= 0 && !placeBlocker(s, home, 'habitat', water % sf.w, Math.floor(water / sf.w))) { console.error('FAIL: built on non-land'); process.exit(1); }
  if (!placeBlocker(s, home, 'habitat', taken.x, taken.y)) { console.error('FAIL: built on occupied cell'); process.exit(1); }
  const before = engine.getState().colonies[home.id].structures.length;
  engine.dispatch({ type: 'DEMOLISH', colonyId: home.id, structureId: taken.id });
  if (engine.getState().colonies[home.id].structures.length !== before - 1) { console.error('FAIL: demolish'); process.exit(1); }
  console.log({ surface: `${sf.w}x${sf.h}`, land: sf.kinds.filter((k) => k === 'land').length, homeStructures: home.structures.map((x) => `${x.building}@${x.x},${x.y}`).join(' ') });
  console.log('OK: surfaces + placement');
}

// --- tactical space battles ---
import { applyCommand } from '../src/engine/rules.ts';
import { addShips, resolveEncounters, battleAuto, reachableCells, targetsInRange, createInitialState, createEngine as mk } from '../src/engine/index.ts';
{
  let s = applyCommand(createInitialState(), { type: 'NEW_CAMPAIGN', seed: 99, faction: 'terran' });
  const sHome = Object.values(s.colonies).find((c) => c.faction === 'saurian')!.systemId;
  s = addShips(s, 'terran', sHome, 'frigate', 3);
  s = addShips(s, 'saurian', sHome, 'frigate', 2);
  s = { ...s, report: { turn: 1, events: [] } };
  s = resolveEncounters(s);
  const b = s.battle!;
  if (!b || b.sides[0] !== 'terran' || b.units.length !== 3 + 2 + 1) { console.error('FAIL: battle setup', b?.units.length); process.exit(1); }
  const mine = b.units.find((u) => u.faction === 'terran' && u.ship === 'frigate')!;
  const cell = reachableCells(b, mine.uid)[0];
  const moved = applyCommand(s, { type: 'BATTLE_MOVE', uid: mine.uid, x: cell.x, y: cell.y });
  const again = applyCommand(moved, { type: 'BATTLE_MOVE', uid: mine.uid, x: mine.x, y: mine.y });
  if (moved === s || again !== moved) { console.error('FAIL: move rules'); process.exit(1); }
  const foe = b.units.find((u) => u.faction === 'saurian')!;
  if (targetsInRange(b, mine.uid).length === 0 && applyCommand(s, { type: 'BATTLE_FIRE', uid: mine.uid, target: foe.uid }) !== s) { console.error('FAIL: fired out of range'); process.exit(1); }
  const enemyMove = applyCommand(s, { type: 'BATTLE_MOVE', uid: foe.uid, x: foe.x - 1, y: foe.y });
  if (enemyMove !== s) { console.error('FAIL: moved an enemy unit'); process.exit(1); }
  const r1 = battleAuto(s, 'terran'), r2 = battleAuto(s, 'terran');
  if (JSON.stringify(r1) !== JSON.stringify(r2) || !r1.battle?.over) { console.error('FAIL: auto-resolve determinism'); process.exit(1); }
  const shipsLeft = (st: typeof s, f: string) => Object.values(st.fleets).filter((x) => x.faction === f && x.at === sHome).reduce((n, x) => n + (x.ships.frigate ?? 0), 0);
  console.log({ winner: r1.battle!.over!.winner, reason: r1.battle!.over!.reason, rounds: r1.battle!.round, losses: JSON.stringify(r1.battle!.over!.losses), terranFrigatesLeft: shipsLeft(r1, 'terran'), saurianFrigatesLeft: shipsLeft(r1, 'saurian'), report: r1.report?.events.at(-1)?.text });
  const closed = applyCommand(r1, { type: 'BATTLE_CLOSE' });
  if (closed.battle) { console.error('FAIL: close'); process.exit(1); }
  const blocked = applyCommand(s, { type: 'END_TURN' });
  if (blocked !== s) { console.error('FAIL: END_TURN allowed mid-battle'); process.exit(1); }
  const ret = applyCommand(s, { type: 'BATTLE_RETREAT' });
  if (ret.battle?.over?.reason !== 'retreat') { console.error('FAIL: retreat'); process.exit(1); }

  // long run: player idles (auto-resolves any battle), AI plays 80 turns
  const e = mk(applyCommand(createInitialState(), { type: 'NEW_CAMPAIGN', seed: 2024, faction: 'terran' }));
  let fights = 0;
  for (let t = 0; t < 80; t++) {
    while (e.getState().battle) { fights++; e.dispatch({ type: 'BATTLE_AUTO' }); e.dispatch({ type: 'BATTLE_CLOSE' }); }
    e.dispatch({ type: 'END_TURN' });
  }
  const fin = e.getState();
  const per = (f: string) => Object.values(fin.colonies).filter((c) => c.faction === f).length;
  const guns = (f: string) => Object.values(fin.fleets).filter((x) => x.faction === f).reduce((n, x) => n + (x.ships.frigate ?? 0), 0);
  console.log({ turn: fin.turn, playerFights: fights, saurian: per('saurian'), apex: per('apex'), saurianFrigates: guns('saurian'), apexFrigates: guns('apex') });
  console.log('OK: space battles');
}

// --- ground invasion ---
import { invadeBlocker, garrisonOf, findPath, surfaceOf as sOf } from '../src/engine/index.ts';
{
  let s = applyCommand(createInitialState(), { type: 'NEW_CAMPAIGN', seed: 31337, faction: 'saurian' });
  s = { ...s, report: { turn: 1, events: [] } };
  const target = Object.values(s.colonies).find((c) => c.faction === 'apex')!;
  s = addShips(s, 'saurian', target.systemId, 'transport', 3);
  const fleet = Object.values(s.fleets).find((f) => f.faction === 'saurian' && f.ships.transport)!;
  // Apex scout is unarmed, so orbit is ours
  const why = invadeBlocker(s, fleet, target.planetId);
  if (why) { console.error('FAIL: invade blocked:', why); process.exit(1); }
  s = applyCommand(s, { type: 'INVADE', fleetId: fleet.id, planetId: target.planetId });
  const g = s.ground!;
  const sf = sOf(s, s.colonies[target.id]);
  const onLand = g.units.every((u) => sf.kinds[u.y * sf.w + u.x] === 'land');
  console.log({ garrison: garrisonOf(target), attackers: g.units.filter((u) => u.faction === 'saurian').length, defenders: g.units.filter((u) => u.faction === 'apex').length, onLand, transportsLeft: s.fleets[fleet.id]?.ships.transport ?? 0 });
  if (!onLand || s.fleets[fleet.id]?.ships.transport) { console.error('FAIL: deploy'); process.exit(1); }
  if (applyCommand(s, { type: 'END_TURN' }) !== s) { console.error('FAIL: END_TURN mid-invasion'); process.exit(1); }
  // a path never crosses non-land
  const a = g.units.find((u) => u.faction === 'saurian')!, d = g.units.find((u) => u.faction === 'apex')!;
  const path = findPath(sf, a.x, a.y, d.x, d.y);
  if (!path.length || path.some(([x, y]) => sf.kinds[y * sf.w + x] !== 'land')) { console.error('FAIL: path'); process.exit(1); }
  // attack-order everyone at the nearest defender, then let it run
  s = applyCommand(s, { type: 'GROUND_ORDER', ids: g.units.filter((u) => u.faction === 'saurian').map((u) => u.id), attack: d.id });
  // stand-in for a player: every 5 s, send idle troops at the nearest defender
  const run = (st: typeof s) => {
    let n = 0;
    while (st.ground && !st.ground.over && n < 20 * 600) {
      if (n % 100 === 0) {
        const gg = st.ground;
        for (const u of gg.units.filter((v) => v.alive && v.faction === 'saurian' && !v.order && v.target === null)) {
          const foe = gg.units.filter((v) => v.alive && v.faction === 'apex').sort((p, q) => Math.hypot(p.x - u.x, p.y - u.y) - Math.hypot(q.x - u.x, q.y - u.y))[0];
          if (foe) st = applyCommand(st, { type: 'GROUND_ORDER', ids: [u.id], attack: foe.id });
        }
      }
      st = simulate(st);
      n++;
    }
    return [st, n] as const;
  };
  const { simulateTick: simulate } = await import('../src/engine/rules.ts');
  const [r1, ticks] = run(s), [r2] = run(s);
  if (JSON.stringify(r1.ground) !== JSON.stringify(r2.ground)) { console.error('FAIL: ground determinism'); process.exit(1); }
  const over = r1.ground!.over!;
  console.log({ seconds: ticks / 20, winner: over.winner, captured: over.captured, losses: JSON.stringify(over.losses), colonyNow: r1.colonies[target.id].faction, pop: r1.colonies[target.id].population, report: r1.report?.events.at(-1)?.text });
  if (!over || (over.captured && r1.colonies[target.id].faction !== 'saurian')) { console.error('FAIL: capture'); process.exit(1); }
  console.log('OK: ground invasion');
}
