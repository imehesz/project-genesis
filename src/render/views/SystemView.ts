import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { missionPlanetLock, type Engine, type GameState } from '../../engine/index.ts';
import { FACTION_STYLE } from '../../theme.ts';
import { asset } from '../../asset.ts';
import { glowTexture } from '../glow.ts';
import { loadShipModels, makeShip } from '../shipModels.ts';
import type { CameraPreset, FrameContext, View } from '../View.ts';

/** How the system view talks to the UI: planet selection in, ship orders out. */
export interface SystemLink {
  getPlanet(): number | null;
  setPlanet(id: number | null): void;
  subscribe(fn: () => void): () => void;
  moveShip(planetId: number): void;
}

/** Where things sit in a campaign star system (shared with the space minimap). */
export const SYSTEM_LAYOUT = {
  orbits: [20, 33, 47],
  angles: [0.65, 2.55, 4.4],
  parked: { r: 15, a: 0.8 }, // just inside Aurelia's orbit, a few units from the planet
  planetSize: (size: number) => 3.2 + size * 0.8,
};

export function planetPos(i: number): THREE.Vector3 {
  const r = SYSTEM_LAYOUT.orbits[i] ?? 20 + i * 13, a = SYSTEM_LAYOUT.angles[i] ?? i * 2;
  return new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r);
}

const SHIP_LEN = 3.2;
const SHIP_ORBIT = 0.35; // rad/s around a planet

/** A single star system: the sun, its planets on their orbits, and the commander's ship. */
export class SystemView implements View {
  root = new THREE.Group();
  preset: CameraPreset = { position: [0, 62, 74], target: [0, 0, 6], minDistance: 18, maxDistance: 220, maxPolarAngle: Math.PI * 0.46, autoRotateSpeed: 0 };
  bloom = 0.65;
  private engine: Engine;
  private link: SystemLink;
  private planets: { group: THREE.Group; hit: THREE.Mesh; label: CSS2DObject; size: number }[] = [];
  private selectRing: THREE.Mesh;
  private hoverRing: THREE.Mesh;
  private ship = new THREE.Group();
  private shipPos = new THREE.Vector3();
  private shipFrom: THREE.Vector3 | null = null;
  private shipT = 1;
  private shipAt: number | null = null;
  private path: THREE.Line;
  private hovered: number | null = null;
  private disposables: { dispose(): void }[] = [];
  private unsubs: (() => void)[] = [];
  private disposed = false;

