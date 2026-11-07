import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { createNebula, createStarfield } from './starfield.ts';
import type { View } from './View.ts';

const CLICK_SLOP_PX = 5;
const FLY_S = 0.9;

interface Fly {
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  fromCam: THREE.Vector3;
  toCam: THREE.Vector3;
  start: number;
  seconds: number;
}

/**
 * Shared Three.js host: renderer, bloom, camera, orbit controls, space backdrop, HTML labels.
 * Views are swapped in and out; the Stage never knows about game rules.
 */
export class Stage {
  readonly camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
  private renderer: THREE.WebGLRenderer;
  private labels = new CSS2DRenderer();
  private scene = new THREE.Scene();
  readonly controls: OrbitControls;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private clock = new THREE.Clock();
  private backdrop: THREE.ShaderMaterial[] = [];
  private backdropObjects: THREE.Object3D[] = [];
  private view: View | null = null;
  private ray = new THREE.Raycaster();
  private fly: Fly | null = null;
  private down: { x: number; y: number; button: number } | null = null;
  private canvas: HTMLCanvasElement;
  private detach: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement, labelHost: HTMLElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.localClippingEnabled = true;

    this.labels.domElement.className = 'label-layer';
    labelHost.appendChild(this.labels.domElement);

    // One camera scheme for every view, modelled on Beyond All Reason's defaults:
    // left = select, right = orders, middle-drag = pan, wheel = zoom (toward the cursor),
    // Alt + middle/left-drag = rotate, Ctrl + wheel = tilt, arrows/WASD = pan, Alt+arrows = rotate, PgUp/PgDn = zoom.
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.screenSpacePanning = false; // middle-drag slides across the ground, map-style
    this.controls.zoomToCursor = true;
    this.applyMouseButtons(false);
    this.controls.addEventListener('start', () => {
      this.controls.autoRotate = false;
      this.fly = null;
    });

    // Soft studio reflections for metal (ship models, sandbox cubes). Unlit shader materials ignore it.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();

