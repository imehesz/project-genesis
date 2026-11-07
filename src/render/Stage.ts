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
  private controls: OrbitControls;
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

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
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

    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('contextmenu', this.onContext);
  }

  private onContext = (e: Event) => e.preventDefault();

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
    this.controls.mouseButtons = view.controlScheme === 'rts'
      ? { LEFT: null as unknown as THREE.MOUSE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN }
      : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
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
    this.labels.domElement.remove();
    this.controls.dispose();
    this.composer.dispose();
    this.renderer.dispose();
  }
}
