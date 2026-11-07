import type { FactionId, Galaxy, Planet, PlanetType, StarClass, StarSystem, Vec3 } from './types.ts';
import { makeRng } from './rng.ts';
import { FACTIONS, FACTION_IDS } from './factions.ts';

export const GALAXY_RADIUS = 100;
const MIN_SEPARATION = 7.5;

const STAR_WEIGHTS: Record<StarClass, number> = { M: 30, K: 22, G: 17, F: 12, A: 9, B: 6, O: 4 };

const SYL_A = ['Al', 'Ve', 'Kor', 'Tha', 'Ze', 'Or', 'Myr', 'Cal', 'Dra', 'Is', 'Ny', 'Sel', 'Vor', 'Ka', 'Eth', 'Ryn', 'Qua', 'Lu', 'Ar', 'Tes', 'Hal', 'Xe', 'Oph', 'Bel'];
const SYL_B = ['ra', 'ni', 'the', 'lo', 'ria', 'vi', 'dan', 'tor', 'mi', 'sa', 'ne', 'ro', 'li', 'ka', 'gen', 'phi', 'ru', 'des', 'ty', 'lis'];
const SYL_C = ['', '', '', 'x', 'n', 's', 'th', 'is', 'on', 'ar', 'us', 'ae', 'ion', 'ex'];
const SUFFIX = ['', '', '', '', '', ' Prime', ' Major', ' Minor', ' Reach', ' Gate'];
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

/** Fully deterministic: the same seed always produces the same galaxy. */
export function generateGalaxy(seed: number): Galaxy {
  const r = makeRng(seed);
  const arms = r.int(2, 4);
  const twist = 2.4 + r.rand() * 1.8;
  const rotation = r.rand() * Math.PI * 2;
  const target = r.int(65, 85);

  // --- positions along spiral arms, with rejection for spacing ---
  const positions: Vec3[] = [];
  for (let attempt = 0; attempt < 8000 && positions.length < target; attempt++) {
    const t = 0.14 + 0.86 * Math.sqrt(r.rand());
    const radius = t * GALAXY_RADIUS;
    const arm = r.int(0, arms - 1);
    const theta = rotation + (arm / arms) * Math.PI * 2 + t * twist + r.gauss() * 0.32 * (1.15 - t * 0.5);
    const p = {
      x: Math.cos(theta) * radius,
      y: r.gauss() * 2.2 * (1.1 - t),
      z: Math.sin(theta) * radius,
    };
    if (positions.every((q) => dist(p, q) >= MIN_SEPARATION)) positions.push(p);
  }

  // --- names + contents ---
  const used = new Set<string>();
  const systems: StarSystem[] = positions.map((pos, i) => {
    const name = uniqueName(r, used);
    const star = r.weighted(STAR_WEIGHTS);
    return { id: i, name, pos, star, planets: makePlanets(r, name, star), owner: null };
  });

  placeHomeworlds(r, systems);
  return { seed, arms, twist, rotation, radius: GALAXY_RADIUS, systems };
}

function makePlanets(r: ReturnType<typeof makeRng>, systemName: string, star: StarClass): Planet[] {
  const max = star === 'O' || star === 'B' ? 3 : star === 'M' ? 4 : 6;
  const count = r.int(star === 'M' ? 0 : 1, max);
  const planets: Planet[] = [];
  for (let orbit = 0; orbit < count; orbit++) {
    const zone = orbit / Math.max(1, max - 1); // 0 inner .. 1 outer
    const type: PlanetType =
      zone < 0.25
        ? r.weighted({ volcanic: 4, barren: 4, desert: 2 } as Record<PlanetType, number>)
        : zone < 0.6
          ? r.weighted({ terran: 3, ocean: 3, desert: 3, barren: 1 } as Record<PlanetType, number>)
          : r.weighted({ gas: 5, ice: 4, barren: 1 } as Record<PlanetType, number>);
    planets.push({
      id: orbit,
      name: `${systemName} ${ROMAN[orbit]}`,
      type,
      size: type === 'gas' ? r.int(4, 5) : r.int(1, 4),
      colony: null,
    });
  }
  return planets;
}

/** Spread the three faction homes far apart in the outer half of the galaxy. */
function placeHomeworlds(r: ReturnType<typeof makeRng>, systems: StarSystem[]) {
  const outer = systems.filter((s) => Math.hypot(s.pos.x, s.pos.z) > GALAXY_RADIUS * 0.45);
  const pool = outer.length >= FACTION_IDS.length ? outer : systems;
  let best: StarSystem[] = [];
  let bestScore = -1;
  for (let i = 0; i < 400; i++) {
    const pick = FACTION_IDS.map(() => r.pick(pool));
    if (new Set(pick).size < pick.length) continue;
    let score = Infinity;
    for (let a = 0; a < pick.length; a++)
      for (let b = a + 1; b < pick.length; b++) score = Math.min(score, dist(pick[a].pos, pick[b].pos));
    if (score > bestScore) [best, bestScore] = [pick, score];
  }
  best.forEach((sys, i) => makeHome(r, sys, FACTION_IDS[i]));
}

function makeHome(r: ReturnType<typeof makeRng>, sys: StarSystem, faction: FactionId) {
  const def = FACTIONS[faction];
  sys.star = 'G';
  while (sys.planets.length < 3) {
    const orbit = sys.planets.length;
    sys.planets.push({ id: orbit, name: `${sys.name} ${ROMAN[orbit]}`, type: orbit === 0 ? 'barren' : 'gas', size: r.int(2, 4), colony: null });
  }
  const home = sys.planets[Math.min(2, sys.planets.length - 1)];
  home.type = def.homeType;
  home.size = 4;
  home.name = def.homeworldName;
  home.colony = { faction, homeworld: true };
  sys.owner = faction;
}

function uniqueName(r: ReturnType<typeof makeRng>, used: Set<string>): string {
  for (let i = 0; i < 50; i++) {
    const n = r.pick(SYL_A) + r.pick(SYL_B) + r.pick(SYL_C) + r.pick(SUFFIX);
    if (!used.has(n)) {
      used.add(n);
      return n;
    }
  }
  const n = `${r.pick(SYL_A)}${r.pick(SYL_B)}-${used.size}`;
  used.add(n);
  return n;
}

const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
