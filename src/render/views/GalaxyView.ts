import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { shipCount, type ShipId, type Engine, type FactionId, type Fleet, type FleetId, type Galaxy, type GameState, type StarSystem } from '../../engine/index.ts';
import { FACTION_STYLE, STAR_STYLE } from '../../theme.ts';
import type { CameraPreset, FrameContext, View } from '../View.ts';
import { flagshipOf, loadShipModels, makeShip } from '../shipModels.ts';
import { glowTexture } from '../glow.ts';

/** How the galaxy view talks to the UI: selection in, orders out. It never mutates game state itself. */
export interface GalaxyLink {
  player: FactionId;
  getSystem(): number | null;
  setSystem(id: number | null): void;
  getFleet(): FleetId | null;
  setFleet(id: FleetId | null): void;
  /** Called with the changed parts of the selection. */
  subscribe(fn: (changed: { system?: number | null; fleet?: FleetId | null }) => void): () => void;
  moveOrder(fleet: FleetId, system: number): void;
}

const LABEL_NEAR = 80; // labels of unowned stars appear when the camera is this close
const PARK_RADIUS = 5.5;
const SHIP_LENGTH = 3;
const ORBIT_SPEED = 0.12;

interface FleetView {
  group: THREE.Group;
  arrow: THREE.Mesh;
  hit: THREE.Mesh;
  label: CSS2DObject;
  path: THREE.Line;
  shown: THREE.Vector3;
  target: THREE.Vector3;
  dest: THREE.Vector3 | null;
  /** Parked: orbit this star at this phase. */
  orbit: { center: THREE.Vector3; phase: number } | null;
  flagship: ShipId;
  model: THREE.Group | null;
  modelKind: ShipId | null;
  color: THREE.Color;
}

/** Galaxy map: dust, core glow, clickable star systems, faction territory, fleets, labels. */
export class GalaxyView implements View {
  root = new THREE.Group();
  preset: CameraPreset;
  private stars: THREE.Points;
  private starMat: THREE.ShaderMaterial;
  private selectRing: THREE.Mesh;
  private hoverRing: THREE.Mesh;
  private fleetRing: THREE.Mesh;
  private territory = new THREE.Group();
  private labels: { obj: CSS2DObject; span: HTMLSpanElement; sys: StarSystem; shown: boolean | null }[] = [];
  private fleets = new Map<FleetId, FleetView>();
  private fleetGeo = new THREE.ConeGeometry(0.75, 2.2, 3);
  private hitGeo = new THREE.SphereGeometry(1.8, 8, 6);
  private hitMat = new THREE.MeshBasicMaterial({ visible: false });
  private hovered: number | null = null;
  private camDist = 200;
  private disposables: { dispose(): void }[] = [];
  private unsubs: (() => void)[] = [];
  private galaxy: Galaxy;
  private link: GalaxyLink;
  private models: Partial<Record<ShipId, THREE.Object3D>> = {};
  private disposed = false;

