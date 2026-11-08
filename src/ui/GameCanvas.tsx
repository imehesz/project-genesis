import { useEffect, useRef } from 'react';
import { engine, useGame, useUi } from '../store/gameStore.ts';
import { Stage } from '../render/Stage.ts';
import { SandboxView } from '../render/views/SandboxView.ts';
import { GalaxyView, type GalaxyLink } from '../render/views/GalaxyView.ts';
import { PlanetView, type SurfaceLink } from '../render/views/PlanetView.ts';
import { SpaceBattleView, type BattleLink } from '../render/views/SpaceBattleView.ts';
import { GroundBattleView, type GroundLink } from '../render/views/GroundBattleView.ts';
import { OpView } from '../render/views/OpView.ts';
import { SystemView, type SystemLink } from '../render/views/SystemView.ts';
import { stageRef as stageRefShared } from '../render/stageRef.ts';
import { opBuildBlocker } from '../engine/index.ts';
import { startGameLoop } from '../loop.ts';

export type ViewName = 'sandbox' | 'galaxy' | 'surface' | 'battle' | 'ground' | 'system' | 'op' | null;

function surfaceLink(colonyId: string): SurfaceLink {
  const ui = () => useUi.getState();
  return {
    colonyId,
    getPlacing: () => ui().placing,
    setPlacing: (b) => ui().setPlacing(b),
    place: (building, x, y) => {
      engine.dispatch({ type: 'QUEUE_BUILDING', colonyId, building, at: { x, y } });
      ui().setPlacing(null);
    },
    getStructure: () => ui().selectedStructure,
    setStructure: (id) => ui().selectStructure(id),
    subscribe: (fn) =>
      useUi.subscribe((s, prev) => {
        if (s.placing !== prev.placing || s.selectedStructure !== prev.selectedStructure) fn();
      }),
  };
}

function battleLink(): BattleLink {
  const ui = () => useUi.getState();
  return {
    player: engine.getState().campaign!.playerFaction,
    getSelected: () => ui().battleUnit,
    setSelected: (uid) => ui().selectBattleUnit(uid),
    move: (uid, x, y) => engine.dispatch({ type: 'BATTLE_MOVE', uid, x, y }),
    fire: (uid, target) => engine.dispatch({ type: 'BATTLE_FIRE', uid, target }),
    subscribe: (fn) => useUi.subscribe((s, prev) => { if (s.battleUnit !== prev.battleUnit || s.battleBusy !== prev.battleBusy) fn(); }),
    setBusy: (battleBusy) => { if (ui().battleBusy !== battleBusy) useUi.setState({ battleBusy }); },
    onSkip: (fn) => useUi.subscribe((s, prev) => { if (s.battleSkip !== prev.battleSkip) fn(); }),
  };
}

function groundLink(): GroundLink {
  const ui = () => useUi.getState();
  return {
    player: engine.getState().campaign!.playerFaction,
    getSelection: () => ui().groundSelection,
    setSelection: (groundSelection) => useUi.setState({ groundSelection }),
    move: (ids, x, y) => engine.dispatch({ type: 'GROUND_ORDER', ids, move: { x, y } }),
    attack: (ids, target) => engine.dispatch({ type: 'GROUND_ORDER', ids, attack: target }),
    subscribe: (fn) => useUi.subscribe((s, prev) => { if (s.groundSelection !== prev.groundSelection) fn(); }),
  };
}

function systemLink(): SystemLink {
  const ui = () => useUi.getState();
  return {
    getPlanet: () => ui().selectedPlanet,
    setPlanet: (selectedPlanet) => useUi.setState({ selectedPlanet }),
    subscribe: (fn) => useUi.subscribe((s, prev) => { if (s.selectedPlanet !== prev.selectedPlanet) fn(); }),
    moveShip: (planetId) => engine.dispatch({ type: 'MISSION_SHIP_MOVE', planetId }),
  };
}

function opGroundLink(): GroundLink {
  const ui = () => useUi.getState();
  return {
    player: engine.getState().campaign!.playerFaction,
    getSelection: () => ui().groundSelection,
    setSelection: (groundSelection) => useUi.setState({ groundSelection }),
    move: (ids, x, y) => engine.dispatch({ type: 'OP_ORDER', ids, move: { x, y } }),
    attack: (ids, target) => engine.dispatch({ type: 'OP_ORDER', ids, attack: target }),
    subscribe: (fn) => useUi.subscribe((s, prev) => { if (s.groundSelection !== prev.groundSelection) fn(); }),
  };
}