  constructor(engine: Engine, link: SystemLink) {
    this.engine = engine;
    this.link = link;
    const state = engine.getState();
    const sys = state.galaxy!.systems[state.mission!.systemId];

    // the sun
    const sunMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.7, 1.35, 0.8) });
    const sun = new THREE.Mesh(new THREE.SphereGeometry(4.2, 40, 24), sunMat);
    const corona = this.sprite(new THREE.Color(1.3, 0.85, 0.4), 18);
    (corona.material as THREE.SpriteMaterial).opacity = 0.7;
    const corona2 = this.sprite(new THREE.Color(0.9, 0.45, 0.15), 38);
    (corona2.material as THREE.SpriteMaterial).opacity = 0.22;
    this.root.add(sun, corona, corona2);
    this.track(sun);
    this.root.add(new THREE.PointLight(0xfff0d8, 2.2, 0, 0));
    this.root.add(new THREE.AmbientLight(0x6f86b0, 0.6));

    // orbits + planets
    const mask = circleMask();
    this.disposables.push(mask);
    sys.planets.forEach((p, i) => {
      const r = SYSTEM_LAYOUT.orbits[i];
      const orbit = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(Array.from({ length: 128 }, (_, k) => new THREE.Vector3(Math.cos((k / 128) * Math.PI * 2) * r, 0, Math.sin((k / 128) * Math.PI * 2) * r))),
        new THREE.LineBasicMaterial({ color: 0x6d8cc2, transparent: true, opacity: 0.22 }),
      );
      this.root.add(this.track(orbit));
      const size = SYSTEM_LAYOUT.planetSize(p.size);
      const tex = new THREE.TextureLoader().load(asset(`art/planets/${p.type}.webp`));
      tex.colorSpace = THREE.SRGBColorSpace;
      this.disposables.push(tex);
      const body = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, alphaMap: mask, transparent: true }));
      body.scale.setScalar(size * 1.27);
      const atmo = this.sprite(new THREE.Color(0.35, 0.6, 1.1), size * 1.5);
      (atmo.material as THREE.SpriteMaterial).opacity = 0.35;
      const hit = new THREE.Mesh(new THREE.SphereGeometry(size * 0.6, 10, 8), new THREE.MeshBasicMaterial({ visible: false }));
      hit.userData.planet = i;
      const group = new THREE.Group();
      group.position.copy(planetPos(i));
      group.add(atmo, body, hit);
      const el = document.createElement('div');
      el.className = 'sys-label';
      el.innerHTML = `<b></b><em></em>`;
      const label = new CSS2DObject(el);
      label.position.set(0, -size * 0.62 - 1, 0);
      group.add(label);
      this.root.add(group);
      this.track(body); this.track(hit);
      this.planets.push({ group, hit, label, size });
    });

    // selection rings (flat, in the orbital plane)
    const ringGeo = new THREE.RingGeometry(1, 1.08, 64).rotateX(-Math.PI / 2);
    this.selectRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(0.35, 0.85, 1.05), transparent: true, opacity: 0.75, depthWrite: false }));
    this.hoverRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 1, 1), transparent: true, opacity: 0.35, depthWrite: false }));
    this.selectRing.visible = this.hoverRing.visible = false;
    this.root.add(this.selectRing, this.hoverRing);
    this.track(this.selectRing); this.track(this.hoverRing);

    // the commander's ship
    this.root.add(this.ship);
    this.path = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: 0x8fe8ff, dashSize: 1.2, gapSize: 0.8, transparent: true, opacity: 0.8 }));
    this.path.visible = false;
    this.root.add(this.track(this.path));
    loadShipModels().then((m) => {
      if (this.disposed) return;
      const t = m.frigate ?? m.scout;
      if (!t) return;
      const s = makeShip(t, m.frigate ? 'frigate' : 'scout', new THREE.Color(FACTION_STYLE.terran.color));
      s.scale.setScalar(SHIP_LEN);
      this.ship.add(s);
    });
    this.shipAt = state.mission!.ship.at;
    this.shipPos.copy(this.anchorOf(this.shipAt, 0));

    this.unsubs.push(engine.subscribe((s, prev) => { if (s.mission !== prev.mission) this.sync(s); }));
    this.unsubs.push(link.subscribe(() => this.paint()));
    this.sync(state);
    this.paint();
  }

  private track<T extends THREE.Object3D>(o: T): T {
    o.traverse((x) => {
      const m = x as THREE.Mesh;
      if (m.geometry) this.disposables.push(m.geometry);
      if (m.material) this.disposables.push(...([] as THREE.Material[]).concat(m.material));
    });
    return o;
  }

  private sprite(color: THREE.Color, size: number) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    s.scale.setScalar(size);
    this.disposables.push(s.material);
    return s;
  }

  /** Where the ship sits: circling a planet, or parked by the sun. */
  private anchorOf(planet: number | null, t: number): THREE.Vector3 {
    if (planet === null) {
      const { r, a } = SYSTEM_LAYOUT.parked;
      return new THREE.Vector3(Math.cos(a) * r, 1.5, Math.sin(a) * r);
    }
    const c = planetPos(planet);
    const rr = this.planets[planet].size * 0.5 + 1.3;
    return c.add(new THREE.Vector3(Math.cos(t * SHIP_ORBIT) * rr, 1.2, Math.sin(t * SHIP_ORBIT) * rr));
  }

  private sync(s: GameState) {
    const m = s.mission!;
    if (m.ship.at !== this.shipAt) {
      // the turn ended: fly from where we are to the new orbit
      this.shipFrom = this.shipPos.clone();
      this.shipT = 0;
      this.shipAt = m.ship.at;
    }
    const sys = s.galaxy!.systems[m.systemId];
    sys.planets.forEach((p, i) => {
      const el = this.planets[i].label.element;
      (el.querySelector('b') as HTMLElement).textContent = p.name;
      const lock = missionPlanetLock(s, i);
      const tag = el.querySelector('em') as HTMLElement;
      tag.textContent = lock ? 'LOCKED' : m.completed.includes(i) ? 'SECURED' : m.ship.at === i ? 'IN ORBIT' : m.ship.dest === i ? 'EN ROUTE' : '';
      el.classList.toggle('is-locked', !!lock);
    });
    this.paint();
  }

  private paint() {
    const sel = this.link.getPlanet();
    this.selectRing.visible = sel !== null;
    if (sel !== null) {
      this.selectRing.position.copy(planetPos(sel));
      this.selectRing.scale.setScalar(this.planets[sel].size * 0.75);
    }
    this.hoverRing.visible = this.hovered !== null && this.hovered !== sel;
    if (this.hovered !== null) {
      this.hoverRing.position.copy(planetPos(this.hovered));
      this.hoverRing.scale.setScalar(this.planets[this.hovered].size * 0.75);
    }
  }

  private pick(ray: THREE.Raycaster): number | null {
    const hits = ray.intersectObjects(this.planets.map((p) => p.hit), false);
    return hits.length ? (hits[0].object.userData.planet as number) : null;
  }

  click(ray: THREE.Raycaster) {
    this.link.setPlanet(this.pick(ray));
  }

  contextClick(ray: THREE.Raycaster) {
    const p = this.pick(ray);
    if (p !== null) { this.link.setPlanet(p); this.link.moveShip(p); }
  }

  hover(ray: THREE.Raycaster) {
    const p = this.pick(ray);
    if (p !== this.hovered) { this.hovered = p; this.paint(); }
    return p !== null;
  }

  update({ t, dt }: FrameContext) {
    const m = this.engine.getState().mission;
    if (!m) return;
    const want = this.anchorOf(this.shipAt, t);
    let dir: THREE.Vector3;
    if (this.shipFrom && this.shipT < 1) {
      this.shipT = Math.min(1, this.shipT + dt / 2.2);
      const k = this.shipT * this.shipT * (3 - 2 * this.shipT);
      const next = this.shipFrom.clone().lerp(want, k);
      dir = next.clone().sub(this.shipPos);
      this.shipPos.copy(next);
    } else {
      dir = want.clone().sub(this.shipPos);
      this.shipPos.copy(want);
    }
    this.ship.position.copy(this.shipPos);
    if (dir.lengthSq() > 1e-6) this.ship.lookAt(this.shipPos.clone().add(dir));
    // course line to the destination
    this.path.visible = m.ship.dest !== null;
    if (m.ship.dest !== null) {
      const to = planetPos(m.ship.dest);
      this.path.geometry.setFromPoints([this.shipPos.clone(), to.setY(1)]);
      this.path.computeLineDistances();
    }
    for (const p of this.planets) p.group.children[1].rotation.z += dt * 0.01;
  }

  dispose() {
    this.disposed = true;
    for (const u of this.unsubs) u();
    for (const p of this.planets) p.label.element.remove();
    for (const d of this.disposables) d.dispose();
  }
}

/** Soft-edged disc, used to cut the square planet art into a round planet. */
function circleMask(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(128, 128, 92, 128, 128, 101); // the art's disc fills ~78% of the image
  grad.addColorStop(0, '#fff');
  grad.addColorStop(1, '#000');
  g.fillStyle = '#000';
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = grad;
  g.beginPath(); g.arc(128, 128, 101, 0, Math.PI * 2); g.fill();
  return new THREE.CanvasTexture(c);
}