  constructor(engine: Engine, link: GalaxyLink, flyTo: (p: THREE.Vector3, distance?: number) => void) {
    const state = engine.getState();
    const galaxy = state.galaxy!;
    this.galaxy = galaxy;
    this.link = link;
    const R = galaxy.radius;
    this.preset = {
      position: [0, R * 1.05, R * 1.3], target: [0, 0, 0],
      minDistance: 12, maxDistance: R * 2.8, maxPolarAngle: Math.PI * 0.47, autoRotateSpeed: 0.12,
    };

    this.root.add(this.track(makeDust(galaxy)), this.track(makeNebulaClumps(galaxy)));
    for (const s of makeCore()) this.root.add(this.track(s));
    this.root.add(this.territory);
    const key = new THREE.DirectionalLight(0xffe6c4, 1.5);
    key.position.set(40, 80, 30);
    const rim = new THREE.DirectionalLight(0x6fc8ff, 0.9);
    rim.position.set(-50, 20, -40);
    this.root.add(new THREE.HemisphereLight(0x8fb4ff, 0x1a1024, 0.35), key, rim);

    [this.stars, this.starMat] = makeStars(galaxy);
    this.root.add(this.track(this.stars));

    this.selectRing = this.track(makeMarker(new THREE.Color(1.6, 1.8, 2.0), 3.2, true));
    this.hoverRing = this.track(makeMarker(new THREE.Color(0.6, 0.8, 1.0), 2.4, false));
    this.fleetRing = this.track(makeMarker(new THREE.Color(2.2, 1.5, 0.5), 1.9, true));
    this.selectRing.visible = this.hoverRing.visible = this.fleetRing.visible = false;
    this.root.add(this.selectRing, this.hoverRing, this.fleetRing);

    for (const sys of galaxy.systems) {
      const el = document.createElement('div');
      el.className = 'star-label';
      const span = document.createElement('span');
      span.textContent = sys.name;
      el.appendChild(span);
      const obj = new CSS2DObject(el);
      obj.position.set(sys.pos.x, sys.pos.y, sys.pos.z);
      this.root.add(obj);
      this.labels.push({ obj, span, sys, shown: null });
    }
    this.syncOwners(galaxy);
    this.syncFleets(state);
    loadShipModels().then((m) => {
      if (this.disposed) return;
      this.models = m;
      for (const v of this.fleets.values()) this.applyModel(v);
    });

    this.unsubs.push(
      engine.subscribe((s, prev) => {
        if (s.galaxy && s.galaxy !== prev.galaxy && s.galaxy.seed === galaxy.seed) this.syncOwners(s.galaxy);
        if (s.fleets !== prev.fleets) this.syncFleets(s);
      }),
    );

    const onSystem = (id: number | null) => {
      const sys = id === null ? null : galaxy.systems[id];
      this.selectRing.visible = !!sys;
      if (!sys) return;
      const p = new THREE.Vector3(sys.pos.x, sys.pos.y, sys.pos.z);
      this.selectRing.position.copy(p);
      flyTo(p, Math.min(this.camDist, 36));
    };
    this.unsubs.push(
      link.subscribe((ch) => {
        if (ch.system !== undefined) onSystem(ch.system);
      }),
    );
    if (link.getSystem() !== null) onSystem(link.getSystem());
  }

