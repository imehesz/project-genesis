import type { Colony, GameState } from './types.ts';
import { footprint, type BuildingId } from './data/buildings.ts';
import { planetSurface, type Surface } from './surface.ts';

export function surfaceOf(state: GameState, c: Colony): Surface {
  const p = state.galaxy!.systems[c.systemId].planets[c.planetId];
  return planetSurface(state.galaxy!.seed, c.systemId, c.planetId, p.type, p.size, p.mapSide);
}

export const buildingCount = (c: Colony, b: BuildingId) => c.structures.reduce((n, s) => n + (s.building === b ? 1 : 0), 0);

/** Per cell: a structure id, 'site' for queued construction, or null if free. */
export function occupancy(state: GameState, c: Colony): (number | 'site' | null)[] {
  const s = surfaceOf(state, c);
  const grid: (number | 'site' | null)[] = new Array(s.w * s.h).fill(null);
  const mark = (b: BuildingId, x: number, y: number, v: number | 'site') => {
    const f = footprint(b);
    for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) grid[(y + dy) * s.w + x + dx] = v;
  };
  for (const st of c.structures) mark(st.building, st.x, st.y, st.id);
  for (const q of c.queue) if (q.kind === 'building') mark(q.id, q.x, q.y, 'site');
  return grid;
}

/** Why `b` can't go at (x, y), or null if it fits. */
export function placeBlocker(
  state: GameState, c: Colony, b: BuildingId, x: number, y: number,
  occ: (number | 'site' | null)[] = occupancy(state, c),
): string | null {
  const s = surfaceOf(state, c);
  const f = footprint(b);
  for (let dy = 0; dy < f; dy++)
    for (let dx = 0; dx < f; dx++) {
      const cx = x + dx, cy = y + dy;
      if (cx < 0 || cy < 0 || cx >= s.w || cy >= s.h) return 'Off the map';
      const i = cy * s.w + cx;
      if (s.kinds[i] !== 'land') return s.kinds[i] === 'liquid' ? 'Cannot build on liquid' : 'Terrain too rough';
      if (occ[i] !== null) return 'Occupied';
    }
  return null;
}

/** First spot that fits, spiralling out from the colony centre. */
export function autoPlace(state: GameState, c: Colony, b: BuildingId): { x: number; y: number } | null {
  const s = surfaceOf(state, c);
  const cx = (s.w - 1) / 2, cy = (s.h - 1) / 2;
  const cells: [number, number][] = [];
  for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) cells.push([x, y]);
  cells.sort((a, b2) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b2[0] - cx, b2[1] - cy) || a[1] - b2[1] || a[0] - b2[0]);
  const occ = occupancy(state, c);
  for (const [x, y] of cells) if (!placeBlocker(state, c, b, x, y, occ)) return { x, y };
  return null;
}

export function landStats(state: GameState, c: Colony) {
  const s = surfaceOf(state, c);
  const occ = occupancy(state, c);
  let total = 0, used = 0;
  s.kinds.forEach((k, i) => {
    if (k !== 'land') return;
    total++;
    if (occ[i] !== null) used++;
  });
  return { used, total };
}
