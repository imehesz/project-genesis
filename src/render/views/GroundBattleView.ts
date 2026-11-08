import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { sightOf, xpRank, type Engine, type GameState, type GroundUnit, type Shot, type UnitId } from '../../engine/index.ts';
import { FACTION_STYLE } from '../../theme.ts';
import { PlanetView, type SurfaceLink } from './PlanetView.ts';
import { instantiate, loadUnitModels, type UnitModel } from '../unitModels.ts';
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

/** What a ground view draws: the units and shots of an invasion or of a planet mission. */
export interface GroundScene { colonyId: string; units: GroundUnit[]; shots: Shot[]; tick: number }

/** Where the view reads its units from, and the extras a planet mission adds. */
export interface GroundSource {
  get(s: GameState): GroundScene | null;
  /** Placement + structure selection on the surface (planet missions). Default: battle mode, none. */
  surface?: SurfaceLink;
  /** Cell to open the camera over. Default: the invaders' landing zone. */
  focus?: { x: number; y: number };
  /** false hides a unit (fog of war). */
  shows?(u: GroundUnit): boolean;
}

const battleSource: GroundSource = { get: (s) => s.ground };

/** The ancient defences' colour (towers, their beams). */
export const ANCIENT_COLOR = '#46ffd2';
const SHOT_MINE = '#3fa9ff';
const SHOT_ENEMY = '#ff3b30';
/** The commander's selection ring. */
const COMMANDER_COLOR = '#ffc95a';

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
  anim: UnitAnim | null;
  rank: number;
}

type AnimState = 'Idle' | 'Walk' | 'Shoot' | 'Hit' | 'Die';

/** Skeletal animation for rigged units (clip contract Idle / Walk / Shoot / Hit / Die, see unitModels.ts). */
interface UnitAnim {
  mixer: THREE.AnimationMixer;
  actions: Partial<Record<AnimState, THREE.AnimationAction>>;
  state: AnimState;
  /** Walk clip ground speed at timeScale 1 (world units / s). */
  walkSpeed: number;
  /** Smoothed displayed ground speed (world units / s). */
  speed: number;
  last: THREE.Vector3 | null;
  /** A one-shot (Shoot / Hit) is playing until this mixer time. */
  busyUntil: number;
  gun: THREE.Object3D | null;
}

const ONE_SHOT: AnimState[] = ['Shoot', 'Hit', 'Die'];

/** Range outlines under the selection: weapon range (solid) and sight (dashed). */
interface RangeRings { fire: THREE.Mesh; sight: THREE.Mesh }
const RING_SEGMENTS = 96;
const RING_WIDTH = 0.22; // world units
const FIRE_COLOR = new THREE.Color('#ff6a45').multiplyScalar(1.3);
const SIGHT_COLOR = new THREE.Color('#7fd8ff');
/** Infantry armour: faction colour pulled toward gunmetal so it reads as painted plate, not plastic. */
const ARMOR_BASE = new THREE.Color('#4a5059');

interface Fx { obj: THREE.Object3D; t: number; life: number; update: (k: number) => void; dispose: () => void }