  private track<T extends THREE.Object3D>(obj: T): T {
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) this.disposables.push(m.geometry);
      if (m.material) this.disposables.push(...([] as THREE.Material[]).concat(m.material));
    });
    return obj;
  }

  /** Territory glows + label colours follow system ownership (colonization changes it). */
  private syncOwners(galaxy: Galaxy) {
    this.galaxy = galaxy;
    for (const child of [...this.territory.children]) {
      this.territory.remove(child);
      child.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        ([] as THREE.Material[]).concat(m.material ?? []).forEach((mt) => mt.dispose());
      });
    }
    for (const sys of galaxy.systems) if (sys.owner) this.territory.add(makeTerritory(sys, sys.owner));
    for (const l of this.labels) {
      l.sys = galaxy.systems[l.sys.id];
      const owner = l.sys.owner;
      l.span.classList.toggle('is-owned', !!owner);
      l.span.style.color = owner ? FACTION_STYLE[owner].color : '';
      l.shown = null;
    }
  }

  private syncFleets(state: GameState) {
    for (const [id, v] of this.fleets) {
      if (!state.fleets[id]) {
        this.root.remove(v.group, v.path);
        v.label.element.remove();
        (v.arrow.material as THREE.Material).dispose();
        v.path.geometry.dispose();
        (v.path.material as THREE.Material).dispose();
        this.fleets.delete(id);
        if (this.link.getFleet() === id) this.link.setFleet(null);
      }
    }
    // parked fleets fan out around their star so they never overlap it or each other
    const parkedIndex = new Map<number, number>();
    for (const f of Object.values(state.fleets)) {
      let v = this.fleets.get(f.id);
      if (!v) v = this.addFleet(f);
      v.target.set(f.pos.x, f.pos.y, f.pos.z);
      v.orbit = null;
      if (f.at !== null && f.dest === null) {
        const i = parkedIndex.get(f.at) ?? 0;
        parkedIndex.set(f.at, i + 1);
        v.orbit = { center: v.target.clone(), phase: 0.7 + i * 1.6 };
      }
      v.flagship = flagshipOf(f.ships);
      this.applyModel(v);
      const d = f.dest === null ? null : state.galaxy!.systems[f.dest].pos;
      v.dest = d ? new THREE.Vector3(d.x, d.y, d.z) : null;
      v.path.visible = !!v.dest;
      (v.label.element.firstChild as HTMLElement).textContent = String(shipCount(f));
    }
  }

  private addFleet(f: Fleet): FleetView {
    const color = new THREE.Color(FACTION_STYLE[f.faction].color);
    const arrow = new THREE.Mesh(this.fleetGeo, new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(1.7) }));
    arrow.rotation.x = Math.PI / 2; // cone tip -> +Z, so group.lookAt() aims it
    const hit = new THREE.Mesh(this.hitGeo, this.hitMat);
    hit.userData.fleetId = f.id;
    const el = document.createElement('div');
    el.className = `fleet-label ${f.faction === this.link.player ? 'is-mine' : ''}`;
    el.style.setProperty('--fc', FACTION_STYLE[f.faction].color);
    el.appendChild(document.createElement('span'));
    const label = new CSS2DObject(el);
    const group = new THREE.Group();
    group.add(arrow, hit, label);
    const path = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineDashedMaterial({ color, dashSize: 1.2, gapSize: 0.9, transparent: true, opacity: 0.85 }),
    );
    path.frustumCulled = false;
    const start = new THREE.Vector3(f.pos.x, f.pos.y, f.pos.z);
    group.position.copy(start);
    this.root.add(group, path);
    const v: FleetView = {
      group, arrow, hit, label, path, shown: start.clone(), target: start.clone(), dest: null,
      orbit: null, flagship: flagshipOf(f.ships), model: null, modelKind: null, color,
    };
    this.fleets.set(f.id, v);
    return v;
  }

  /** Swap in the 3D model of the fleet's flagship (keeps the arrow until models have loaded). */
  private applyModel(v: FleetView) {
    if (v.modelKind === v.flagship) return;
    const template = this.models[v.flagship];
    if (!template) return;
    if (v.model) {
      v.group.remove(v.model);
      v.model.traverse((o) => (o as THREE.Sprite).isSprite && (o as THREE.Sprite).material.dispose());
    }
    v.model = makeShip(template, v.flagship, v.color);
    v.model.scale.setScalar(SHIP_LENGTH);
    v.modelKind = v.flagship;
    v.group.add(v.model);
    v.arrow.visible = false;
  }

  private pickFleet(ray: THREE.Raycaster): FleetId | null {
    const hits = ray.intersectObjects([...this.fleets.values()].map((v) => v.hit), false);
    return hits.length ? (hits[0].object.userData.fleetId as FleetId) : null;
  }

  private pickStar(ray: THREE.Raycaster): number | null {
    ray.params.Points.threshold = Math.max(1.4, this.camDist * 0.02);
    const hits = ray.intersectObject(this.stars);
    if (!hits.length) return null;
    let best = hits[0];
    for (const h of hits) if ((h.distanceToRay ?? 0) < (best.distanceToRay ?? 0)) best = h;
    return best.index ?? null;
  }

  click(ray: THREE.Raycaster) {
    const fleet = this.pickFleet(ray);
    if (fleet !== null) return this.link.setFleet(fleet);
    const star = this.pickStar(ray);
    if (star === null) this.link.setFleet(null);
    this.link.setSystem(star);
  }

  contextClick(ray: THREE.Raycaster) {
    const fleetId = this.link.getFleet();
    if (fleetId === null) return;
    const star = this.pickStar(ray);
    if (star !== null) this.link.moveOrder(fleetId, star);
  }

  hover(ray: THREE.Raycaster) {
    if (this.pickFleet(ray) !== null) {
      this.hovered = null;
      this.hoverRing.visible = false;
      return true;
    }
    this.hovered = this.pickStar(ray);
    const sys = this.hovered === null ? null : this.galaxy.systems[this.hovered];
    this.hoverRing.visible = !!sys && this.hovered !== this.link.getSystem();
    if (sys) this.hoverRing.position.set(sys.pos.x, sys.pos.y, sys.pos.z);
    return sys !== null;
  }

  update({ t, dt, camera }: FrameContext) {
    this.camDist = camera.position.length();
    this.starMat.uniforms.uTime.value = t;

    // fleets glide to their new turn position, face their heading, keep a readable size
    const k = 1 - Math.exp(-dt * 3.5);
    const selectedFleet = this.link.getFleet();
    for (const [id, v] of this.fleets) {
      let heading: THREE.Vector3 | null = null;
      if (v.orbit) {
        const a = v.orbit.phase + t * ORBIT_SPEED;
        v.target.set(v.orbit.center.x + Math.cos(a) * PARK_RADIUS, v.orbit.center.y + 1.2, v.orbit.center.z + Math.sin(a) * PARK_RADIUS);
        heading = new THREE.Vector3(-Math.sin(a), 0, Math.cos(a)).add(v.target); // tangent: fly nose-first around the star
      }
      v.shown.lerp(v.target, k);
      v.group.position.copy(v.shown);
      const d = camera.position.distanceTo(v.shown);
      v.group.scale.setScalar(Math.max(1, d / 60));
      if (heading) v.group.lookAt(heading);
      if (v.dest) {
        v.group.lookAt(v.dest);
        const pos = v.path.geometry.attributes.position as THREE.BufferAttribute;
        pos.setXYZ(0, v.shown.x, v.shown.y, v.shown.z);
        pos.setXYZ(1, v.dest.x, v.dest.y, v.dest.z);
        pos.needsUpdate = true;
        v.path.computeLineDistances();
        v.path.geometry.computeBoundingSphere();
      } else if (!heading) {
        v.group.rotation.set(0, t * 0.3 + id, 0);
      }
      if (id === selectedFleet) this.fleetRing.position.copy(v.shown);
    }
    this.fleetRing.visible = selectedFleet !== null && this.fleets.has(selectedFleet);

    for (const ring of [this.selectRing, this.hoverRing, this.fleetRing]) {
      ring.quaternion.copy(camera.quaternion);
      const d = camera.position.distanceTo(ring.position);
      const pulse = ring === this.hoverRing ? 1 : 1 + 0.06 * Math.sin(t * 3);
      ring.scale.setScalar(Math.max(0.6, d / 70) * pulse);
    }
    this.selectRing.rotateZ(t * 0.4);
    this.fleetRing.rotateZ(-t * 0.6);

    const selected = this.link.getSystem();
    const tmp = new THREE.Vector3();
    for (const l of this.labels) {
      const d = camera.position.distanceTo(tmp.set(l.sys.pos.x, l.sys.pos.y, l.sys.pos.z));
      const show = !!l.sys.owner || l.sys.id === selected || l.sys.id === this.hovered || d < LABEL_NEAR;
      if (show !== l.shown) {
        l.obj.element.classList.toggle('is-hidden', !show);
        l.shown = show;
      }
    }
  }

  dispose() {
    this.disposed = true;
    for (const u of this.unsubs) u();
    for (const l of this.labels) l.obj.element.remove();
    for (const v of this.fleets.values()) {
      v.label.element.remove();
      (v.arrow.material as THREE.Material).dispose();
      v.path.geometry.dispose();
      (v.path.material as THREE.Material).dispose();
    }
    this.syncOwnersDispose();
    for (const d of [...this.disposables, this.fleetGeo, this.hitGeo, this.hitMat]) d.dispose();
  }

  private syncOwnersDispose() {
    for (const child of this.territory.children)
      child.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        ([] as THREE.Material[]).concat(m.material ?? []).forEach((mt) => mt.dispose());
      });
  }
}

