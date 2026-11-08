// Campaign 1 checks, headless: `node scripts/mission-test.ts [seeds|balance|economy]`
//  seeds   - scan terrain seeds for a good planet-1 map (big connected land, far-apart base and rune)
//  balance - the tower fight with N soldiers + the commander (3 should lose, ~10 should win)
//  economy - a scripted "sensible player": time to revive the colony and field 10 soldiers
import { applyCommand, simulateTick, findPath, largestRegion, surfaceOf, OP_BUILDING_IDS, BUILDINGS } from '../src/engine/index.ts';
import { C1 } from '../src/engine/mission.ts';
import type { GameState, GroundUnit } from '../src/engine/index.ts';
import { UNIT_DEFS } from '../src/engine/index.ts';
if (process.env.TOWER) Object.assign(UNIT_DEFS.tower, JSON.parse(process.env.TOWER)); // TOWER='{"hp":300}' to try numbers

const mode = process.argv[2] ?? 'all';

function landed(seed?: number): GameState {
  if (seed !== undefined) (C1 as { seed: number }).seed = seed;
  let s = applyCommand({} as GameState, { type: 'NEW_MISSION', id: 'c1' });
  s = applyCommand(s, { type: 'MISSION_SHIP_MOVE', planetId: 0 });
  s = applyCommand(s, { type: 'END_TURN' });
  s = applyCommand(s, { type: 'MISSION_LAND', planetId: 0 });
  if (!s.op) throw new Error('landing failed');
  return s;
}

function mapReport(s: GameState) {
  const op = s.op!;
  const surf = surfaceOf(s, s.colonies[op.colonyId]);
  const land = surf.kinds.filter((k) => k === 'land').length;
  const region = largestRegion(surf).length;
  const cmd = op.structures.find((t) => t.building === 'command')!;
  const path = findPath(surf, cmd.x, cmd.y, op.rune.x, op.rune.y);
  return { w: surf.w, land, regionShare: +(region / land).toFixed(2), ruins: op.structures.length, holes: op.holes.length, towers: op.units.filter((u) => u.kind === 'tower').length, pathToRune: path.length, nearHole: Math.min(...op.holes.map((h) => Math.hypot(h.x - cmd.x, h.y - cmd.y))).toFixed(1) };
}

if (mode === 'seeds') {
  const rows = [];
  for (let seed = 1900; seed < 1990; seed++) {
    try { rows.push({ seed, ...mapReport(landed(seed)) }); } catch (e) { rows.push({ seed, err: String(e) }); }
  }
  const good = rows.filter((r) => 'regionShare' in r && r.regionShare! >= 0.9 && r.ruins === 5 && r.holes === 3 && r.towers === 3).sort((a, b) => (b as { pathToRune: number }).pathToRune - (a as { pathToRune: number }).pathToRune);
  console.table(good.slice(0, 12));
  process.exit(0);
}

console.log('map', mapReport(landed()));

