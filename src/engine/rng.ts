// mulberry32: tiny deterministic PRNG. Returns [value in 0..1, next state].
export function nextRandom(state: number): [number, number] {
  const s = (state + 0x6d2b79f5) | 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return [value, s];
}

/** Convenience generator for one-off deterministic work (e.g. galaxy generation from a seed). */
export function makeRng(seed: number) {
  let s = seed | 0;
  const rand = () => {
    const [v, n] = nextRandom(s);
    s = n;
    return v;
  };
  return {
    rand,
    int: (min: number, max: number) => min + Math.floor(rand() * (max - min + 1)),
    pick: <T>(arr: readonly T[]) => arr[Math.floor(rand() * arr.length)],
    gauss: () => {
      const u = Math.max(rand(), 1e-9);
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
    },
    weighted: <T extends string>(table: Record<T, number>): T => {
      const entries = Object.entries(table) as [T, number][];
      let r = rand() * entries.reduce((a, [, w]) => a + w, 0);
      for (const [k, w] of entries) if ((r -= w) <= 0) return k;
      return entries[entries.length - 1][0];
    },
  };
}
