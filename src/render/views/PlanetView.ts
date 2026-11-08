import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import {
  BUILDINGS, footprint, occupancy, placeBlocker, surfaceOf,
  type BuildingId, type Colony, type Engine, type GameState, type PlanetType, type Surface,
} from '../../engine/index.ts';
import { loadBuildingModels, modelHeight } from '../buildingModels.ts';
import { buildScatter, disposeScatter, makeGroundMaterial, paintSplat, roadSegments, type TerrainCtx } from '../terrainDressing.ts';
import type { CameraPreset, FrameContext, View } from '../View.ts';

/** How the surface view talks to the UI: placement + selection in, orders out. */
export interface SurfaceLink {
  colonyId: string;
  getPlacing(): BuildingId | null;
  setPlacing(b: BuildingId | null): void;
  place(b: BuildingId, x: number, y: number): void;
  getStructure(): number | null;
  setStructure(id: number | null): void;
  subscribe(fn: () => void): () => void;
  /** Placement rule override (planet missions); default: the colony's placeBlocker. */
  blocker?(b: BuildingId, x: number, y: number): string | null;
  /**
   * Keep the clearing and roads from the first layout (planet missions): later buildings only remove
   * the props standing on them, instead of reshaping the scenery every time something is built.
   */
  stableDressing?: boolean;
}

export const CELL = 4;
const H = 1.6; // vertical exaggeration of engine heights
const SUB = 6; // terrain vertices per cell edge
const MARGIN = 4; // cells of scenery around the buildable grid
const FILL = 0.86; // building width as a share of its footprint

interface Look {
  land: string; land2: string; rock: string; peak: string; shore: string;
  liquid: 'water' | 'lava' | 'ice' | null; liquidA?: string; liquidB?: string;
  skyTop: string; skyHorizon: string; sun: string; ambient: string; airless?: boolean;
}

const LOOKS: Record<PlanetType, Look> = {
  terran: { land: '#4f8a45', land2: '#77a355', rock: '#6d665b', peak: '#eef2f4', shore: '#c8b98a', liquid: 'water', liquidA: '#11507a', liquidB: '#3aa0c8', skyTop: '#2a6cb3', skyHorizon: '#b5daf2', sun: '#fff1d6', ambient: '#9cc3ff' },
  ocean: { land: '#679a55', land2: '#93b86c', rock: '#5c6a62', peak: '#d4dcd9', shore: '#e3d6a6', liquid: 'water', liquidA: '#0b4777', liquidB: '#2b8ec4', skyTop: '#1d5c9b', skyHorizon: '#a4d0ea', sun: '#fff4e0', ambient: '#8fbfff' },
  desert: { land: '#c9975a', land2: '#e0b277', rock: '#9b6140', peak: '#b9784a', shore: '#c9975a', liquid: null, skyTop: '#c4773a', skyHorizon: '#f4d3a0', sun: '#ffe2b0', ambient: '#ffcf9a' },
  volcanic: { land: '#3b312d', land2: '#4c3d35', rock: '#221c1a', peak: '#5c4b42', shore: '#2a2220', liquid: 'lava', liquidA: '#ff4a12', liquidB: '#ffc43a', skyTop: '#240d0a', skyHorizon: '#a13d1c', sun: '#ffb37a', ambient: '#ff8a5a' },
  ice: { land: '#dce8ef', land2: '#c6d9e6', rock: '#87a1b4', peak: '#ffffff', shore: '#a6c5d9', liquid: 'ice', liquidA: '#4f9cc4', liquidB: '#b9e3f4', skyTop: '#4a7fae', skyHorizon: '#dbeef8', sun: '#f4f8ff', ambient: '#bcd8ff' },
  barren: { land: '#8b857c', land2: '#9d978c', rock: '#5c5750', peak: '#b3ada3', shore: '#77726a', liquid: null, skyTop: '#000000', skyHorizon: '#1c1d26', sun: '#ffffff', ambient: '#8a90a0', airless: true },
  gas: { land: '#8b857c', land2: '#9d978c', rock: '#5c5750', peak: '#b3ada3', shore: '#77726a', liquid: null, skyTop: '#000000', skyHorizon: '#1c1d26', sun: '#ffffff', ambient: '#8a90a0', airless: true },
};