/** Real-time invasion on a colony's surface. Terrain + buildings come from PlanetView. */
export class GroundBattleView implements View {
  root = new THREE.Group();
  preset: View['preset'];
  intro: View['intro'];
  backdrop: boolean;
  fog: View['fog'];
  bloom = 0.3;
  protected planet: PlanetView;
  protected engine: Engine;
  protected link: GroundLink;
  protected src: GroundSource;
  protected units = new Map<number, UnitView>();
  private models: Partial<Record<UnitId, UnitModel>> = {};
  private tinted = new Map<string, THREE.Material>();
  private rings: RangeRings | null = null;
  private ringKey = '';
  private fireMat = new THREE.MeshBasicMaterial({ color: FIRE_COLOR, transparent: true, opacity: 0.4, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
  private sightMat = new THREE.MeshBasicMaterial({ color: SIGHT_COLOR, transparent: true, opacity: 0.25, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
  private lastShot = 0;
  private fx: Fx[] = [];
  private keys = new Set<string>();
  private box: HTMLDivElement;
  protected marker: THREE.Mesh;
  protected markerT = 9;
  private ringGeo = new THREE.RingGeometry(0.9, 1.25, 32);
  private hitGeo = new THREE.SphereGeometry(1.4, 8, 6);
  private hitMat = new THREE.MeshBasicMaterial({ visible: false });
  private unsubs: (() => void)[] = [];
  private disposed = false;

  constructor(engine: Engine, link: GroundLink, source: GroundSource = battleSource) {
    this.engine = engine;
    this.link = link;
    this.src = source;
    const g = source.get(engine.getState())!;
    this.planet = new PlanetView(engine, source.surface ?? quietSurfaceLink(g.colonyId));
    // open over the landing zone, close enough to read the troops
    let focus = source.focus;
    if (!focus) {
      const inv = engine.getState().ground;
      const lz = g.units.filter((u) => u.faction === (inv?.attacker ?? link.player));
      focus = { x: lz.reduce((n, u) => n + u.x, 0) / Math.max(1, lz.length), y: lz.reduce((n, u) => n + u.y, 0) / Math.max(1, lz.length) };
    }
    const w = this.planet.world(focus.x, focus.y);
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
    this.unsubs.push(engine.subscribe((s, prev) => { const a = this.src.get(s); if (a && a !== this.src.get(prev)) this.sync(s); }));
    this.unsubs.push(link.subscribe(() => this.paintSelection()));
  }

  toWorld(x: number, y: number, lift = 0) {
    const w = this.planet.world(x, y);
    return new THREE.Vector3(w.x, this.planet.heightAt(x, y) + lift, w.z);
  }

  private ringColor(v: { kind: UnitId; faction: string }) {
    if (v.kind === 'tower') return new THREE.Color(ANCIENT_COLOR);
    if (v.kind === 'commander') return new THREE.Color(COMMANDER_COLOR);
    return new THREE.Color(FACTION_STYLE[v.faction as keyof typeof FACTION_STYLE].color);
  }

  private addUnit(u: GroundUnit) {
    const color = this.ringColor(u);
    const group = new THREE.Group();
    const ring = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(1.1), transparent: true, opacity: 0.55, depthWrite: false }));
    ring.position.y = 0.12;
    ring.scale.setScalar(u.kind === 'tank' ? 1.15 : u.kind === 'tower' ? 1.3 : u.kind === 'commander' ? 0.68 : 0.6);
    const hit = new THREE.Mesh(this.hitGeo, this.hitMat);
    hit.position.y = u.kind === 'tank' ? 0.8 : u.kind === 'tower' ? 1.8 : 0.6;
    hit.scale.setScalar(u.kind === 'tank' ? 0.85 : u.kind === 'tower' ? 1.3 : 0.6); // a little generous so small troopers stay easy to click
    hit.userData.uid = u.id;
    const el = document.createElement('div');
    el.className = `gbar ${u.faction === this.link.player ? 'is-mine' : ''} ${u.kind === 'commander' ? 'is-commander' : ''}`;
    el.style.setProperty('--fc', '#' + color.getHexString());
    el.innerHTML = '<i></i><b class="gbar-rank"></b>';
    const bar = new CSS2DObject(el);
    bar.position.y = u.kind === 'tank' ? 2.5 : u.kind === 'tower' ? 4.6 : u.kind === 'commander' ? 1.9 : 1.7;
    group.add(ring, hit, bar);
    this.root.add(group);
    const v: UnitView = { id: u.id, kind: u.kind, faction: u.faction, group, model: null, ring, hit, bar, pos: new THREE.Vector2(u.x, u.y), facing: u.facing, hp: u.hp, maxHp: u.maxHp, dead: 0, anim: null, rank: 0 };
    this.units.set(u.id, v);
    this.applyModel(v);
    this.paintBar(v);
  }

  private applyModel(v: UnitView) {
    const m = this.models[v.kind];
    if (v.model || !m) return;
    v.model = instantiate(m);
    v.model.rotation.y = -v.facing;
    v.group.add(v.model);
    if (!m.rigged) return;
    // faction paint on the tintable materials (one material per faction + name, shared by every unit)
    v.model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.material = [mesh.material].flat().map((mat) => this.tint(mat, v.faction, m.tint)) as THREE.Material[];
      if ((mesh.material as THREE.Material[]).length === 1) mesh.material = (mesh.material as THREE.Material[])[0];
    });
    const mixer = new THREE.AnimationMixer(v.model);
    const actions: UnitAnim['actions'] = {};
    for (const clip of m.clips) {
      const name = clip.name as AnimState;
      const a = mixer.clipAction(clip);
      if (ONE_SHOT.includes(name)) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
      actions[name] = a;
    }
    // stagger the squad so nobody marches in lockstep
    const idle = actions.Idle;
    idle?.play();
    if (idle) idle.time = (v.id * 0.37) % idle.getClip().duration;
    v.anim = { mixer, actions, state: 'Idle', walkSpeed: m.walkSpeed, speed: 0, last: null, busyUntil: 0, gun: v.model.getObjectByName('Gun') ?? null };
    if (v.dead) this.play(v, 'Die');
  }

  private tint(mat: THREE.Material, faction: string, paint: Record<string, string>): THREE.Material {
    const how = paint[mat.name];
    if (!how) return mat;
    const key = `${faction}/${mat.name}/${how}`;
    let t = this.tinted.get(key);
    if (!t) {
      const c = mat.clone() as THREE.MeshStandardMaterial;
      if (how === 'faction') {
        c.color.copy(ARMOR_BASE).lerp(new THREE.Color(FACTION_STYLE[faction as keyof typeof FACTION_STYLE].color), 0.4);
        c.metalness = 0.55;
        c.roughness = 0.38;
      } else {
        c.color.set(how);
        c.metalness = 0.7;
        c.roughness = 0.5;
      }
      t = c;
      this.tinted.set(key, t);
    }
    return t;
  }

  /** Cross-fade a rigged unit into an animation state. */
  private play(v: UnitView, state: AnimState, restart = false) {
    const an = v.anim;
    if (!an) return;
    const next = an.actions[state];
    if (!next || (an.state === state && !restart)) return;
    const prev = an.actions[an.state];
    next.enabled = true;
    next.setEffectiveWeight(1);
    if (restart || ONE_SHOT.includes(state)) next.reset();
    if (state !== 'Walk') next.setEffectiveTimeScale(1);
    next.play();
    const fade = state === 'Die' ? 0.12 : state === 'Shoot' ? 0.08 : 0.2;
    if (prev && prev !== next) prev.crossFadeTo(next, fade, false);
    an.state = state;
    if (state === 'Shoot' || state === 'Hit') an.busyUntil = an.mixer.time + next.getClip().duration * 0.9;
  }

  private paintBar(v: UnitView) {
    const el = v.bar.element;
    (el.firstChild as HTMLElement).style.width = `${(v.hp / v.maxHp) * 100}%`;
    (el.lastChild as HTMLElement).textContent = '▲'.repeat(v.rank); // veteran chevrons
    const sel = this.link.getSelection().includes(v.id);
    el.classList.toggle('show', sel || v.hp < v.maxHp || v.rank > 0 || v.kind === 'commander');
  }

  private paintSelection() {
    const sel = new Set(this.link.getSelection());
    for (const v of this.units.values()) {
      const on = sel.has(v.id);
      (v.ring.material as THREE.MeshBasicMaterial).opacity = on ? 0.75 : 0.55;
      (v.ring.material as THREE.MeshBasicMaterial).color.set(on ? new THREE.Color(0.4, 1.15, 0.65) : this.ringColor(v).multiplyScalar(1.1));
      this.paintBar(v);
    }
  }

  protected sync(s: GameState) {
    const g = this.src.get(s)!;
    const byId = new Map(g.units.map((u) => [u.id, u]));
    for (const u of g.units) if (u.alive && !this.units.has(u.id)) this.addUnit(u); // freshly trained
    for (const v of this.units.values()) {
      const u = byId.get(v.id);
      if (!u) continue;
      const hurt = u.hp < v.hp && u.alive && u.maxHp === v.maxHp;
      v.hp = u.hp;
      v.maxHp = u.maxHp;
      v.rank = xpRank(u.xp ?? 0);
      v.facing = u.facing;
      if (!u.alive && !v.dead) { v.dead = 0.001; this.play(v, 'Die'); v.ring.visible = false; }
      // flinch only when standing; a running soldier just keeps running
      else if (hurt && v.anim && v.anim.state !== 'Walk' && v.anim.state !== 'Shoot') this.play(v, 'Hit', true);
      this.paintBar(v);
    }
    for (const shot of g.shots) {
      if (shot.tick <= this.lastShot) continue;
      this.shot(shot.from, shot.to, shot.kill);
    }
    this.lastShot = g.tick;
    // drop dead units from the selection
    const sel = this.link.getSelection();
    const alive = sel.filter((id) => byId.get(id)?.alive);
    if (alive.length !== sel.length) this.link.setSelection(alive);
  }


  private shot(from: number, to: number, kill: boolean) {
    const a = this.units.get(from), b = this.units.get(to);
    if (!a || !b) return;
    const big = a.kind === 'tank' || a.kind === 'tower';
    // who is shooting reads at a glance: the player's shots are blue, every enemy's are red
    const color = new THREE.Color(a.faction === this.link.player ? SHOT_MINE : SHOT_ENEMY).multiplyScalar(3);
    let p0 = this.toWorld(a.pos.x, a.pos.y, a.kind === 'tower' ? 3.7 : big ? 1.2 : 0.8);
    if (a.anim) {
      if (a.anim.state !== 'Walk' && a.anim.state !== 'Die') this.play(a, 'Shoot', true);
      // barrel tip of the pistol (its barrel runs along local -X from the grip)
      if (a.anim.gun) { a.model!.updateMatrixWorld(true); p0 = a.anim.gun.localToWorld(new THREE.Vector3(-0.4, 0.1, 0)); }
    }
    const p1 = this.toWorld(b.pos.x, b.pos.y, b.kind === 'tank' ? 0.9 : b.kind === 'tower' ? 2 : 0.6);
    const geo = new THREE.BufferGeometry().setFromPoints([p0, p1]);
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const line = new THREE.Line(geo, mat);
    const flash = this.sprite(color, p1, big ? 2.6 : 1.1);
    const muzzle = this.sprite(color, p0, big ? 1.9 : 0.7);
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
      const size = b.kind === 'tank' ? 7 : b.kind === 'tower' ? 11 : 3;
      this.fx.push({
        obj: boom, t: 0, life: 0.8,
        update: (k) => { boom.scale.setScalar(size * (0.3 + k)); (boom.material as THREE.SpriteMaterial).opacity = 1 - k; },
        dispose: () => (boom.material as THREE.Material).dispose(),
      });
    }
  }

  private sprite(color: THREE.Color, at: THREE.Vector3, size: number) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    s.position.copy(at);
    s.scale.setScalar(size);
    return s;
  }

  // ------------------------------------------------------------ input

  protected pickUnit(ray: THREE.Raycaster): number | null {
    const hits = ray.intersectObjects([...this.units.values()].filter((v) => !v.dead && v.group.visible).map((v) => v.hit), false);
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

    const g = this.src.get(this.engine.getState());
    const byId = new Map((g?.units ?? []).map((u) => [u.id, u]));
    const lerp = 1 - Math.exp(-dt * 14);
    for (const [id, v] of [...this.units]) {
      const u = byId.get(id);
      if (u) v.pos.lerp(new THREE.Vector2(u.x, u.y), lerp);
      const p = this.toWorld(v.pos.x, v.pos.y, v.kind === 'tank' ? 0.35 : 0);
      v.group.position.copy(p);
      if (u && this.src.shows) v.group.visible = v.dead > 0 || this.src.shows(u);
      if (v.kind === 'tower' && v.model && !v.dead) { const c = v.model.getObjectByName('crystal'); if (c) { c.rotation.y = ctx.t * 0.8; c.position.y = 3.7 + Math.sin(ctx.t * 1.6 + id) * 0.12; } }
      if (v.model && !v.dead && v.kind !== 'tower') {
        const want = -v.facing;
        let cur = v.model.rotation.y;
        const diff = Math.atan2(Math.sin(want - cur), Math.cos(want - cur));
        cur += diff * Math.min(1, dt * 10);
        v.model.rotation.y = cur;
        if (v.kind === 'tank') v.model.position.y = Math.sin(ctx.t * 3 + id) * 0.08;
      }
      if (v.anim) this.animate(v, p, dt);
      let gone = 0.7;
      if (v.dead && v.anim) {
        // rigged: play the death, lie there a moment, then sink into the ground
        v.dead += dt;
        gone = 3.6;
        if (v.dead > 2.6) v.group.position.y -= (v.dead - 2.6) * 1.6;
        v.bar.visible = false;
      } else if (v.dead) {
        v.dead += dt;
        v.group.scale.setScalar(Math.max(0.01, 1 - v.dead * 1.5));
        v.group.position.y -= v.dead * 1.5;
      }
      if (v.dead) {
        if (v.dead > gone) {
          v.anim?.mixer.stopAllAction();
          this.root.remove(v.group);
          v.bar.element.remove();
          (v.ring.material as THREE.Material).dispose();
          this.units.delete(id);
        }
      }
    }
    this.updateRings();
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

  /**
   * Range outlines for the selection: the union of every selected unit's weapon-range circle (solid) and
   * sight circle (dashed), draped over the terrain. Overlapping circles merge into one outline, so a squad
   * reads as "where this group can shoot / will notice enemies". Rebuilt only when the selection moves.
   */
  private updateRings() {
    const g = this.src.get(this.engine.getState());
    const byId = new Map((g?.units ?? []).map((u) => [u.id, u]));
    const sel = this.link.getSelection().filter((id) => byId.get(id)?.alive && this.units.has(id)).sort((x, y) => x - y);
    const circles = sel.map((id) => {
      const v = this.units.get(id)!, u = byId.get(id)!;
      return { x: v.pos.x, y: v.pos.y, fire: u.range, sight: sightOf(u) };
    });
    const key = circles.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)},${c.fire}`).join(';');
    if (key === this.ringKey) return;
    this.ringKey = key;
    if (this.rings) this.dropRings(this.rings);
    this.rings = null;
    if (!circles.length) return;
    const fire = new THREE.Mesh(this.ringRibbon(circles.map((c) => ({ x: c.x, y: c.y, r: c.fire })), false), this.fireMat);
    const sight = new THREE.Mesh(this.ringRibbon(circles.map((c) => ({ x: c.x, y: c.y, r: c.sight })), true), this.sightMat);
    fire.renderOrder = sight.renderOrder = 5;
    this.root.add(fire, sight);
    this.rings = { fire, sight };
  }

  private dropRings(r: RangeRings) {
    this.root.remove(r.fire, r.sight);
    r.fire.geometry.dispose();
    r.sight.geometry.dispose();
  }

  /** Outline of a union of circles (cell coords, radius in cells) as flat ribbons following the ground height. */
  private ringRibbon(circles: { x: number; y: number; r: number }[], dashed: boolean) {
    const pos: number[] = [];
    const idx: number[] = [];
    const inside = (x: number, y: number, skip: number) =>
      circles.some((c, j) => j !== skip && (x - c.x) ** 2 + (y - c.y) ** 2 < (c.r - 0.02) ** 2);
    circles.forEach((c, ci) => {
      const centre = this.toWorld(c.x, c.y);
      const base = pos.length / 3;
      for (let i = 0; i <= RING_SEGMENTS; i++) {
        const a = (i / RING_SEGMENTS) * Math.PI * 2;
        const p = this.toWorld(c.x + Math.cos(a) * c.r, c.y + Math.sin(a) * c.r, 0.3);
        const out = new THREE.Vector3(p.x - centre.x, 0, p.z - centre.z).normalize().multiplyScalar(RING_WIDTH / 2);
        pos.push(p.x - out.x, p.y, p.z - out.z, p.x + out.x, p.y, p.z + out.z);
        if (i === RING_SEGMENTS) break;
        if (dashed && i % 4 >= 2) continue; // 2 on, 2 off
        const am = ((i + 0.5) / RING_SEGMENTS) * Math.PI * 2;
        if (inside(c.x + Math.cos(am) * c.r, c.y + Math.sin(am) * c.r, ci)) continue; // hidden inside a neighbour's circle
        const k = base + i * 2;
        idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      }
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    return geo;
  }

  /** Pick Idle / Walk from how fast the unit is actually moving on screen, and pace the stride to it. */
  private animate(v: UnitView, p: THREE.Vector3, dt: number) {
    const an = v.anim!;
    if (dt > 0) {
      const inst = an.last ? Math.hypot(p.x - an.last.x, p.z - an.last.z) / dt : 0;
      an.speed += (inst - an.speed) * (1 - Math.exp(-dt * 8));
    }
    an.last = (an.last ?? new THREE.Vector3()).copy(p);
    if (!v.dead) {
      const busy = an.mixer.time < an.busyUntil;
      if (an.speed > 0.8) this.play(v, 'Walk');
      else if (an.speed < 0.4 && !busy && an.state !== 'Idle') this.play(v, 'Idle');
      // feet match the ground: stride rate follows real speed (no skating)
      if (an.state === 'Walk') an.actions.Walk?.setEffectiveTimeScale(THREE.MathUtils.clamp(an.speed / an.walkSpeed, 0.55, 1.8));
    }
    an.mixer.update(dt);
  }

  dispose() {
    this.disposed = true;
    for (const v of this.units.values()) v.anim?.mixer.stopAllAction();
    for (const m of this.tinted.values()) m.dispose();
    if (this.rings) this.dropRings(this.rings);
    this.fireMat.dispose();
    this.sightMat.dispose();
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