    const nebula = createNebula();
    const stars = createStarfield();
    this.backdrop.push(nebula.material as THREE.ShaderMaterial, stars.material as THREE.ShaderMaterial);
    this.backdropObjects.push(nebula, stars);
    this.scene.add(nebula, stars);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.9, 0.55, 0.82);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    canvas.addEventListener('wheel', this.onWheel, { capture: true, passive: false });
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('contextmenu', this.onContext);
  }

  private onContext = (e: Event) => e.preventDefault();

  private keys = new Set<string>();

  private applyMouseButtons(rotate: boolean) {
    const NONE = null as unknown as THREE.MOUSE;
    this.controls.mouseButtons = rotate
      ? { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: NONE }
      : { LEFT: NONE, MIDDLE: THREE.MOUSE.PAN, RIGHT: NONE };
  }

  private typing = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if (this.typing(e)) return;
    if (e.key === 'Alt') {
      e.preventDefault(); // keep browsers from focusing their menu bar
      this.applyMouseButtons(true);
    }
    this.keys.add(e.key.length === 1 ? e.key.toLowerCase() : e.key);
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown'].includes(e.key)) e.preventDefault();
  };

  private onKeyUp = (e: KeyboardEvent) => {
    if (e.key === 'Alt') {
      e.preventDefault();
      this.applyMouseButtons(false);
    }
    this.keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key);
  };

  private onBlur = () => {
    this.keys.clear();
    this.applyMouseButtons(false);
  };

  /** Ctrl + wheel tilts (and must not zoom the browser page). */
  private onWheel = (e: WheelEvent) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.orbitBy(0, Math.sign(e.deltaY) * 0.06);
  };

  /** Rotate (azimuth) / tilt (polar) the camera around the orbit target. */
  private orbitBy(dAzimuth: number, dPolar: number) {
    const offset = this.camera.position.clone().sub(this.controls.target);
    const sph = new THREE.Spherical().setFromVector3(offset);
    sph.theta += dAzimuth;
    sph.phi = Math.min(this.controls.maxPolarAngle, Math.max(0.12, sph.phi + dPolar));
    offset.setFromSpherical(sph);
    this.camera.position.copy(this.controls.target).add(offset);
    this.fly = null;
    this.controls.autoRotate = false;
  }

  /** Keyboard camera: arrows/WASD pan, Alt+arrows rotate, PgUp/PgDn zoom. */
  private keyboardCamera(dt: number) {
    const k = this.keys;
    const right = (k.has('ArrowRight') || k.has('d') ? 1 : 0) - (k.has('ArrowLeft') || k.has('a') ? 1 : 0);
    const fwd = (k.has('ArrowUp') || k.has('w') ? 1 : 0) - (k.has('ArrowDown') || k.has('s') ? 1 : 0);
    const zoom = (k.has('PageDown') ? 1 : 0) - (k.has('PageUp') ? 1 : 0);
    if (k.has('Control') || k.has('Meta')) return; // Ctrl+A etc. belong to the views
    if (k.has('Alt')) {
      if (right || fwd) this.orbitBy(-right * dt * 1.6, -fwd * dt * 1.0);
    } else if (right || fwd) {
      const dist = this.camera.position.distanceTo(this.controls.target);
      const f = new THREE.Vector3().subVectors(this.controls.target, this.camera.position).setY(0).normalize();
      const r = new THREE.Vector3(-f.z, 0, f.x);
      const move = r.multiplyScalar(right).addScaledVector(f, fwd).multiplyScalar(dist * 0.9 * dt);
      this.controls.target.add(move);
      this.camera.position.add(move);
      this.fly = null;
    }
    if (zoom) {
      const offset = this.camera.position.clone().sub(this.controls.target);
      const len = Math.min(this.controls.maxDistance, Math.max(this.controls.minDistance, offset.length() * (1 + zoom * dt * 1.5)));
      this.camera.position.copy(this.controls.target).add(offset.setLength(len));
    }
  }

  setView(view: View | null) {
    if (this.view) {
      this.detach?.();
      this.detach = null;
      this.scene.remove(this.view.root);
      this.view.dispose();
    }
    this.view = view;
    this.fly = null;
    this.scene.fog = null;
    this.bloom.strength = 0.9;
    for (const o of this.backdropObjects) o.visible = true;
    if (!view) return;
    this.scene.add(view.root);
    this.detach = view.attach?.(this.canvas, this.camera) ?? null;
    this.scene.fog = view.fog ?? null;
    this.bloom.strength = view.bloom ?? 0.9;
    for (const o of this.backdropObjects) o.visible = view.backdrop !== false;
    const p = view.preset;
    this.camera.position.set(...p.position);
    this.controls.target.set(...p.target);
    this.controls.minDistance = p.minDistance;
    this.controls.maxDistance = p.maxDistance;
    this.controls.maxPolarAngle = p.maxPolarAngle;
    this.controls.autoRotateSpeed = p.autoRotateSpeed;
    this.controls.autoRotate = p.autoRotateSpeed > 0;
    this.controls.update();
    if (view.intro) {
      const to = this.camera.position.clone();
      this.fly = {
        fromTarget: this.controls.target.clone(), toTarget: this.controls.target.clone(),
        fromCam: new THREE.Vector3(...view.intro.from), toCam: to,
        start: this.clock.getElapsedTime(), seconds: view.intro.seconds,
      };
      this.camera.position.copy(this.fly.fromCam);
    }
  }

  /** Smoothly move the orbit target to `point`, optionally to a given viewing distance. */
  flyTo(point: THREE.Vector3, distance?: number) {
    const offset = this.camera.position.clone().sub(this.controls.target);
    if (distance) offset.setLength(distance);
    this.fly = {
      fromTarget: this.controls.target.clone(),
      toTarget: point.clone(),
      fromCam: this.camera.position.clone(),
      toCam: point.clone().add(offset),
      start: this.clock.getElapsedTime(),
      seconds: FLY_S,
    };
    this.controls.autoRotate = false;
  }

  resize(w: number, h: number) {
    this.renderer.setSize(w, h, false);
    this.labels.setSize(w, h);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render() {
    const dt = this.clock.getDelta();
    const t = this.clock.getElapsedTime();
    for (const m of this.backdrop) m.uniforms.uTime.value = t;

    if (this.fly) {
      const k = Math.min(1, (t - this.fly.start) / this.fly.seconds);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      this.controls.target.lerpVectors(this.fly.fromTarget, this.fly.toTarget, e);
      this.camera.position.lerpVectors(this.fly.fromCam, this.fly.toCam, e);
      if (k >= 1) this.fly = null;
    }
    this.keyboardCamera(dt);
    this.controls.update();
    this.view?.update({ t, dt, camera: this.camera, controls: this.controls });
    this.composer.render();
    this.labels.render(this.scene, this.camera);
  }

  private setRay(e: PointerEvent) {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    return this.ray;
  }

  private onDown = (e: PointerEvent) => {
    if (e.button === 0 || e.button === 2) this.down = { x: e.clientX, y: e.clientY, button: e.button };
  };

  private onUp = (e: PointerEvent) => {
    const d = this.down;
    this.down = null;
    if (!d || e.button !== d.button) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_SLOP_PX) return;
    if (e.button === 0) this.view?.click?.(this.setRay(e));
    else this.view?.contextClick?.(this.setRay(e));
  };

  private onMove = (e: PointerEvent) => {
    if (!this.view?.hover || e.buttons) return;
    this.canvas.style.cursor = this.view.hover(this.setRay(e)) ? 'pointer' : '';
  };

  dispose() {
    this.setView(null);
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('contextmenu', this.onContext);
    this.canvas.removeEventListener('wheel', this.onWheel, { capture: true });
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.labels.domElement.remove();
    this.controls.dispose();
    this.composer.dispose();
    this.renderer.dispose();
  }
}
