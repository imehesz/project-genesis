import type { Engine } from './engine/index.ts';

/** The browser host: one rAF loop that advances the engine clock, then lets views draw. */
export function startGameLoop(engine: Engine, draw: () => void): () => void {
  let last = performance.now();
  let raf = 0;
  const frame = (now: number) => {
    engine.advance(Math.min(now - last, 250));
    last = now;
    draw();
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}
