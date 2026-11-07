import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import {
  BATTLE_H, BATTLE_W, reachableCells, targetsInRange,
  type Battle, type BattleAction, type BattleUnit, type Engine, type GameState,
} from '../../engine/index.ts';
import { FACTION_STYLE, STAR_STYLE } from '../../theme.ts';
import { loadShipModels, makeShip } from '../shipModels.ts';
import { glowTexture } from '../glow.ts';
import type { CameraPreset, FrameContext, View } from '../View.ts';

/** How the battle view talks to the UI: selection in, orders out. */
export interface BattleLink {
  player: string;
  getSelected(): number | null;
  setSelected(uid: number | null): void;
  move(uid: number, x: number, y: number): void;
  fire(uid: number, target: number): void;
  subscribe(fn: () => void): () => void;
  /** The view reports whether it is still animating (UI disables orders meanwhile). */
  setBusy(busy: boolean): void;
  /** Fires when the player asks to skip the current playback. */
  onSkip(fn: () => void): () => void;
}

const CELL = 5;
const SHIP_LEN = 4.4;
const MOVE_S = 0.5;
const SHOT_S = 0.55;

interface UnitView {
  u: BattleUnit;
  group: THREE.Group;
  model: THREE.Group | null;
  hit: THREE.Mesh;
  bar: CSS2DObject;
  pos: THREE.Vector3;
  from: THREE.Vector3 | null;
  moveT: number;
  dying: number; // >0 while exploding
}

interface Fx { obj: THREE.Object3D; t: number; life: number; update: (k: number) => void; dispose: () => void }

/** Turn-based tactical space battle: grid, asteroids, ships, beams, explosions. Plays the battle log as animation. */
export class SpaceBattleView implements View {
  root = new THREE.Group();
  preset: CameraPreset = {
    position: [0, 40, 44], target: [0, 0, 3],
    minDistance: 25, maxDistance: 120, maxPolarAngle: Math.PI * 0.45, autoRotateSpeed: 0,
  };
  intro: View['intro'] = { from: [-60, 30, 90], seconds: 2.2 };
  private engine: Engine;
  private link: BattleLink;
  private units = new Map<number, UnitView>();
  private models: Awaited<ReturnType<typeof loadShipModels>> = {};
  private played = 0;
  private queue: BattleAction[] = [];
  /** Playback speed of the current batch: big batches (enemy rounds, auto-resolve) play fast. */
  private speed = 1;
  private current: { a: BattleAction; t: number; dur: number } | null = null;
  private fx: Fx[] = [];
  private tiles: THREE.InstancedMesh;
  private targetRings: THREE.InstancedMesh;
  private selRing: THREE.Mesh;
  private plane: THREE.Mesh;
  private disposables: { dispose(): void }[] = [];
  private unsubs: (() => void)[] = [];
  private now = 0;
  private disposed = false;

