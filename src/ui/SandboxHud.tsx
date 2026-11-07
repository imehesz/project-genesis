import { engine, useGame, useUi } from '../store/gameStore.ts';
import { CUBE_EVERY_CREDITS } from '../engine/index.ts';
import { Stat } from './common.tsx';

/** Phase 1 state test: UI dispatches commands, the engine decides, the 3D view reacts. */
export function SandboxHud() {
  const credits = useGame((s) => s.credits);
  const turn = useGame((s) => s.turn);
  const cubes = useGame((s) => Object.keys(s.entities).length);
  const go = useUi((s) => s.go);
  const toNext = CUBE_EVERY_CREDITS - (credits % CUBE_EVERY_CREDITS);

  return (
    <div className="hud">
      <header className="hud-top">
        <button className="hud-back" onClick={() => go({ name: 'menu' })}>
          ◂ Menu
        </button>
        <div className="hud-stats">
          <Stat label="Credits" value={credits.toLocaleString()} accent />
          <Stat label="Turn" value={turn} />
          <Stat label="Structures" value={cubes} />
        </div>
      </header>

      <aside className="panel hud-panel">
        <div className="panel-title">Engine sandbox</div>
        <p className="panel-text">
          A structure is built every {CUBE_EVERY_CREDITS} credits.{' '}
          <strong>{toNext}</strong> to the next one.
        </p>
        <div className="progress">
          <div style={{ width: `${((CUBE_EVERY_CREDITS - toNext) / CUBE_EVERY_CREDITS) * 100}%` }} />
        </div>
        <div className="panel-row">
          <button className="btn btn-primary" onClick={() => engine.dispatch({ type: 'ADD_CREDITS', amount: 1 })}>
            +1 Credit
          </button>
          <button className="btn" onClick={() => engine.dispatch({ type: 'ADD_CREDITS', amount: 10 })}>
            +10
          </button>
        </div>
        <button className="btn btn-ghost" onClick={() => engine.dispatch({ type: 'END_TURN' })}>
          End turn ▸
        </button>
        <div className="panel-hint">Drag to orbit · scroll to zoom · right-drag to pan</div>
      </aside>
    </div>
  );
}

