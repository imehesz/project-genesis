import type { PlanetType } from './types.ts';
import { makeRng } from './rng.ts';

/** land = buildable; rough = mountains/mesas/craters; liquid = seas, lava, frozen crevasses. */
export type CellKind = 'land' | 'rough' | 'liquid';

export interface Surface {
  w: number;
  h: number;
  /** Row-major (y * w + x). Terrain height of each cell, for rendering and (later) ground battles. */
  heights: number[];
  kinds: CellKind[];
}

const LIQUID: Record<PlanetType, number> = { terran: 0.28, ocean: 0.55, desert: 0, volcanic: 0.2, ice: 0.15, barren: 0, gas: 0 };
const ROUGH: Record<PlanetType, number> = { terran: 0.2, ocean: 0.15, desert: 0.3, volcanic: 0.3, ice: 0.25, barren: 0.35, gas: 0 };

/** Map scale knob: side length in cells = SURFACE_SCALE * (5 + planet size). 2 => 12..20 cells. */
export const SURFACE_SCALE = 2;
export const surfaceSide = (planetSize: number) => Math.round(SURFACE_SCALE * (5 + planetSize));

const cache = new Map<string, Surface>();

/** Deterministic surface map of one planet: same galaxy seed + planet = same terrain, everywhere. */
export function planetSurface(seed: number, systemId: number, planetId: number, type: PlanetType, size: number, side?: number): Surface {
  const key = `${seed}:${systemId}:${planetId}:${side ?? ''}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const r = makeRng((seed ^ Math.imul(systemId + 1, 73856093) ^ Math.imul(planetId + 1, 19349663)) | 0);
  const w = side ?? surfaceSide(size), h = w;
  // feature size grows with the map, so big maps get big lakes and ridges, not just more noise
  const elev = noiseField(r, w, h, Math.max(3, w / 4));
  const rough = noiseField(r, w, h, Math.max(2, w / 6));

  // raise the middle so colonies start inland, liquid gathers toward the edges
  const cx = (w - 1) / 2, cy = (h - 1) / 2, maxD = Math.hypot(cx, cy);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) elev[y * w + x] += 0.35 * (1 - Math.hypot(x - cx, y - cy) / maxD);

  const n = w * h;
  const liquidCut = quantile(elev, LIQUID[type]);
  const kinds: CellKind[] = new Array(n);
  const dry: number[] = [];
  for (let i = 0; i < n; i++) {
    kinds[i] = LIQUID[type] > 0 && elev[i] < liquidCut ? 'liquid' : 'land';
    if (kinds[i] === 'land') dry.push(rough[i]);
  }
  const roughCut = quantile(dry, 1 - ROUGH[type]);
  for (let i = 0; i < n; i++) if (kinds[i] === 'land' && rough[i] > roughCut) kinds[i] = 'rough';

  const heights = kinds.map((k, i) => (k === 'liquid' ? -0.6 : k === 'land' ? 0.4 + elev[i] * 0.3 : 1.4 + (rough[i] - roughCut) * 9));
  const s = { w, h, heights, kinds };
  cache.set(key, s);
  return s;
}

/** Smooth value noise: a coarse random lattice, bilinearly sampled, plus a finer octave. */
function noiseField(r: ReturnType<typeof makeRng>, w: number, h: number, cell: number): number[] {
  const octave = (step: number, amp: number) => {
    const gw = Math.ceil(w / step) + 2, gh = Math.ceil(h / step) + 2;
    const g = Array.from({ length: gw * gh }, () => r.rand());
    return (x: number, y: number) => {
      const fx = x / step, fy = y / step;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = smooth(fx - x0), ty = smooth(fy - y0);
      const v = (i: number, j: number) => g[j * gw + i];
      const a = v(x0, y0) + (v(x0 + 1, y0) - v(x0, y0)) * tx;
      const b = v(x0, y0 + 1) + (v(x0 + 1, y0 + 1) - v(x0, y0 + 1)) * tx;
      return (a + (b - a) * ty) * amp;
    };
  };
  const o1 = octave(cell, 1), o2 = octave(Math.max(1, cell / 2), 0.45);
  const out: number[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.push(o1(x, y) + o2(x, y));
  return out;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

function quantile(values: number[], q: number): number {
  if (!values.length || q <= 0) return -Infinity;
  if (q >= 1) return Infinity;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}
