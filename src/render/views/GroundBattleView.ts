import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { Engine, GameState, GroundBattle, GroundUnit, UnitId } from '../../engine/index.ts';
import { FACTION_STYLE } from '../../theme.ts';
import { PlanetView, type SurfaceLink } from './PlanetView.ts';
import { loadUnitModels } from '../unitModels.ts';
import { glowTexture } from '../glow.ts';
import type { FrameContext, View } from '../View.ts';

/** How the ground battle view talks to the UI: selection in, orders out. */
export interface GroundLink {
  player: string;
  getSelection(): number[];
  setSelection(ids: number[]): void;
  move(ids: number[], x: number, y: number): void;
  attack(ids: number[], target: number): void;
  subscribe(fn: () => void): () => void;
}

const DRAG_PX = 6;

interface UnitView {
  id: number;
  kind: UnitId;
  faction: string;
  group: THREE.Group;
  model: THREE.Object3D | null;
  ring: THREE.Mesh;
  hit: THREE.Mesh;
  bar: CSS2DObject;
  pos: THREE.Vector2; // displayed cell coords
  facing: number;
  hp: number;
  maxHp: number;
  dead: number;
}

interface Fx { obj: THREE.Object3D; t: number; life: number; update: (k: number) => void; dispose: () => void }

/** Real-time invasion on a colony's surface. Terrain + buildings come from PlanetView. */
export class GroundBattleView implements View {
  root = new THREE.Group();
  preset: View['preset'];
  intro: View['intro'];
  backdrop: boolean;
  fog: View['fog'];
  bloom = 0.3;
  private planet: PlanetView;
  private engine: Engine;
  private link: GroundLink;
  private units = new Map<number, UnitView>();
  private models: Partial<Record<UnitId, THREE.Object3D>> = {};
  private lastShot = 0;
  private fx: Fx[] = [];
  private keys = new Set<string>();
  private box: HTMLDivElement;
  private marker: THREE.Mesh;
  private markerT = 9;
  private ringGeo = new THREE.RingGeometry(0.9, 1.25, 32);
  private hitGeo = new THREE.SphereGeometry(1.4, 8, 6);
  private hitMat = new THREE.MeshBasicMaterial({ visible: false });
  private unsubs: (() => void)[] = [];
  private disposed = false;