  constructor(engine: Engine, link: BattleLink) {
    this.engine = engine;
    this.link = link;
    const b = engine.getState().battle!;
    const sys = engine.getState().galaxy!.systems[b.systemId];

    // lights
    const key = new THREE.DirectionalLight(0xfff0d8, 2);
    key.position.set(-30, 50, 20);
    const rim = new THREE.DirectionalLight(0x6fc8ff, 1.2);
    rim.position.set(30, 10, -40);
    this.root.add(new THREE.HemisphereLight(0x8fb4ff, 0x140c1c, 0.5), key, rim);

    // the system's star, far behind the field
    const starColor = new THREE.Color(STAR_STYLE[sys.star].color);
    const star = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: starColor.clone().multiplyScalar(2.5), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    star.position.set(-25, 12, -150);
    star.scale.setScalar(90);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: starColor, opacity: 0.35, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    halo.position.copy(star.position);
    halo.scale.setScalar(260);
    this.root.add(this.track(star), this.track(halo));

    // tactical grid
    const w = BATTLE_W * CELL, h = BATTLE_H * CELL;
    this.plane = this.track(new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ visible: false })));
    this.plane.rotation.x = -Math.PI / 2;
    this.root.add(this.plane);
    const pts: number[] = [];
    for (let x = 0; x <= BATTLE_W; x++) pts.push(x * CELL - w / 2, 0, -h / 2, x * CELL - w / 2, 0, h / 2);
    for (let y = 0; y <= BATTLE_H; y++) pts.push(-w / 2, 0, y * CELL - h / 2, w / 2, 0, y * CELL - h / 2);
    const gridGeo = new THREE.BufferGeometry();
    gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const gridLines = new THREE.LineSegments(gridGeo, new THREE.LineBasicMaterial({ color: 0x3fb8e8, transparent: true, opacity: 0.22, depthWrite: false }));
    gridLines.position.y = -0.6;
    this.root.add(this.track(gridLines));
    const frame = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: 0x0a2a3e, transparent: true, opacity: 0.18, depthWrite: false }));
    frame.rotation.x = -Math.PI / 2;
    frame.position.y = -0.65;
    this.root.add(this.track(frame));

    // asteroids
    for (const i of b.rocks) {
      const rock = makeRock(i);
      const c = this.cell(i % BATTLE_W, Math.floor(i / BATTLE_W));
      rock.position.set(c.x, 0, c.z);
      this.root.add(this.track(rock));
    }

    // reachable tiles + target rings (instanced, re-filled on selection)
    const tileGeo = new THREE.PlaneGeometry(CELL * 0.9, CELL * 0.9);
    tileGeo.rotateX(-Math.PI / 2);
    this.tiles = this.track(new THREE.InstancedMesh(tileGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 1.3, 0.6), transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending }), BATTLE_W * BATTLE_H));
    this.tiles.count = 0;
    this.tiles.position.y = -0.55;
    const ringGeo = new THREE.RingGeometry(CELL * 0.42, CELL * 0.5, 40);
    ringGeo.rotateX(-Math.PI / 2);
    this.targetRings = this.track(new THREE.InstancedMesh(ringGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 0.4, 0.3), transparent: true, depthWrite: false, side: THREE.DoubleSide }), 64));
    this.targetRings.count = 0;
    this.targetRings.position.y = -0.5;
    this.selRing = this.track(new THREE.Mesh(ringGeo.clone(), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.6, 2.2, 2.6), transparent: true, depthWrite: false, side: THREE.DoubleSide })));
    this.selRing.position.y = -0.45;
    this.selRing.visible = false;
    this.root.add(this.tiles, this.targetRings, this.selRing);

    // units
    for (const u of b.units) if (u.alive) this.addUnit(u);
    this.played = b.log.length;
    loadShipModels().then((m) => {
      if (this.disposed) return;
      this.models = m;
      for (const v of this.units.values()) this.applyModel(v);
    });

    this.unsubs.push(engine.subscribe((s, prev) => {
      if (s.battle && s.battle !== prev.battle) this.onBattle(s);
    }));
    this.unsubs.push(link.subscribe(() => this.refreshHighlights()));
    this.unsubs.push(link.onSkip(() => this.skip()));
    this.refreshHighlights();
  }

  private track<T extends THREE.Object3D>(obj: T): T {
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) this.disposables.push(m.geometry);
      if (m.material) this.disposables.push(...([] as THREE.Material[]).concat(m.material));
    });
    return obj;
  }

  private cell(x: number, y: number) {
    return { x: (x + 0.5) * CELL - (BATTLE_W * CELL) / 2, z: (y + 0.5) * CELL - (BATTLE_H * CELL) / 2 };
  }

  private addUnit(u: BattleUnit) {
    const c = this.cell(u.x, u.y);
    const group = new THREE.Group();
    group.position.set(c.x, 0, c.z);
    group.rotation.y = u.faction === this.link.player ? Math.PI / 2 : -Math.PI / 2; // face the enemy line
    const hit = new THREE.Mesh(new THREE.SphereGeometry(CELL * 0.45, 8, 6), new THREE.MeshBasicMaterial({ visible: false }));
    hit.userData.uid = u.uid;
    this.disposables.push(hit.geometry, hit.material as THREE.Material);
    group.add(hit);
    const el = document.createElement('div');
    el.className = `unit-bar ${u.faction === this.link.player ? 'is-mine' : ''}`;
    el.style.setProperty('--fc', FACTION_STYLE[u.faction].color);
    el.innerHTML = '<div class="hp"><i></i></div><div class="sh"><i></i></div>';
    const bar = new CSS2DObject(el);
    bar.position.set(0, 3.2, 0);
    group.add(bar);
    this.root.add(group);
    const v: UnitView = { u: { ...u }, group, model: null, hit, bar, pos: group.position.clone(), from: null, moveT: 0, dying: 0 };
    this.units.set(u.uid, v);
    this.applyModel(v);
    this.paintBar(v);
  }

  private applyModel(v: UnitView) {
    if (v.model) return;
    const t = this.models[v.u.ship];
    if (!t) return;
    v.model = makeShip(t, v.u.ship, new THREE.Color(FACTION_STYLE[v.u.faction].color));
    v.model.scale.setScalar(SHIP_LEN * (v.u.ship === 'scout' ? 0.75 : 1));
    v.group.add(v.model);
  }

  private paintBar(v: UnitView) {
    const el = v.bar.element;
    (el.querySelector('.hp i') as HTMLElement).style.width = `${(v.u.hp / v.u.maxHp) * 100}%`;
    const sh = el.querySelector('.sh') as HTMLElement;
    sh.style.display = v.u.faction === 'apex' ? '' : 'none';
    (sh.firstChild as HTMLElement).style.width = `${(v.u.shield / 3) * 100}%`;
  }

  /** New battle state: queue the new log entries for playback. */
  private onBattle(s: GameState) {
    const b = s.battle!;
    if (b.log.length < this.played) this.played = 0; // a different battle
    const fresh = b.log.slice(this.played);
    this.queue.push(...fresh);
    this.played = b.log.length;
    this.speed = this.queue.length > 20 ? 8 : this.queue.length > 6 ? 2 : 1;
    this.link.setBusy(this.queue.length > 0 || !!this.current);
    this.refreshHighlights();
  }

  private refreshHighlights() {
    const b = this.engine.getState().battle;
    const sel = this.link.getSelected();
    const idle = !this.current && !this.queue.length;
    this.tiles.count = 0;
    this.targetRings.count = 0;
    this.selRing.visible = false;
    if (!b || b.over || !idle || sel === null) return;
    const v = this.units.get(sel);
    if (!v) return;
    this.selRing.visible = true;
    this.selRing.position.set(v.pos.x, -0.45, v.pos.z);
    const m = new THREE.Matrix4();
    reachableCells(b, sel).forEach((c, i) => {
      const p = this.cell(c.x, c.y);
      this.tiles.setMatrixAt(i, m.makeTranslation(p.x, 0, p.z));
      this.tiles.count = i + 1;
    });
    targetsInRange(b, sel).forEach((t, i) => {
      const p = this.cell(t.x, t.y);
      this.targetRings.setMatrixAt(i, m.makeTranslation(p.x, 0, p.z));
      this.targetRings.count = i + 1;
    });
    this.tiles.instanceMatrix.needsUpdate = true;
    this.targetRings.instanceMatrix.needsUpdate = true;
  }

  // ------------------------------------------------------------ playback

  private startAction(a: BattleAction) {
    let dur = 0.05;
    if (a.t === 'move') {
      const v = this.units.get(a.uid);
      if (v) {
        v.from = v.pos.clone();
        v.moveT = 0;
        v.u.x = a.x;
        v.u.y = a.y;
        dur = MOVE_S;
      }
    } else if (a.t === 'fire') {
      const s = this.units.get(a.uid), t = this.units.get(a.target);
      if (s && t) {
        this.beam(s, t, a.dmg, a.absorbed);
        t.u.hp = Math.max(0, t.u.hp - a.dmg);
        t.u.shield = Math.max(0, t.u.shield - a.absorbed);
        this.paintBar(t);
        dur = SHOT_S;
      }
    } else if (a.t === 'destroyed') {
      const v = this.units.get(a.uid);
      if (v) {
        this.explode(v.pos);
        v.dying = 0.001;
        dur = 0.6;
      }
    } else if (a.t === 'repair') {
      const v = this.units.get(a.uid);
      if (v) {
        v.u.hp += a.amount;
        this.paintBar(v);
        this.floatText(v.pos, `+${a.amount}`, 'repair');
      }
    } else if (a.t === 'round') {
      for (const v of this.units.values()) if (v.u.faction === 'apex') { v.u.shield = 3; this.paintBar(v); }
    }
    this.current = { a, t: 0, dur };
  }

  private beam(s: UnitView, t: UnitView, dmg: number, absorbed: number) {
    const color = new THREE.Color(FACTION_STYLE[s.u.faction].color).multiplyScalar(3);
    const from = s.pos.clone().add(new THREE.Vector3(0, 0.6, 0));
    const to = t.pos.clone().add(new THREE.Vector3(0, 0.6, 0));
    const dir = to.clone().sub(from);
    const len = dir.length();
    const geo = new THREE.CylinderGeometry(0.12, 0.12, len, 6, 1, true);
    geo.rotateX(Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const beam = new THREE.Mesh(geo, mat);
    beam.position.copy(from).addScaledVector(dir, 0.5);
    beam.lookAt(to);
    const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    flash.position.copy(to);
    const g = new THREE.Group();
    g.add(beam, flash);
    this.root.add(g);
    this.fx.push({
      obj: g, t: 0, life: 0.45,
      update: (k) => { mat.opacity = 1 - k; (flash.material as THREE.SpriteMaterial).opacity = 1 - k; flash.scale.setScalar(2 + k * 4); },
      dispose: () => { geo.dispose(); mat.dispose(); (flash.material as THREE.Material).dispose(); },
    });
    if (absorbed) this.floatText(t.pos, `◈${absorbed}`, 'shield');
    this.floatText(t.pos, dmg ? `−${dmg}` : 'miss', dmg ? 'dmg' : 'miss');
  }

  private explode(at: THREE.Vector3) {
    const mk = (color: THREE.Color, size: number, life: number) => {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      sp.position.copy(at);
      this.root.add(sp);
      this.fx.push({
        obj: sp, t: 0, life,
        update: (k) => { sp.scale.setScalar(size * (0.3 + k)); (sp.material as THREE.SpriteMaterial).opacity = 1 - k; },
        dispose: () => (sp.material as THREE.Material).dispose(),
      });
    };
    mk(new THREE.Color(3, 1.6, 0.6), 12, 0.9);
    mk(new THREE.Color(2.5, 2.5, 2.5), 6, 0.35);
    // debris
    const n = 40, pos = new Float32Array(n * 3), vel: THREE.Vector3[] = [];
    for (let i = 0; i < n; i++) vel.push(new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5).normalize().multiplyScalar(4 + Math.random() * 6));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ color: new THREE.Color(2.5, 1.2, 0.4), size: 0.5, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const pts = new THREE.Points(geo, mat);
    pts.position.copy(at);
    this.root.add(pts);
    this.fx.push({
      obj: pts, t: 0, life: 1.4,
      update: (k) => {
        for (let i = 0; i < n; i++) pos.set([vel[i].x * k, vel[i].y * k, vel[i].z * k], i * 3);
        geo.attributes.position.needsUpdate = true;
        mat.opacity = 1 - k;
      },
      dispose: () => { geo.dispose(); mat.dispose(); },
    });
  }

  private floatText(at: THREE.Vector3, text: string, kind: string) {
    const el = document.createElement('div');
    const span = document.createElement('span');
    span.className = `float-num ${kind}`; // animate the inner span: CSS2DRenderer owns the outer transform
    span.textContent = text;
    el.appendChild(span);
    const obj = new CSS2DObject(el);
    obj.position.copy(at).add(new THREE.Vector3(0, 4.5, 0));
    this.root.add(obj);
    this.fx.push({ obj, t: 0, life: 1.1, update: () => {}, dispose: () => el.remove() });
  }

  // ------------------------------------------------------------ input

  private pickUnit(ray: THREE.Raycaster): number | null {
    const hits = ray.intersectObjects([...this.units.values()].filter((v) => !v.dying).map((v) => v.hit), false);
    return hits.length ? (hits[0].object.userData.uid as number) : null;
  }

  private pickCell(ray: THREE.Raycaster) {
    const hit = ray.intersectObject(this.plane, false)[0];
    if (!hit) return null;
    const x = Math.floor((hit.point.x + (BATTLE_W * CELL) / 2) / CELL), y = Math.floor((hit.point.z + (BATTLE_H * CELL) / 2) / CELL);
    return x >= 0 && y >= 0 && x < BATTLE_W && y < BATTLE_H ? { x, y } : null;
  }

  click(ray: THREE.Raycaster) {
    const b = this.engine.getState().battle;
    if (!b || b.over || this.current || this.queue.length || b.active !== this.link.player) return;
    const sel = this.link.getSelected();
    const uid = this.pickUnit(ray);
    const unit = uid === null ? null : b.units.find((u) => u.uid === uid && u.alive);
    if (unit && unit.faction !== this.link.player && sel !== null) {
      if (targetsInRange(b, sel).some((t) => t.uid === unit.uid)) return this.link.fire(sel, unit.uid);
    }
    if (unit && unit.faction === this.link.player) return this.link.setSelected(unit.uid);
    const c = this.pickCell(ray);
    if (c && sel !== null && reachableCells(b, sel).some((r) => r.x === c.x && r.y === c.y)) return this.link.move(sel, c.x, c.y);
    this.link.setSelected(null);
  }

  hover(ray: THREE.Raycaster) {
    return this.pickUnit(ray) !== null;
  }

  // ------------------------------------------------------------ frame

  update({ dt, t }: FrameContext) {
    this.now = t;
    // playback queue
    if (!this.current && this.queue.length) this.startAction(this.queue.shift()!);
    if (this.current) {
      this.current.t += dt * this.speed;
      if (this.current.t >= this.current.dur) {
        this.current = null;
        if (!this.queue.length) {
          this.reconcile();
          this.link.setBusy(false);
          this.refreshHighlights();
        }
      }
    }
    for (const [uid, v] of this.units) {
      if (v.from) {
        v.moveT = Math.min(1, v.moveT + (dt / MOVE_S) * this.speed);
        const c = this.cell(v.u.x, v.u.y);
        const e = v.moveT < 0.5 ? 2 * v.moveT * v.moveT : 1 - Math.pow(-2 * v.moveT + 2, 2) / 2;
        v.pos.set(v.from.x + (c.x - v.from.x) * e, 0, v.from.z + (c.z - v.from.z) * e);
        if (v.moveT >= 1) v.from = null;
      }
      v.group.position.set(v.pos.x, Math.sin(t * 1.3 + uid) * 0.25, v.pos.z);
      if (v.dying) {
        v.dying += dt;
        v.group.scale.setScalar(Math.max(0.01, 1 - v.dying * 2.5));
        if (v.dying > 0.4) {
          this.root.remove(v.group);
          v.bar.element.remove();
          this.units.delete(uid);
        }
      }
    }
    for (const f of [...this.fx]) {
      f.t += dt;
      const k = Math.min(1, f.t / f.life);
      f.update(k);
      if (k >= 1) {
        this.root.remove(f.obj);
        f.dispose();
        this.fx.splice(this.fx.indexOf(f), 1);
      }
    }
    if (this.selRing.visible) (this.selRing.material as THREE.MeshBasicMaterial).opacity = 0.7 + 0.3 * Math.sin(t * 5);
  }

  /** Jump to the end of the playback. */
  private skip() {
    this.queue = [];
    this.current = null;
    for (const v of this.units.values()) v.from = null;
    this.reconcile();
    this.link.setBusy(false);
    this.refreshHighlights();
  }

  /** After playback, snap to the authoritative engine state. */
  private reconcile() {
    const b = this.engine.getState().battle;
    if (!b) return;
    for (const u of b.units) {
      const v = this.units.get(u.uid);
      if (!v) continue;
      if (!u.alive) {
        if (!v.dying) v.dying = 0.001;
        continue;
      }
      v.u = { ...u };
      if (!v.from) {
        const c = this.cell(u.x, u.y);
        v.pos.set(c.x, 0, c.z);
      }
      this.paintBar(v);
    }
  }

  dispose() {
    this.disposed = true;
    for (const u of this.unsubs) u();
    for (const v of this.units.values()) v.bar.element.remove();
    for (const f of this.fx) { this.root.remove(f.obj); f.dispose(); }
    for (const d of this.disposables) d.dispose();
  }
}

function makeRock(seed: number): THREE.Mesh {
  const geo = new THREE.IcosahedronGeometry(1.8 + (seed % 3) * 0.4, 1);
  const p = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const k = 0.75 + 0.5 * Math.abs(Math.sin(seed * 12.9 + i * 78.2));
    p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * 0.8, p.getZ(i) * k);
  }
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x4a433d, roughness: 0.95, flatShading: true }));
  m.rotation.set(seed, seed * 2.1, seed * 0.7);
  return m;
}