interface SiteView {
  key: string;
  group: THREE.Group;
  materials: THREE.Material[];
  below: THREE.Plane;
  above: THREE.Plane;
  label: CSS2DObject;
  baseY: number;
  height: number;
}

/** A colony's surface: terrain, liquids, sky, placed buildings, construction holograms, placement ghost. */
export class PlanetView implements View {
  root = new THREE.Group();
  preset: CameraPreset;
  intro: View['intro'];
  backdrop: boolean;
  fog: THREE.Fog | null;
  bloom = 0.28;
  private surface: Surface;
  private look: Look;
  private terrain: THREE.Mesh;
  private grid: THREE.LineSegments;
  private animated: THREE.ShaderMaterial[] = [];
  private models: Partial<Record<BuildingId, THREE.Object3D>> = {};
  private structures = new Map<number, { group: THREE.Group; hit: THREE.Mesh }>();
  private sites = new Map<string, SiteView>();
  private ghost: { group: THREE.Group; mat: THREE.ShaderMaterial; building: BuildingId } | null = null;
  private ghostCell: { x: number; y: number } | null = null;
  private selection: THREE.LineLoop;
  private colony: Colony;
  private planetType: PlanetType;
  private ctx: TerrainCtx;
  private scatter: THREE.Group | null = null;
  private dressKey = '';
  private fixedDress: { roads: ReturnType<typeof roadSegments>; clearing: { x: number; y: number; r: number } | null } | null = null;
  private dressGen = 0;
  private disposables: { dispose(): void }[] = [];
  private unsubs: (() => void)[] = [];
  private disposed = false;
  private engine: Engine;
  /** For views layered on top (ground battles). */
  get terrainMesh() { return this.terrain; }
  get surfaceInfo() { return this.surface; }
  /** The scene object of a standing structure (planet missions restyle ruins). */
  structureGroup(id: number): THREE.Group | null { return this.structures.get(id)?.group ?? null; }
  /** Called after buildings are (re)synced with the colony. */
  afterSync: (() => void) | null = null;
  private link: SurfaceLink;

