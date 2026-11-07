import type { Engine } from './engine/index.ts';

/** The browser host: one rAF loop that advances the engine clock, then lets views draw. */
export function startGameLoop(engine: Engine, draw: () => void): () => void {
  let last = performance.now();
  let raf = 0;
  // performance.now() rather than the rAF timestamp: it is the clock everything else uses
  // (and the one devtools' virtual time controls, which the demo recorder relies on)
  const frame = () => {
    const now = performance.now();
    engine.advance(Math.min(now - last, 250));
    last = now;
    draw();
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}
