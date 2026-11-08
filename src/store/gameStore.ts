import { create } from 'zustand';
import { createEngine, type BuildingId, type GameState } from '../engine/index.ts';

/** The single engine instance for this browser tab. In Phase 2 this becomes a network client. */
export const engine = createEngine();

/**
 * Read-only mirror of the engine state for React. React never writes here:
 * it calls engine.dispatch(command) and the mirror updates itself.
 */
export const useGame = create<GameState>(() => engine.getState());
engine.subscribe((s) => useGame.setState(s, true));

/** UI-only state (which screen is showing). Not game logic, never synced to a server. */
export type Screen =
  | { name: 'menu' }
  | { name: 'cutscene'; id: string; then: Screen }
  | { name: 'sandbox' }
  | { name: 'galaxy' }
  | { name: 'colony'; colonyId: string }
  | { name: 'surface'; colonyId: string }
  | { name: 'battle' }
  | { name: 'ground' }
  | { name: 'research' }
  // story campaign: the star system (turn-based) and a planet mission (real time)
  | { name: 'system' }
  | { name: 'op' };

interface UiState {
  screen: Screen;
  musicOn: boolean;
  /** Star system highlighted on the galaxy map. */
  selectedSystem: number | null;
  select: (id: number | null) => void;
  /** Fleet highlighted on the galaxy map (receives move orders). */
  selectedFleet: number | null;
  selectFleet: (id: number | null) => void;
  /** Surface view: building being placed, and the selected structure. */
  placing: BuildingId | null;
  setPlacing: (b: BuildingId | null) => void;
  selectedStructure: number | null;
  selectStructure: (id: number | null) => void;
  /** Space battle: selected unit, and whether the view is still animating. */
  battleUnit: number | null;
  selectBattleUnit: (uid: number | null) => void;
  battleBusy: boolean;
  /** Bumped to make the battle view skip its current animation. */
  battleSkip: number;
  /** Ground battle: selected unit ids. */
  groundSelection: number[];
  /** Campaign: planet highlighted in the star system. */
  selectedPlanet: number | null;
  /** Planet mission: building being placed, selected structure. */
  opPlacing: BuildingId | null;
  opStructure: number | null;
  /** The game right before the last landing, so a lost mission can be retried from there. */
  landingSnapshot: GameState | null;
  go: (screen: Screen) => void;
  toggleMusic: () => void;
}

export const useUi = create<UiState>((set) => ({
  screen: { name: 'menu' },
  musicOn: true,
  selectedSystem: null,
  select: (selectedSystem) => set({ selectedSystem }),
  selectedFleet: null,
  selectFleet: (selectedFleet) => set({ selectedFleet }),
  placing: null,
  setPlacing: (placing) => set({ placing, selectedStructure: null }),
  selectedStructure: null,
  selectStructure: (selectedStructure) => set({ selectedStructure }),
  battleUnit: null,
  selectBattleUnit: (battleUnit) => set({ battleUnit }),
  battleBusy: false,
  battleSkip: 0,
  groundSelection: [],
  selectedPlanet: null,
  opPlacing: null,
  opStructure: null,
  landingSnapshot: null,
  go: (screen) => set({ screen }),
  toggleMusic: () => set((s) => ({ musicOn: !s.musicOn })),
}));

/** Start the story campaign from the beginning (campaign 1: the Terran commander). */
export function startStoryCampaign() {
  engine.dispatch({ type: 'NEW_MISSION', id: 'c1' });
  useUi.setState({ selectedPlanet: null, opPlacing: null, opStructure: null, groundSelection: [], landingSnapshot: null });
}

/** Land the commander; keeps a snapshot so a lost mission can be retried from the landing. */
export function landOn(planetId: number) {
  const before = engine.getState();
  engine.dispatch({ type: 'MISSION_LAND', planetId });
  if (!engine.getState().op) return false;
  useUi.setState({ landingSnapshot: before, opPlacing: null, opStructure: null, groundSelection: [] });
  useUi.getState().go({ name: 'op' });
  return true;
}

/** Start a fresh open-galaxy game (sandbox 4X) on a brand-new random galaxy. */
export function startNewCampaign() {
  const seed = Math.floor(Math.random() * 0x7fffffff);
  engine.dispatch({ type: 'NEW_CAMPAIGN', seed, faction: 'terran' });
  useUi.setState({ selectedSystem: null, selectedFleet: null });
}