  constructor(engine: Engine, link: SurfaceLink) {
    this.engine = engine;
    this.link = link;
    const state = engine.getState();
    this.colony = state.colonies[link.colonyId];
    const planet = state.galaxy!.systems[this.colony.systemId].planets[this.colony.planetId];
    this.surface = surfaceOf(state, this.colony);
    this.look = LOOKS[planet.type];
    this.planetType = planet.type;
    this.ctx = { surface: this.surface, cell: CELL, heightScale: H, world: (x, y) => this.world(x, y), heightAt: (x, y) => this.heightAt(x, y) };
    const half = (this.surface.w * CELL) / 2;
    this.preset = {
      position: [0, half * 1.35 + 10, half * 1.6 + 12], target: [0, 0, 0],
      minDistance: 10, maxDistance: half * 4 + 30, maxPolarAngle: Math.PI * 0.44, autoRotateSpeed: 0,
    };
    this.intro = { from: [0, 230, 30], seconds: 2.8 };
    this.backdrop = !!this.look.airless;
    this.fog = this.look.airless ? null : new THREE.Fog(this.look.skyHorizon, half * 4 + 70, half * 12 + 220);

    this.terrain = this.track(this.makeTerrain());
    this.root.add(this.terrain);
    this.dress(state);
    if (this.look.liquid) this.root.add(this.track(this.makeLiquid()));
    if (!this.look.airless) this.root.add(this.track(this.makeSky()));
    this.grid = this.track(this.makeGrid());
    this.grid.visible = false;
    this.root.add(this.grid);
    this.addLights(half);

    this.selection = this.track(new THREE.LineLoop(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: new THREE.Color(0.6, 2.2, 2.6), depthTest: false, transparent: true }),
    ));
    this.selection.renderOrder = 5;
    this.selection.visible = false;
    this.root.add(this.selection);

    this.unsubs.push(engine.subscribe((s) => {
      const c = s.colonies[link.colonyId];
      if (c && c !== this.colony) {
        this.colony = c;
        this.syncBuildings(s);
      }
    }));
    this.unsubs.push(link.subscribe(() => this.onLinkChange()));

    loadBuildingModels().then((m) => {
      if (this.disposed) return;
      this.models = m;
      this.syncBuildings(engine.getState());
    });
  }

  private track<T extends THREE.Object3D>(obj: T): T {
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) this.disposables.push(m.geometry);
      if (m.material) this.disposables.push(...([] as THREE.Material[]).concat(m.material));
    });
    return obj;
  }

  // ------------------------------------------------------------ geometry helpers

  /** Grid cell (fractional) -> world X/Z. Cell centres sit on integers. */
  world(cx: number, cy: number) {
    return { x: (cx - (this.surface.w - 1) / 2) * CELL, z: (cy - (this.surface.h - 1) / 2) * CELL };
  }

  private cellHeight(x: number, y: number): number {
    const s = this.surface;
    const inside = x >= 0 && y >= 0 && x < s.w && y < s.h;
    const cx = Math.min(s.w - 1, Math.max(0, x)), cy = Math.min(s.h - 1, Math.max(0, y));
    const base = s.heights[cy * s.w + cx];
    if (inside) return base;
    // scenery outside the grid rises into ridges so the map has a natural edge
    const out = Math.max(Math.abs(x - cx), Math.abs(y - cy));
    return base + out * 0.9 + hash2(x, y) * 1.4;
  }

  /** Terraced interpolation: flat-ish plateaus at cell centres, slopes between. */
  heightAt(fx: number, fy: number): number {
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = terrace(fx - x0), ty = terrace(fy - y0);
    const a = this.cellHeight(x0, y0) + (this.cellHeight(x0 + 1, y0) - this.cellHeight(x0, y0)) * tx;
    const b = this.cellHeight(x0, y0 + 1) + (this.cellHeight(x0 + 1, y0 + 1) - this.cellHeight(x0, y0 + 1)) * tx;
    return (a + (b - a) * ty) * H;
  }

  private makeTerrain(): THREE.Mesh {
    const s = this.surface;
    const cellsX = s.w + MARGIN * 2, cellsY = s.h + MARGIN * 2;
    const nx = cellsX * SUB + 1, ny = cellsY * SUB + 1;
    const pos = new Float32Array(nx * ny * 3);
    const col = new Float32Array(nx * ny * 3);
    const L = this.look;
    const cLand = new THREE.Color(L.land), cLand2 = new THREE.Color(L.land2), cRock = new THREE.Color(L.rock);
    const cPeak = new THREE.Color(L.peak), cShore = new THREE.Color(L.shore);
    const c = new THREE.Color();
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const fx = i / SUB - MARGIN - 0.5, fy = j / SUB - MARGIN - 0.5;
        let h = this.heightAt(fx, fy);
        const edge = i === 0 || j === 0 || i === nx - 1 || j === ny - 1;
        if (h > 1.6 * H) h += (hash2(i * 7, j * 13) - 0.5) * 0.6; // crag the rough ground
        const w = this.world(fx, fy);
        const k = (j * nx + i) * 3;
        pos[k] = w.x; pos[k + 1] = edge ? h - 2 : h; pos[k + 2] = w.z;
        const n = hash2(Math.floor(fx * 2), Math.floor(fy * 2));
        if (h < 0.15 * H) c.copy(cShore).multiplyScalar(0.75 + 0.25 * Math.max(0, h + 1));
        else if (h < 1.3 * H) c.copy(cLand).lerp(cLand2, n);
        else c.copy(cRock).lerp(cPeak, 0.75 * smooth01((h - 4.5 * H) / (2.5 * H))).multiplyScalar(0.8 + 0.3 * n);
        col[k] = c.r; col[k + 1] = c.g; col[k + 2] = c.b;
      }
    }
    const idx: number[] = [];
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i, b = a + 1, d = a + nx, e = d + 1;
        idx.push(a, d, b, b, d, e);
      }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    paintSplat(geo, this.ctx, [], !!this.look.liquid);
    const mesh = new THREE.Mesh(geo, makeGroundMaterial(this.planetType));
    mesh.receiveShadow = true;
    return mesh;
  }

  private makeLiquid(): THREE.Mesh {
    const s = this.surface;
    const size = (Math.max(s.w, s.h) + MARGIN * 2) * CELL;
    const L = this.look;
    const mat = new THREE.ShaderMaterial({
      transparent: L.liquid === 'water',
      uniforms: {
        uTime: { value: 0 }, uA: { value: new THREE.Color(L.liquidA) }, uB: { value: new THREE.Color(L.liquidB) },
        uKind: { value: L.liquid === 'water' ? 0 : L.liquid === 'lava' ? 1 : 2 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vW;
        void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */ `
        varying vec3 vW; uniform float uTime; uniform vec3 uA; uniform vec3 uB; uniform int uKind;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
        float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.1; a *= 0.5; } return v; }
        void main() {
          vec2 p = vW.xz * 0.12;
          if (uKind == 1) {
            float n = fbm(p * 0.8 + vec2(uTime * 0.03, -uTime * 0.02));
            float veins = smoothstep(0.45, 0.75, fbm(p * 1.6 - uTime * 0.05));
            vec3 c = mix(uA * 1.1, uB * 1.7, veins) * (0.55 + n * 0.8);
            gl_FragColor = vec4(c, 1.0);
          } else if (uKind == 2) {
            float n = fbm(p * 1.3);
            vec3 c = mix(uA, uB, n) * 0.95 + pow(noise(p * 9.0), 8.0) * 0.4;
            gl_FragColor = vec4(c, 1.0);
          } else {
            float n = fbm(p + vec2(uTime * 0.04, uTime * 0.025));
            float n2 = fbm(p * 2.3 - vec2(uTime * 0.05, 0.0));
            vec3 c = mix(uA, uB, n * 0.8 + n2 * 0.3);
            c += vec3(1.0) * pow(max(0.0, n2 - 0.62) * 2.6, 3.0) * 0.6;
            gl_FragColor = vec4(c * 0.85, 0.93);
          }
        }`,
    });
    this.animated.push(mat);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size * 1.4, size * 1.4), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = -0.15 * H;
    return mesh;
  }

  private makeSky(): THREE.Mesh {
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { uTop: { value: new THREE.Color(this.look.skyTop) }, uHor: { value: new THREE.Color(this.look.skyHorizon) }, uSun: { value: new THREE.Color(this.look.sun) } },
      vertexShader: `varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `varying vec3 vD; uniform vec3 uTop; uniform vec3 uHor; uniform vec3 uSun;
        void main(){ float h = max(vD.y, 0.0);
          vec3 c = mix(uHor, uTop, pow(h, 0.55));
          vec3 sd = normalize(vec3(0.55, 0.62, 0.35));
          float s = max(dot(vD, sd), 0.0);
          c += uSun * (pow(s, 600.0) * 3.0 + pow(s, 12.0) * 0.25);
          gl_FragColor = vec4(c, 1.0); }`,
    });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(380, 32, 16), mat);
    sky.renderOrder = -1;
    return sky;
  }

  private makeGrid(): THREE.LineSegments {
    const s = this.surface;
    const pts: number[] = [];
    for (let y = 0; y < s.h; y++)
      for (let x = 0; x < s.w; x++) {
        if (s.kinds[y * s.w + x] !== 'land') continue;
        const h = s.heights[y * s.w + x] * H + 0.08;
        const a = this.world(x - 0.5, y - 0.5), b = this.world(x + 0.5, y + 0.5);
        pts.push(a.x, h, a.z, b.x, h, a.z, b.x, h, a.z, b.x, h, b.z, b.x, h, b.z, a.x, h, b.z, a.x, h, b.z, a.x, h, a.z);
      }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x8fe8ff, transparent: true, opacity: 0.35, depthWrite: false }));
  }

  private addLights(half: number) {
    const L = this.look;
    this.root.add(new THREE.HemisphereLight(L.ambient, L.rock, L.airless ? 0.3 : 0.45));
    const sun = new THREE.DirectionalLight(L.sun, L.airless ? 2.4 : 1.7);
    sun.position.set(half * 1.4, half * 1.6, half * 0.9);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const r = half + MARGIN * CELL * 0.5;
    Object.assign(sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 1, far: half * 6 });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    this.root.add(sun, sun.target);
  }

  // ------------------------------------------------------------ buildings

  private footprintCenter(b: BuildingId, x: number, y: number) {
    const f = footprint(b);
    const cx = x + (f - 1) / 2, cy = y + (f - 1) / 2;
    const w = this.world(cx, cy);
    return new THREE.Vector3(w.x, this.heightAt(cx, cy), w.z);
  }

  private instance(b: BuildingId, rot: number): THREE.Group | null {
    const t = this.models[b];
    if (!t) return null;
    const g = new THREE.Group();
    const m = t.clone(true);
    m.scale.multiplyScalar(footprint(b) * CELL * FILL);
    m.rotation.y = rot * (Math.PI / 2);
    g.add(m);
    return g;
  }

  /** Roads + vegetation follow the buildings; only rebuilt when the layout actually changes. */
  private dress(state: GameState) {
    const c = state.colonies[this.link.colonyId];
    if (!c) return;
    const key = c.structures.map((s) => `${s.building}${s.x},${s.y}`).join('|') + '#' + c.queue.map((q) => (q.kind === 'building' ? `${q.id}${q.x},${q.y}` : '')).join('|');
    if (key === this.dressKey) return;
    this.dressKey = key;
    const first = !this.fixedDress;
    const roads = this.fixedDress?.roads ?? roadSegments(this.ctx, c);
    if (first || !this.link.stableDressing) paintSplat(this.terrain.geometry, this.ctx, roads, !!this.look.liquid);
    const occ = occupancy(state, c);
    const w = this.surface.w;
    const gen = ++this.dressGen;
    const seed = (state.galaxy!.seed ^ Math.imul(c.systemId + 1, 2654435761) ^ (c.planetId * 97)) | 0;
    const n = Math.max(1, c.structures.length);
    const clearing = this.fixedDress ? this.fixedDress.clearing : c.structures.length
      ? { x: c.structures.reduce((a, s) => a + s.x, 0) / n, y: c.structures.reduce((a, s) => a + s.y, 0) / n, r: 2 + Math.sqrt(n) }
      : null;
    if (this.link.stableDressing && !this.fixedDress) this.fixedDress = { roads, clearing };
    buildScatter(this.planetType, this.ctx, MARGIN - 1, seed, (x, y) => occ[y * w + x] !== null, roads, clearing).then((g) => {
      if (this.disposed || gen !== this.dressGen) return disposeScatter(g);
      if (this.scatter) { this.root.remove(this.scatter); disposeScatter(this.scatter); }
      this.scatter = g;
      this.root.add(g);
    });
  }

  private syncBuildings(state: GameState) {
    const c = state.colonies[this.link.colonyId];
    if (!c) return;
    this.dress(state);
    // finished structures
    const live = new Set(c.structures.map((s) => s.id));
    for (const [id, v] of this.structures) if (!live.has(id)) { this.root.remove(v.group); this.structures.delete(id); }
    for (const s of c.structures) {
      if (this.structures.has(s.id)) continue;
      const g = this.instance(s.building, s.id % 4);
      if (!g) continue;
      g.position.copy(this.footprintCenter(s.building, s.x, s.y));
      const f = footprint(s.building) * CELL * FILL;
      const hit = new THREE.Mesh(new THREE.BoxGeometry(f, f * 0.9, f), new THREE.MeshBasicMaterial({ visible: false }));
      hit.position.y = f * 0.45;
      hit.userData.structureId = s.id;
      g.add(hit);
      this.disposables.push(hit.geometry, hit.material as THREE.Material);
      this.root.add(g);
      this.structures.set(s.id, { group: g, hit });
    }
    // construction sites: real building rises out of a hologram as work progresses
    const keys = new Set<string>();
    c.queue.forEach((q) => {
      if (q.kind !== 'building') return;
      const key = `${q.id}@${q.x},${q.y}`;
      keys.add(key);
      let site = this.sites.get(key);
      if (!site) site = this.makeSite(key, q.id, q.x, q.y) ?? undefined;
      if (!site) return;
      const frac = Math.min(1, q.progress / BUILDINGS[q.id].cost);
      const y = site.baseY + site.height * frac;
      site.below.constant = y;
      site.above.constant = -y;
      (site.label.element.firstChild as HTMLElement).textContent = `${BUILDINGS[q.id].name} · ${Math.floor(frac * 100)}%`;
    });
    for (const [k, site] of this.sites) if (!keys.has(k)) this.removeSite(site);
    this.onLinkChange();
    this.afterSync?.();
  }

  private makeSite(key: string, b: BuildingId, x: number, y: number): SiteView | null {
    const real = this.instance(b, 0);
    const holo = this.instance(b, 0);
    if (!real || !holo) return null;
    const pos = this.footprintCenter(b, x, y);
    const height = modelHeight(this.models[b]!) * footprint(b) * CELL * FILL;
    const below = new THREE.Plane(new THREE.Vector3(0, -1, 0), pos.y);
    const above = new THREE.Plane(new THREE.Vector3(0, 1, 0), -pos.y);
    const materials: THREE.Material[] = [];
    real.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mat = (m.material as THREE.Material).clone();
      mat.clippingPlanes = [below];
      m.material = mat;
      materials.push(mat);
    });
    const hm = hologramMaterial(new THREE.Color(0.35, 1.5, 2.2));
    hm.clippingPlanes = [above];
    materials.push(hm);
    this.animated.push(hm);
    holo.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) { m.material = hm; m.castShadow = false; }
    });
    const group = new THREE.Group();
    group.position.copy(pos);
    group.add(real, holo);
    const el = document.createElement('div');
    el.className = 'site-label';
    el.appendChild(document.createElement('span'));
    const label = new CSS2DObject(el);
    label.position.set(0, height + 1.2, 0);
    group.add(label);
    this.root.add(group);
    const site = { key, group, materials, below, above, label, baseY: pos.y, height };
    this.sites.set(key, site);
    return site;
  }

  private removeSite(site: SiteView) {
    this.root.remove(site.group);
    site.label.element.remove();
    for (const m of site.materials) {
      m.dispose();
      const i = this.animated.indexOf(m as THREE.ShaderMaterial);
      if (i >= 0) this.animated.splice(i, 1);
    }
    this.sites.delete(site.key);
  }

  // ------------------------------------------------------------ placement + selection

  private onLinkChange() {
    const placing = this.link.getPlacing();
    this.grid.visible = !!placing;
    if (!placing || placing !== this.ghost?.building) {
      if (this.ghost) {
        this.root.remove(this.ghost.group);
        this.ghost.mat.dispose();
        this.animated.splice(this.animated.indexOf(this.ghost.mat), 1);
        this.ghost = null;
      }
      if (placing) {
        const g = this.instance(placing, 0);
        if (g) {
          const mat = hologramMaterial(new THREE.Color(0.4, 2, 0.8));
          g.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.material = mat; m.castShadow = false; } });
          g.visible = false;
          this.root.add(g);
          this.animated.push(mat);
          this.ghost = { group: g, mat, building: placing };
        }
      }
    }
    // selection outline
    const sel = this.link.getStructure();
    const s = sel === null ? null : this.colony.structures.find((x) => x.id === sel);
    this.selection.visible = !!s;
    if (s) {
      const f = footprint(s.building);
      const c = this.footprintCenter(s.building, s.x, s.y);
      const r = (f * CELL) / 2 - 0.2;
      this.selection.geometry.setFromPoints([
        new THREE.Vector3(c.x - r, c.y + 0.15, c.z - r), new THREE.Vector3(c.x + r, c.y + 0.15, c.z - r),
        new THREE.Vector3(c.x + r, c.y + 0.15, c.z + r), new THREE.Vector3(c.x - r, c.y + 0.15, c.z + r),
      ]);
    }
  }

  private cellUnder(ray: THREE.Raycaster, b: BuildingId | null): { x: number; y: number } | null {
    const hit = ray.intersectObject(this.terrain, false)[0];
    if (!hit) return null;
    const f = b ? footprint(b) : 1;
    const fx = hit.point.x / CELL + (this.surface.w - 1) / 2;
    const fy = hit.point.z / CELL + (this.surface.h - 1) / 2;
    return { x: Math.round(fx - (f - 1) / 2), y: Math.round(fy - (f - 1) / 2) };
  }

  private blockerAt(b: BuildingId, x: number, y: number) {
    return this.link.blocker ? this.link.blocker(b, x, y) : placeBlocker(this.engine.getState(), this.colony, b, x, y);
  }

  /** Cell under the pointer (fractional cell coords), for views layered on top. */
  pointCell(ray: THREE.Raycaster): { x: number; y: number } | null {
    const hit = ray.intersectObject(this.terrain, false)[0];
    if (!hit) return null;
    return { x: hit.point.x / CELL + (this.surface.w - 1) / 2, y: hit.point.z / CELL + (this.surface.h - 1) / 2 };
  }

  pickStructure(ray: THREE.Raycaster): number | null {
    const hits = ray.intersectObjects([...this.structures.values()].map((v) => v.hit), false);
    return hits.length ? (hits[0].object.userData.structureId as number) : null;
  }

  hover(ray: THREE.Raycaster): boolean {
    const placing = this.link.getPlacing();
    if (!placing || !this.ghost) return this.pickStructure(ray) !== null;
    const cell = this.cellUnder(ray, placing);
    this.ghostCell = cell;
    if (!cell) { this.ghost.group.visible = false; return false; }
    const ok = !this.blockerAt(placing, cell.x, cell.y);
    this.ghost.group.visible = true;
    this.ghost.group.position.copy(this.footprintCenter(placing, cell.x, cell.y));
    this.ghost.mat.uniforms.uColor.value.set(ok ? new THREE.Color(0.4, 2, 0.8) : new THREE.Color(2.4, 0.35, 0.3));
    return ok;
  }

  click(ray: THREE.Raycaster) {
    const placing = this.link.getPlacing();
    if (placing) {
      const cell = this.cellUnder(ray, placing);
      if (cell && !this.blockerAt(placing, cell.x, cell.y)) this.link.place(placing, cell.x, cell.y);
      return;
    }
    this.link.setStructure(this.pickStructure(ray));
  }

  contextClick() {
    if (this.link.getPlacing()) this.link.setPlacing(null);
  }

  update({ t }: FrameContext) {
    for (const m of this.animated) if (m.uniforms?.uTime) m.uniforms.uTime.value = t;
  }

  dispose() {
    this.disposed = true;
    for (const u of this.unsubs) u();
    if (this.scatter) disposeScatter(this.scatter);
    for (const site of [...this.sites.values()]) this.removeSite(site);
    if (this.ghost) this.ghost.mat.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

function hologramMaterial(color: THREE.Color): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, clipping: true,
    uniforms: { uColor: { value: color.clone() }, uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      #include <clipping_planes_pars_vertex>
      varying vec3 vN; varying vec3 vV; varying vec3 vW;
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = -mvPosition.xyz;
        vW = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * mvPosition;
        #include <clipping_planes_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <clipping_planes_pars_fragment>
      uniform vec3 uColor; uniform float uTime;
      varying vec3 vN; varying vec3 vV; varying vec3 vW;
      void main() {
        #include <clipping_planes_fragment>
        float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.0);
        float scan = 0.5 + 0.5 * sin(vW.y * 5.0 - uTime * 4.0);
        float a = 0.08 + fres * 0.5 + scan * 0.08;
        gl_FragColor = vec4(uColor * a, a);
      }`,
  });
}

const terrace = (t: number) => { const u = Math.min(1, Math.max(0, (t - 0.28) / 0.44)); return u * u * (3 - 2 * u); };
const smooth01 = (t: number) => { const u = Math.min(1, Math.max(0, t)); return u * u * (3 - 2 * u); };
function hash2(x: number, y: number) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