/** Run the tower assault with `soldiers` infantry (spawned next to the commander, no XP). */
function assault(soldiers: number, tanks = 0) {
  let s = landed();
  const op = structuredClone(s.op!);
  const cmd = op.units.find((u) => u.kind === 'commander')!;
  const extra = soldiers - op.units.filter((u) => u.kind === 'infantry').length;
  const tpl = op.units.find((u) => u.kind === 'infantry')!;
  for (let i = 0; i < extra + tanks; i++) {
    const kind = i < extra ? 'infantry' : 'tank';
    const base: GroundUnit = i < extra ? tpl : { ...tpl, kind: 'tank', hp: 180, maxHp: 180, baseHp: 180, damage: 11, range: 4.5, cooldown: 30, baseCooldown: 30, speed: 1.2 };
    op.units.push({ ...structuredClone(base), id: op.nextUnitId++, kind, x: cmd.x + (i % 4) * 0.7, y: cmd.y + Math.floor(i / 4) * 0.7 });
  }
  op.explored = op.explored.map(() => 1); // balance only: the army knows where the towers are
  s = { ...s, op };
  const army = () => s.op!.units.filter((u) => u.alive && u.faction === s.op!.player);
  let downAt = -1;
  const towers = () => s.op!.units.filter((u) => u.alive && u.kind === 'tower');
  // walk the army (commander at the back) to the rune area, then focus towers one by one
  let t = 0;
  let phase = 'march';
  while (t++ < 20 * 600 && !s.op!.over) {
    if (t % 20 === 1) {
      const tw = towers();
      const ids = army().filter((u) => u.kind !== 'commander').map((u) => u.id);
      if (!tw.length && downAt < 0) downAt = t;
      if (tw.length) {
        const target = tw.reduce((b, x) => (Math.hypot(x.x - cmd.x, x.y - cmd.y) < Math.hypot(b.x - cmd.x, b.y - cmd.y) ? x : b));
        if (phase === 'march') {
          s = applyCommand(s, { type: 'OP_ORDER', ids, attack: target.id });
          phase = 'fight';
        } else s = applyCommand(s, { type: 'OP_ORDER', ids, attack: target.id });
        // the commander stays at the landing zone until the towers are down
      } else {
        const c = army().find((u) => u.kind === 'commander');
        if (c) s = applyCommand(s, { type: 'OP_ORDER', ids: [c.id], move: { x: s.op!.rune.x, y: s.op!.rune.y } });
      }
    }
    s = simulateTick(s);
  }
  const op2 = s.op!;
  const alive = op2.units.filter((u) => u.alive && u.faction === op2.player);
  const vet = Math.max(0, ...alive.map((u) => u.xp ?? 0));
  return { soldiers, tanks, result: op2.over?.result ?? 'timeout', towersDownAt: downAt < 0 ? '-' : Math.round(downAt / 20), secs: Math.round(t / 20), survivors: alive.length, towersLeft: towers().length, topXp: +vet.toFixed(2) };
}

if (mode === 'all' || mode === 'balance') {
  console.table((process.env.NS ?? '3,6,8,10,12').split(',').map(Number).map((n) => assault(n)));
  console.table([assault(6, 2), assault(4, 3)]);
}

if (mode === 'all' || mode === 'economy') {
  // a sensible player: repair command + barracks, solar x3, extractor, then train soldiers until 10
  let s = landed();
  const log: string[] = [];
  const at = (n: string) => log.push(`${(s.op!.tick / 20).toFixed(0).padStart(4)}s ${n} (L ${Math.floor(s.op!.light)} D ${Math.floor(s.op!.dark)})`);
  const st = (b: string) => s.op!.structures.find((t) => t.building === b)!;
  s = applyCommand(s, { type: 'OP_REPAIR', structureId: st('command').id }); at('repair command');
  s = applyCommand(s, { type: 'OP_REPAIR', structureId: st('barracks').id }); at('repair barracks');
  // the whole map is not explored yet: reveal around the base by walking the party a bit (fog matters for placement)
  const surf = surfaceOf(s, s.colonies[s.op!.colonyId]);
  let solars = 0, extractor = false;
  let revived = false, ten = false;
  for (let t = 0; t < 20 * 900 && !ten; t++) {
    s = simulateTick(s);
    const op = s.op!;
    if (!revived && s.mission!.objectives.find((o) => o.id === 'revive')!.done) { revived = true; at('COLONY REVIVED'); }
    if (t % 20 !== 0 || st('command').state !== 'ready') continue;
    const cmd = st('command');
    const tryBuild = (b: 'solar' | 'extractor') => {
      const cells = b === 'extractor' ? op.holes.map((h) => [h.x, h.y]) : [...Array(surf.w * surf.h).keys()].map((i) => [i % surf.w, Math.floor(i / surf.w)]).sort((a, c) => Math.hypot(a[0] - cmd.x, a[1] - cmd.y) - Math.hypot(c[0] - cmd.x, c[1] - cmd.y));
      for (const [x, y] of cells) {
        const before = s.op!.structures.length;
        s = applyCommand(s, { type: 'OP_BUILD', building: b, x, y });
        if (s.op!.structures.length > before) return true;
      }
      return false;
    };
    if (!extractor && op.light >= 60) { extractor = tryBuild('extractor'); if (extractor) at('extractor'); }
    else if (solars < 4 && op.light >= 40 && op.dark >= 5) { if (tryBuild('solar')) { solars++; at(`solar ${solars}`); } }
    const bar = st('barracks');
    if (bar.state === 'ready' && bar.train.length < 2 && solars >= 2) {
      const before = bar.train.length;
      s = applyCommand(s, { type: 'OP_TRAIN', structureId: bar.id, unit: 'infantry' });
      if (s.op!.structures.find((x) => x.id === bar.id)!.train.length > before) at('train soldier');
    }
    const n = s.op!.units.filter((u) => u.alive && u.kind === 'infantry').length;
    if (n >= 10) { ten = true; at('10 SOLDIERS'); }
  }
  console.log(log.join('\n'));
  void OP_BUILDING_IDS; void BUILDINGS;
}