  constructor(engine: Engine, link: GroundLink) {
    this.engine = engine;
    this.link = link;
    const g = engine.getState().ground!;
    this.planet = new PlanetView(engine, quietSurfaceLink(g.colonyId));
    // open over the landing zone, close enough to read the troops
    const lz = g.units.filter((u) => u.faction === g.attacker);
    const cx = lz.reduce((n, u) => n + u.x, 0) / Math.max(1, lz.length), cy = lz.reduce((n, u) => n + u.y, 0) / Math.max(1, lz.length);
    const w = this.planet.world(cx, cy);
    this.preset = { ...this.planet.preset, target: [w.x, 0, w.z], position: [w.x, 34, w.z + 30], minDistance: 8 };
    this.intro = this.planet.intro;
    this.backdrop = this.planet.backdrop;
    this.fog = this.planet.fog;
    this.root.add(this.planet.root);
    this.ringGeo.rotateX(-Math.PI / 2);

    this.marker = new THREE.Mesh(new THREE.RingGeometry(0.6, 1.0, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0.4, 2.2, 1), transparent: true, depthWrite: false }));
    this.marker.visible = false;
    this.root.add(this.marker);

    this.box = document.createElement('div');
    this.box.className = 'select-box';
    document.body.appendChild(this.box);

    for (const u of g.units) if (u.alive) this.addUnit(u);
    this.lastShot = g.tick;
    loadUnitModels().then((m) => {
      if (this.disposed) return;
      this.models = m;
      for (const v of this.units.values()) this.applyModel(v);
    });
    this.unsubs.push(engine.subscribe((s, prev) => { if (s.ground && s.ground !== prev.ground) this.sync(s); }));
    this.unsubs.push(link.subscribe(() => this.paintSelection()));
  }

  private toWorld(x: number, y: number, lift = 0) {
    const w = this.planet.world(x, y);
    return new THREE.Vector3(w.x, this.planet.heightAt(x, y) + lift, w.z);
  }

  private addUnit(u: GroundUnit) {
    const color = new THREE.Color(FACTION_STYLE[u.faction].color);
    const group = new THREE.Group();
    const ring = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(1.4), transparent: true, opacity: 0.65, depthWrite: false }));
    ring.position.y = 0.12;
    ring.scale.setScalar(u.kind === 'tank' ? 1.5 : 1);
    const hit = new THREE.Mesh(this.hitGeo, this.hitMat);
    hit.position.y = 1;
    hit.userData.uid = u.id;
    const el = document.createElement('div');
    el.className = `gbar ${u.faction === this.link.player ? 'is-mine' : ''}`;
    el.style.setProperty('--fc', FACTION_STYLE[u.faction].color);
    el.innerHTML = '<i></i>';
    const bar = new CSS2DObject(el);
    bar.position.y = u.kind === 'tank' ? 3.2 : 3;
    group.add(ring, hit, bar);
    this.root.add(group);
    const v: UnitView = { id: u.id, kind: u.kind, faction: u.faction, group, model: null, ring, hit, bar, pos: new THREE.Vector2(u.x, u.y), facing: u.facing, hp: u.hp, maxHp: u.maxHp, dead: 0 };
    this.units.set(u.id, v);
    this.applyModel(v);
    this.paintBar(v);
  }

  private applyModel(v: UnitView) {
    if (v.model || !this.models[v.kind]) return;
    v.model = this.models[v.kind]!.clone(true);
    v.group.add(v.model);
  }

  private paintBar(v: UnitView) {
    const el = v.bar.element;
    (el.firstChild as HTMLElement).style.width = `${(v.hp / v.maxHp) * 100}%`;
    const sel = this.link.getSelection().includes(v.id);
    el.classList.toggle('show', sel || v.hp < v.maxHp);
  }

  private paintSelection() {
    const sel = new Set(this.link.getSelection());
    for (const v of this.units.values()) {
      const on = sel.has(v.id);
      (v.ring.material as THREE.MeshBasicMaterial).opacity = on ? 1 : 0.55;
      (v.ring.material as THREE.MeshBasicMaterial).color.set(on ? new THREE.Color(0.6, 2.4, 1.2) : new THREE.Color(FACTION_STYLE[v.faction as keyof typeof FACTION_STYLE].color).multiplyScalar(1.4));
      this.paintBar(v);
    }
  }

  private sync(s: GameState) {
    const g = s.ground!;
    const byId = new Map(g.units.map((u) => [u.id, u]));
    for (const v of this.units.values()) {
      const u = byId.get(v.id);
      if (!u) continue;
      v.hp = u.hp;
      v.facing = u.facing;
      if (!u.alive && !v.dead) v.dead = 0.001;
      this.paintBar(v);
    }
    for (const shot of g.shots) {
      if (shot.tick <= this.lastShot) continue;
      this.shot(shot.from, shot.to, shot.kill, g);
    }
    this.lastShot = g.tick;
    // drop dead units from the selection
    const sel = this.link.getSelection();
    const alive = sel.filter((id) => byId.get(id)?.alive);
    if (alive.length !== sel.length) this.link.setSelection(alive);
  }


  private shot(from: number, to: number, kill: boolean, g: GroundBattle) {
    const a = this.units.get(from), b = this.units.get(to);
    if (!a || !b) return;
    const big = a.kind === 'tank';
    const color = new THREE.Color(FACTION_STYLE[a.faction as keyof typeof FACTION_STYLE].color).multiplyScalar(3);
    const p0 = this.toWorld(a.pos.x, a.pos.y, big ? 1.6 : 1.5);
    const p1 = this.toWorld(b.pos.x, b.pos.y, 1.1);
    const geo = new THREE.BufferGeometry().setFromPoints([p0, p1]);
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const line = new THREE.Line(geo, mat);
    const flash = this.sprite(color, p1, big ? 3.5 : 1.8);
    const muzzle = this.sprite(color, p0, big ? 2.5 : 1.2);
    const grp = new THREE.Group();
    grp.add(line, flash, muzzle);
    this.root.add(grp);
    this.fx.push({
      obj: grp, t: 0, life: big ? 0.35 : 0.18,
      update: (k) => { mat.opacity = 1 - k; (flash.material as THREE.SpriteMaterial).opacity = 1 - k; (muzzle.material as THREE.SpriteMaterial).opacity = 1 - k; },
      dispose: () => { geo.dispose(); mat.dispose(); (flash.material as THREE.Material).dispose(); (muzzle.material as THREE.Material).dispose(); },
    });
    if (kill) {
      const boom = this.sprite(new THREE.Color(3, 1.5, 0.5), p1, 1);
      this.root.add(boom);
      const size = b.kind === 'tank' ? 9 : 5;
      this.fx.push({
        obj: boom, t: 0, life: 0.8,
        update: (k) => { boom.scale.setScalar(size * (0.3 + k)); (boom.material as THREE.SpriteMaterial).opacity = 1 - k; },
        dispose: () => (boom.material as THREE.Material).dispose(),
      });
    }
    void g;
  }

  private sprite(color: THREE.Color, at: THREE.Vector3, size: number) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    s.position.copy(at);
    s.scale.setScalar(size);
    return s;
  }

  // ------------------------------------------------------------ input

  private pickUnit(ray: THREE.Raycaster): number | null {
    const hits = ray.intersectObjects([...this.units.values()].filter((v) => !v.dead).map((v) => v.hit), false);
    return hits.length ? (hits[0].object.userData.uid as number) : null;
  }

  private groundCell(ray: THREE.Raycaster) {
    const hit = ray.intersectObject(this.planet.terrainMesh, false)[0];
    if (!hit) return null;
    const s = this.planet.surfaceInfo;
    return { x: hit.point.x / 4 + (s.w - 1) / 2, y: hit.point.z / 4 + (s.h - 1) / 2 };
  }

  click(ray: THREE.Raycaster) {
    const id = this.pickUnit(ray);
    const v = id === null ? null : this.units.get(id);
    if (v && v.faction === this.link.player) {
      if (this.keys.has('Shift')) {
        const sel = this.link.getSelection();
        this.link.setSelection(sel.includes(v.id) ? sel.filter((x) => x !== v.id) : [...sel, v.id]);
      } else this.link.setSelection([v.id]);
    } else if (!v) this.link.setSelection([]);
  }

  contextClick(ray: THREE.Raycaster) {
    const sel = this.link.getSelection();
    if (!sel.length) return;
    const id = this.pickUnit(ray);
    const v = id === null ? null : this.units.get(id);
    if (v && v.faction !== this.link.player) return this.link.attack(sel, v.id);
    const c = this.groundCell(ray);
    if (!c) return;
    this.link.move(sel, c.x, c.y);
    this.marker.position.copy(this.toWorld(c.x, c.y, 0.2));
    this.markerT = 0;
  }

  attach(canvas: HTMLCanvasElement, camera: THREE.PerspectiveCamera) {
    let start: { x: number; y: number } | null = null;
    // Alt + left-drag rotates the camera (Stage), so it never starts a selection box
    const down = (e: PointerEvent) => { if (e.button === 0 && !e.altKey) start = { x: e.clientX, y: e.clientY }; };
    const move = (e: PointerEvent) => {
      if (!start) return;
      const w = Math.abs(e.clientX - start.x), h = Math.abs(e.clientY - start.y);
      if (w < DRAG_PX && h < DRAG_PX) return;
      Object.assign(this.box.style, { display: 'block', left: `${Math.min(e.clientX, start.x)}px`, top: `${Math.min(e.clientY, start.y)}px`, width: `${w}px`, height: `${h}px` });
    };
    const up = (e: PointerEvent) => {
      if (!start || e.button !== 0) return;
      const s = start;
      start = null;
      this.box.style.display = 'none';
      if (Math.abs(e.clientX - s.x) < DRAG_PX && Math.abs(e.clientY - s.y) < DRAG_PX) return; // a click: Stage handles it
      const r = canvas.getBoundingClientRect();
      const x0 = Math.min(s.x, e.clientX), x1 = Math.max(s.x, e.clientX), y0 = Math.min(s.y, e.clientY), y1 = Math.max(s.y, e.clientY);
      const ids: number[] = [];
      const p = new THREE.Vector3();
      for (const v of this.units.values()) {
        if (v.dead || v.faction !== this.link.player) continue;
        p.copy(v.group.position).setY(v.group.position.y + 1).project(camera);
        const sx = r.left + ((p.x + 1) / 2) * r.width, sy = r.top + ((1 - p.y) / 2) * r.height;
        if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) ids.push(v.id);
      }
      if (this.keys.has('Shift')) this.link.setSelection([...new Set([...this.link.getSelection(), ...ids])]);
      else this.link.setSelection(ids);
    };
    const kd = (e: KeyboardEvent) => {
      this.keys.add(e.key.length === 1 ? e.key.toLowerCase() : e.key);
      if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.link.setSelection([...this.units.values()].filter((v) => !v.dead && v.faction === this.link.player).map((v) => v.id));
      }
    };
    const ku = (e: KeyboardEvent) => this.keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key);
    const blur = () => this.keys.clear();
    canvas.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    window.addEventListener('blur', blur);
    return () => {
      canvas.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', kd);
      window.removeEventListener('keyup', ku);
      window.removeEventListener('blur', blur);
    };
  }

  hover(ray: THREE.Raycaster) {
    return this.pickUnit(ray) !== null;
  }

  // ------------------------------------------------------------ frame

  update(ctx: FrameContext) {
    const { dt } = ctx;
    this.planet.update(ctx);

    const g = this.engine.getState().ground;
    const byId = new Map((g?.units ?? []).map((u) => [u.id, u]));
    const lerp = 1 - Math.exp(-dt * 14);
    for (const [id, v] of [...this.units]) {
      const u = byId.get(id);
      if (u) v.pos.lerp(new THREE.Vector2(u.x, u.y), lerp);
      const p = this.toWorld(v.pos.x, v.pos.y, v.kind === 'tank' ? 0.35 : 0);
      v.group.position.copy(p);
      if (v.model) {
        const want = -v.facing;
        let cur = v.model.rotation.y;
        const diff = Math.atan2(Math.sin(want - cur), Math.cos(want - cur));
        cur += diff * Math.min(1, dt * 10);
        v.model.rotation.y = cur;
        if (v.kind === 'tank') v.model.position.y = Math.sin(ctx.t * 3 + id) * 0.08;
      }
      if (v.dead) {
        v.dead += dt;
        v.group.scale.setScalar(Math.max(0.01, 1 - v.dead * 1.5));
        v.group.position.y -= v.dead * 1.5;
        if (v.dead > 0.7) {
          this.root.remove(v.group);
          v.bar.element.remove();
          (v.ring.material as THREE.Material).dispose();
          this.units.delete(id);
        }
      }
    }
    for (const f of [...this.fx]) {
      f.t += dt;
      const kk = Math.min(1, f.t / f.life);
      f.update(kk);
      if (kk >= 1) { this.root.remove(f.obj); f.dispose(); this.fx.splice(this.fx.indexOf(f), 1); }
    }
    this.markerT += dt;
    this.marker.visible = this.markerT < 0.6;
    if (this.marker.visible) {
      this.marker.scale.setScalar(1 + this.markerT * 1.5);
      (this.marker.material as THREE.MeshBasicMaterial).opacity = 1 - this.markerT / 0.6;
    }
  }

  dispose() {
    this.disposed = true;
    for (const u of this.unsubs) u();
    this.box.remove();
    for (const v of this.units.values()) { v.bar.element.remove(); (v.ring.material as THREE.Material).dispose(); }
    for (const f of this.fx) { this.root.remove(f.obj); f.dispose(); }
    this.planet.dispose();
    for (const d of [this.ringGeo, this.hitGeo, this.hitMat, this.marker.geometry, this.marker.material as THREE.Material]) d.dispose();
  }
}

/** The surface view in "battle mode": no placement, no structure selection. */
function quietSurfaceLink(colonyId: string): SurfaceLink {
  return {
    colonyId, getPlacing: () => null, setPlacing: () => {}, place: () => {},
    getStructure: () => null, setStructure: () => {}, subscribe: () => () => {},
  };
}
