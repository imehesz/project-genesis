import type * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';


export interface CameraPreset {
  position: [number, number, number];
  target: [number, number, number];
  minDistance: number;
  maxDistance: number;
  maxPolarAngle: number;
  autoRotateSpeed: number;
}

export interface FrameContext {
  t: number;
  dt: number;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
}

/** One 3D scene (sandbox, galaxy, later: space battle, ground battle) mounted on the shared Stage. */
export interface View {
  root: THREE.Object3D;
  preset: CameraPreset;
  update(ctx: FrameContext): void;
  /** Click on the canvas (not a drag). Return true if the view used it. */
  click?(ray: THREE.Raycaster): void;
  /** Right-click on the canvas (not a pan drag). */
  contextClick?(ray: THREE.Raycaster): void;
  /** Pointer moved; return true if something clickable is under it (for the cursor). */
  hover?(ray: THREE.Raycaster): boolean;
  dispose(): void;
  /** Camera swoops from here to the preset when the view opens (e.g. landing on a planet). */
  intro?: { from: [number, number, number]; seconds: number };
  /** false hides the shared space backdrop (nebula + stars), e.g. under a planet sky. */
  backdrop?: boolean;
  fog?: THREE.Fog | THREE.FogExp2 | null;
  /** Bloom strength for this view (default 0.9: space glows, daylight scenes want less). */
  bloom?: number;
  /** Raw canvas access for views with their own pointer handling (e.g. drag-box selection). Returns a detach fn. */
  attach?(canvas: HTMLCanvasElement, camera: THREE.PerspectiveCamera): () => void;
}