if (mode === 'all' || mode === 'deadend') {
  // a normal start must never be called a dead end; a spending spree into the wrong ruins must be
  const run = (label: string, plan: string[], expectStuck: boolean) => {
    let s = landed();
    for (const b of plan) {
      const t = s.op!.structures.find((x) => x.building === b && x.state === 'ruin');
      if (t) s = applyCommand(s, { type: 'OP_REPAIR', structureId: t.id });
    }
    for (let i = 0; i < 40; i++) s = simulateTick(s);
    const stuck = !!s.op!.over?.stranded;
    console.log(`${stuck === expectStuck ? 'OK  ' : 'FAIL'} ${label}: stranded=${stuck} (L ${Math.floor(s.op!.light)} D ${Math.floor(s.op!.dark)}) ${s.op!.over?.reason ?? ''}`);
    if (stuck !== expectStuck) process.exitCode = 1;
  };
  run('fresh landing', [], false);
  run('sensible repairs', ['command', 'barracks'], false);
  run('vehicle bay + barracks first (no DARK left for the Command Center)', ['vehiclebay', 'barracks', 'shelter'], true);
  run('vehicle bay + shelters (recoverable: LIGHT income, 18 DARK left)', ['vehiclebay', 'shelter', 'shelter'], false);
}

if (mode === 'all' || mode === 'paths') {
  // group orders into water, rocks and far corners: everybody must end up moving or arrived, never frozen
  let s = landed();
  const op = structuredClone(s.op!);
  op.explored = op.explored.map(() => 1);
  const tpl = op.units.find((u) => u.kind === 'infantry')!;
  for (let i = 0; i < 9; i++) op.units.push({ ...structuredClone(tpl), id: op.nextUnitId++, x: tpl.x + (i % 3) * 0.7, y: tpl.y + Math.floor(i / 3) * 0.7 });
  s = { ...s, op };
  const surf = surfaceOf(s, s.colonies[op.colonyId]);
  const spot = (k: string) => { for (let i = 0; i < surf.kinds.length; i++) if (surf.kinds[i] === k) return { x: i % surf.w, y: Math.floor(i / surf.w) }; return null; };
  const targets = [spot('liquid'), spot('rough'), { x: surf.w - 2, y: 1 }, { x: 1, y: surf.h - 2 }].filter(Boolean) as { x: number; y: number }[];
  for (const t of targets) {
    const ids = s.op!.units.filter((u) => u.alive && u.speed > 0 && u.kind !== 'commander').map((u) => u.id);
    s = applyCommand(s, { type: 'OP_ORDER', ids, move: t });
    const start = new Map(s.op!.units.map((u) => [u.id, [u.x, u.y]]));
    for (let i = 0; i < 20 * 90; i++) s = simulateTick(s);
    const frozen = s.op!.units.filter((u) => ids.includes(u.id) && u.order && !u.path.length);
    const moved = s.op!.units.filter((u) => ids.includes(u.id) && Math.hypot(u.x - start.get(u.id)![0], u.y - start.get(u.id)![1]) > 1).length;
    const dists = s.op!.units.filter((u) => u.alive && ids.includes(u.id)).map((u) => +Math.hypot(u.x - t.x, u.y - t.y).toFixed(1)); const spread = Math.max(...dists); console.log('   alive dists', dists.join(' '), 'targets', s.op!.units.filter((u) => u.alive && ids.includes(u.id)).map((u) => u.target ?? '-').join(' '));
    console.log(`${frozen.length ? 'FAIL' : 'OK  '} move to ${surf.kinds[t.y * surf.w + t.x]} (${t.x},${t.y}): moved ${moved}/${ids.length}, still-ordered-but-pathless ${frozen.length}, farthest ${spread.toFixed(1)} cells`);
  }
}