// ---------------------------------------------------------------- builders

const POINT_VERT = /* glsl */ `
  attribute float size;
  attribute vec3 tint;
  varying vec3 vTint;
  uniform float uScale;
  void main() {
    vTint = tint;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = clamp(size * uScale / -mv.z, 1.5, 56.0);
    gl_Position = projectionMatrix * mv;
  }`;

function pointCloud(pos: number[], tint: number[], size: number[], frag: string, uniforms: Record<string, THREE.IUniform> = {}) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('tint', new THREE.Float32BufferAttribute(tint, 3));
  geo.setAttribute('size', new THREE.Float32BufferAttribute(size, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 420 * Math.min(window.devicePixelRatio, 2) }, ...uniforms },
    vertexShader: POINT_VERT,
    fragmentShader: frag,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  return new THREE.Points(geo, mat);
}

function armPoint(g: Galaxy, t: number, spread: number): [number, number, number] {
  const arm = Math.floor(Math.random() * g.arms);
  const theta = g.rotation + (arm / g.arms) * Math.PI * 2 + t * g.twist + gauss() * spread;
  const r = t * g.radius;
  return [Math.cos(theta) * r, gauss() * 2.6 * (1.15 - t), Math.sin(theta) * r];
}

function makeDust(g: Galaxy): THREE.Points {
  const pos: number[] = [], tint: number[] = [], size: number[] = [];
  const core = new THREE.Color('#ffd7a0'), teal = new THREE.Color('#58c8ff'), violet = new THREE.Color('#8f6bff');
  const c = new THREE.Color();
  for (let i = 0; i < 26000; i++) {
    let p: [number, number, number];
    let t: number;
    if (Math.random() < 0.18) {
      const r = Math.abs(gauss()) * 0.13;
      const a = Math.random() * Math.PI * 2;
      t = r;
      p = [Math.cos(a) * r * g.radius, gauss() * 3 * (1 - r), Math.sin(a) * r * g.radius];
    } else {
      t = 0.08 + Math.pow(Math.random(), 0.9) * 1.0;
      p = armPoint(g, t, 0.42 * (1.25 - t * 0.5));
    }
    pos.push(...p);
    c.copy(teal).lerp(violet, Math.random() * 0.7).lerp(core, Math.max(0, 1 - t * 3.2));
    const b = (0.35 + Math.random() * 0.5) * Math.max(0.25, 1.1 - t * 0.7);
    tint.push(c.r * b, c.g * b, c.b * b);
    size.push(0.4 + Math.random() * 1.2);
  }
  return pointCloud(pos, tint, size, /* glsl */ `
    varying vec3 vTint;
    void main() {
      float d = length(gl_PointCoord - 0.5);
      float a = smoothstep(0.5, 0.0, d);
      gl_FragColor = vec4(vTint * a * 0.55, a);
    }`);
}