function opSurfaceLink(colonyId: string): SurfaceLink {
  const ui = () => useUi.getState();
  return {
    colonyId,
    getPlacing: () => ui().opPlacing,
    setPlacing: (opPlacing) => useUi.setState({ opPlacing }),
    place: (building, x, y) => {
      engine.dispatch({ type: 'OP_BUILD', building, x, y });
      useUi.setState({ opPlacing: null });
    },
    getStructure: () => ui().opStructure,
    setStructure: (opStructure) => useUi.setState({ opStructure }),
    subscribe: (fn) => useUi.subscribe((s, prev) => { if (s.opPlacing !== prev.opPlacing || s.opStructure !== prev.opStructure) fn(); }),
    blocker: (b, x, y) => opBuildBlocker(engine.getState(), b, x, y),
    stableDressing: true,
  };
}

function galaxyLink(): GalaxyLink {
  const ui = () => useUi.getState();
  return {
    player: engine.getState().campaign!.playerFaction,
    getSystem: () => ui().selectedSystem,
    setSystem: (id) => ui().select(id),
    getFleet: () => ui().selectedFleet,
    setFleet: (id) => ui().selectFleet(id),
    subscribe: (fn) =>
      useUi.subscribe((s, prev) => {
        const ch: Parameters<typeof fn>[0] = {};
        if (s.selectedSystem !== prev.selectedSystem) ch.system = s.selectedSystem;
        if (s.selectedFleet !== prev.selectedFleet) ch.fleet = s.selectedFleet;
        if ('system' in ch || 'fleet' in ch) fn(ch);
      }),
    moveOrder: (fleetId, to) => engine.dispatch({ type: 'MOVE_FLEET', fleetId, to }),
  };
}

/** Full-screen Three.js canvas behind the React UI. Draws only while a view is mounted. */
export function GameCanvas({ view, colonyId }: { view: ViewName; colonyId?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Stage | null>(null);
  const activeRef = useRef(false);
  activeRef.current = view !== null;
  const galaxySeed = useGame((s) => s.galaxy?.seed ?? null);
  // a new battle (different system or turn) rebuilds the battle scene
  const groundKey = useGame((s) => (s.ground ? `${s.ground.colonyId}:${s.turn}` : null));
  const battleKey = useGame((s) => (s.battle ? `${s.battle.systemId}:${s.turn}:${s.battle.sides.join()}` : null));
  // a new landing (or a retry) rebuilds the mission scene
  const opKey = useGame((s) => (s.op ? s.op.colonyId : null));
  const missionKey = useGame((s) => (s.mission ? s.mission.id : null));

  useEffect(() => {
    const stage = new Stage(canvasRef.current!, labelRef.current!);
    stageRef.current = stage;
    stageRefShared.current = stage;
    if (import.meta.env.DEV) Object.assign(((window as unknown as Record<string, object>).__pg ??= {}), { stage });
    const fit = () => stage.resize(window.innerWidth, window.innerHeight);
    fit();
    window.addEventListener('resize', fit);
    const stop = startGameLoop(engine, () => {
      if (activeRef.current) stage.render();
    });
    return () => {
      stop();
      window.removeEventListener('resize', fit);
      stage.dispose();
      stageRef.current = null;
      stageRefShared.current = null;
    };
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const galaxy = engine.getState().galaxy;
    if (view === 'sandbox') stage.setView(new SandboxView(engine));
    else if (view === 'galaxy' && galaxy) stage.setView(new GalaxyView(engine, galaxyLink(), (p, d) => stage.flyTo(p, d)));
    else if (view === 'ground' && engine.getState().ground) stage.setView(new GroundBattleView(engine, groundLink()));
    else if (view === 'battle' && engine.getState().battle) stage.setView(new SpaceBattleView(engine, battleLink()));
    else if (view === 'system' && engine.getState().mission) stage.setView(new SystemView(engine, systemLink()));
    else if (view === 'op' && engine.getState().op) stage.setView(new OpView(engine, opGroundLink(), opSurfaceLink(engine.getState().op!.colonyId), (structureId, at) => engine.dispatch({ type: 'OP_RALLY', structureId, at })));
    else if (view === 'surface' && colonyId && engine.getState().colonies[colonyId]) stage.setView(new PlanetView(engine, surfaceLink(colonyId)));
    else stage.setView(null);
  }, [view, galaxySeed, colonyId, view === 'battle' ? battleKey : view === 'ground' ? groundKey : view === 'op' ? opKey : view === 'system' ? missionKey : null]);

  return (
    <>
      <canvas ref={canvasRef} className={`game-canvas ${view ? 'is-active' : ''}`} />
      <div ref={labelRef} className="label-host" />
    </>
  );
}