function makeNebulaClumps(g: Galaxy): THREE.Points {
  const pos: number[] = [], tint: number[] = [], size: number[] = [];
  const pink = new THREE.Color('#ff4f9a'), blue = new THREE.Color('#3a7bff');
  for (let i = 0; i < 260; i++) {
    const t = 0.25 + Math.random() * 0.75;
    pos.push(...armPoint(g, t, 0.22));
    const c = Math.random() < 0.6 ? pink : blue;
    tint.push(c.r * 0.22, c.g * 0.22, c.b * 0.22);
    size.push(8 + Math.random() * 16);
  }
  return pointCloud(pos, tint, size, /* glsl */ `
    varying vec3 vTint;
    void main() {
      float d = length(gl_PointCoord - 0.5);
      float a = pow(smoothstep(0.5, 0.0, d), 2.0);
      gl_FragColor = vec4(vTint * a, a);
    }`);
}

function makeCore(): THREE.Sprite[] {
  const tex = glowTexture();
  const mk = (color: string, scale: number, opacity: number) => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, color, opacity, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    s.scale.setScalar(scale);
    return s;
  };
  return [mk('#ff9a4a', 95, 0.35), mk('#ffd9a0', 38, 0.8), mk('#fff4e0', 12, 1)];
}

function makeStars(g: Galaxy): [THREE.Points, THREE.ShaderMaterial] {
  const pos: number[] = [], tint: number[] = [], size: number[] = [];
  const c = new THREE.Color();
  for (const s of g.systems) {
    const st = STAR_STYLE[s.star];
    pos.push(s.pos.x, s.pos.y, s.pos.z);
    c.set(st.color);
    tint.push(c.r, c.g, c.b);
    size.push(st.size * 1.6);
  }
  const pts = pointCloud(pos, tint, size, /* glsl */ `
    varying vec3 vTint;
    uniform float uTime;
    void main() {
      vec2 p = gl_PointCoord - 0.5;
      float d = length(p);
      float core = smoothstep(0.16, 0.0, d);
      float halo = pow(smoothstep(0.5, 0.0, d), 3.0);
      float spike = max(0.0, 1.0 - abs(p.x) * 40.0) + max(0.0, 1.0 - abs(p.y) * 40.0);
      spike *= smoothstep(0.5, 0.0, d) * 0.35;
      vec3 col = vTint * (core * 2.4 + halo * 0.9 + spike) + vec3(core * 0.8);
      gl_FragColor = vec4(col, max(core, halo));
    }`, { uTime: { value: 0 } });
  pts.renderOrder = 2;
  return [pts, pts.material as THREE.ShaderMaterial];
}

function makeTerritory(sys: StarSystem, owner: FactionId): THREE.Group {
  const color = new THREE.Color(FACTION_STYLE[owner].color);
  const group = new THREE.Group();
  group.position.set(sys.pos.x, sys.pos.y - 0.2, sys.pos.z);

  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(16, 64),
    new THREE.ShaderMaterial({
      uniforms: { uColor: { value: color } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `varying vec2 vUv; uniform vec3 uColor;
        void main(){ float d = length(vUv - 0.5) * 2.0;
          float a = pow(1.0 - d, 2.0) * 0.22 + smoothstep(0.03, 0.0, abs(d - 0.92)) * 0.25;
          gl_FragColor = vec4(uColor * a, a); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }),
  );
  disc.rotation.x = -Math.PI / 2;
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(2.4, 2.65, 64),
    new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(1.6), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  group.add(disc, ring);
  return group;
}

function makeMarker(color: THREE.Color, radius: number, ticks: boolean): THREE.Mesh {
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: ticks ? 1 : 0.5, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
  const ring = new THREE.Mesh(new THREE.RingGeometry(radius, radius + 0.18, 64), mat);
  if (ticks) {
    for (let i = 0; i < 4; i++) {
      const tick = new THREE.Mesh(new THREE.PlaneGeometry(0.25, 1.1), mat);
      const a = (i / 4) * Math.PI * 2;
      tick.position.set(Math.cos(a) * (radius + 0.9), Math.sin(a) * (radius + 0.9), 0);
      tick.rotation.z = a + Math.PI / 2;
      ring.add(tick);
    }
  }
  ring.renderOrder = 3;
  return ring;
}

function gauss() {
  const u = Math.max(Math.random(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}
