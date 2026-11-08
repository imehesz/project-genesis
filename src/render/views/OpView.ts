import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { BUILDINGS, UNIT_DEFS, footprint, surfaceOf, type Engine, type GameState, type GroundOp } from '../../engine/index.ts';
import { GroundBattleView, type GroundLink } from './GroundBattleView.ts';
import { CELL, type SurfaceLink } from './PlanetView.ts';
import { glowTexture } from '../glow.ts';
import { asset } from '../../asset.ts';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { FrameContext } from '../View.ts';

const FOG_SUB = 2; // fog vertices per cell edge
const FOG_MARGIN = 3; // cells of fog past the map edge
const BLANKET = 4.6; // unexplored fog sits this high above the ground (covers trees and ridges)
/** Building bars (health, repair/build/training progress) show while the camera is closer than this. Tune here. */
export const BAR_DETAIL_DISTANCE = 62;

/**
 * A planet mission on the surface: everything GroundBattleView draws (units, shots, selection, rings)
 * plus fog of war, dark holes, the rune, ruined buildings and their status labels, and building placement.
 */
export class OpView extends GroundBattleView {
  private surfaceLink: SurfaceLink;
  private fogMesh: THREE.Mesh;
  private fogKey = '';
  private holes: THREE.Group[] = [];
  private holeMat: THREE.ShaderMaterial;
  private rune: THREE.Group;
  private labels = new Map<number, CSS2DObject>();
  private ruinMats = new Map<THREE.Material, THREE.Material>();
  private styled = new Map<number, string>();
  private extras: { dispose(): void }[] = [];
  private rallyFlag: THREE.Group;
  private rallyLine: THREE.Line;
  private onRally: (structureId: number, at: { x: number; y: number } | null) => void;

  constructor(engine: Engine, link: GroundLink, surface: SurfaceLink, onRally: (structureId: number, at: { x: number; y: number } | null) => void) {
    const op = engine.getState().op!;
    const commander = op.units.find((u) => u.kind === 'commander')!;
    const mapW = surfaceOf(engine.getState(), engine.getState().colonies[op.colonyId]).w;
    super(engine, link, {
      get: (s) => s.op,
      surface,
      focus: { x: commander.x, y: commander.y - 2 },
      shows: (u) => {
        const o = engine.getState().op;
        if (!o || u.faction === o.player) return true;
        const i = Math.round(u.y) * mapW + Math.round(u.x);
        return u.speed === 0 ? o.explored[i] === 1 : o.visible[i] === 1; // towers stay drawn once found
      },
    });
    this.surfaceLink = surface;
    this.onRally = onRally;
    this.fogMesh = this.makeFog();
    // rally point: a small flag on a pole, and a dashed line from the building (shown while it is selected)
    const flagMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.45, 1.3, 0.7), side: THREE.DoubleSide });
    const poleMat = new THREE.MeshStandardMaterial({ color: '#c9d2dc', metalness: 0.6, roughness: 0.4 });
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.2, 6), poleMat);
    pole.position.y = 1.1;
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.55), flagMat);
    cloth.name = 'cloth';
    cloth.position.set(0.45, 1.9, 0);
    const base = new THREE.Mesh(new THREE.RingGeometry(0.35, 0.55, 24).rotateX(-Math.PI / 2), flagMat);
    base.position.y = 0.08;
    this.rallyFlag = new THREE.Group();
    this.rallyFlag.add(pole, cloth, base);
    this.rallyFlag.visible = false;
    this.rallyLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: new THREE.Color(0.45, 1.3, 0.7), dashSize: 0.8, gapSize: 0.6, transparent: true, opacity: 0.8, depthTest: false }));
    this.rallyLine.renderOrder = 6;
    this.rallyLine.visible = false;
    this.root.add(this.rallyFlag, this.rallyLine);
    this.extras.push(flagMat, poleMat, pole.geometry, cloth.geometry, base.geometry, this.rallyLine.geometry, this.rallyLine.material as THREE.Material);
    this.root.add(this.fogMesh);

    this.holeMat = holeMaterial();
    this.extras.push(this.holeMat);
    const disc = new THREE.CircleGeometry(CELL * 0.48, 40).rotateX(-Math.PI / 2);
    this.extras.push(disc);
    for (const h of op.holes) {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(disc, this.holeMat));
      g.position.copy(this.toWorld(h.x, h.y, 0.1));
      this.root.add(g);
      this.holes.push(g);
    }
    this.rune = this.makeRune();
    this.rune.position.copy(this.toWorld(op.rune.x, op.rune.y, 0));
    this.root.add(this.rune);

    this.planet.afterSync = () => this.styleStructures(engine.getState());
    this.styleStructures(engine.getState());
    this.syncExtras(engine.getState());
  }

  // ------------------------------------------------------------ fog of war

  private makeFog(): THREE.Mesh {
    const s = this.planet.surfaceInfo;
    const nx = (s.w + FOG_MARGIN * 2) * FOG_SUB + 1, ny = (s.h + FOG_MARGIN * 2) * FOG_SUB + 1;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nx * ny * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(nx * ny * 4), 4));
    const idx: number[] = [];
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i, b = a + 1, d = a + nx, e = d + 1;
        idx.push(a, d, b, b, d, e);
      }
    geo.setIndex(idx);
    geo.userData.n = [nx, ny];
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, fog: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 3;
    mesh.frustumCulled = false;
    this.extras.push(geo, mat);
    return mesh;
  }

  private updateFog(op: GroundOp) {
    const key = `${op.tick - (op.tick % 4)}`;
    if (key === this.fogKey) return;
    this.fogKey = key;
    const s = this.planet.surfaceInfo;
    const geo = this.fogMesh.geometry;
    const [nx, ny] = geo.userData.n as [number, number];
    const pos = geo.attributes.position.array as Float32Array;
    const col = geo.attributes.color.array as Float32Array;
    const at = (arr: number[], x: number, y: number) => arr[Math.min(s.h - 1, Math.max(0, y)) * s.w + Math.min(s.w - 1, Math.max(0, x))];
    const sample = (arr: number[], fx: number, fy: number) => {
      const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
      const a = at(arr, x0, y0) + (at(arr, x0 + 1, y0) - at(arr, x0, y0)) * tx;
      const b = at(arr, x0, y0 + 1) + (at(arr, x0 + 1, y0 + 1) - at(arr, x0, y0 + 1)) * tx;
      return a + (b - a) * ty;
    };
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const fx = i / FOG_SUB - FOG_MARGIN - 0.5, fy = j / FOG_SUB - FOG_MARGIN - 0.5;
        const e = smooth(sample(op.explored, fx, fy)), v = smooth(sample(op.visible, fx, fy));
        const w = this.planet.world(fx, fy);
        const k = j * nx + i;
        pos[k * 3] = w.x;
        pos[k * 3 + 1] = Math.max(this.planet.heightAt(fx, fy), 0) + 0.15 + (1 - e) * BLANKET;
        pos[k * 3 + 2] = w.z;
        const n = hash(i, j) * 0.025;
        col[k * 4] = 0.02 + n; col[k * 4 + 1] = 0.03 + n; col[k * 4 + 2] = 0.06 + n;
        // alpha blends in linear space and the output is sRGB, so it needs to be high to read as dark
        col[k * 4 + 3] = (1 - e) * 0.99 + e * (1 - v) * 0.72;
      }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
  }

  // ------------------------------------------------------------ holes, rune, ruins, labels

  /** The rune: a carved stone tablet on an altar (Higgsfield tripo_3d), with a soft glow. */
  private makeRune(): THREE.Group {
    const g = new THREE.Group();
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: new THREE.Color(0.3, 1.4, 1.2), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    halo.name = 'halo';
    halo.scale.setScalar(5);
    halo.position.y = 1.8;
    g.add(halo);
    this.extras.push(halo.material);
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    loader.loadAsync(asset('models/props/rune.glb')).then((gl) => {
      const m = gl.scene;
      const box = new THREE.Box3().setFromObject(m);
      const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
      m.position.set(-c.x, -box.min.y, -c.z);
      const wrap = new THREE.Group();
      wrap.add(m);
      wrap.scale.setScalar(3.4 / size.y);
      wrap.rotation.y = -Math.PI / 2; // the glyph side of the model faces +X; turn it toward the camera (+Z)
      m.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = true;
        this.extras.push(mesh.geometry, ...[mesh.material].flat());
      });
      g.add(wrap);
    }).catch(() => {});
    return g;
  }

  /** Ruins look ruined: darkened, scorched, tilted. Repaired buildings get their real look back. */
  private styleStructures(state: GameState) {
    const op = state.op;
    if (!op) return;
    for (const t of op.structures) {
      if (t.state === 'building') continue;
      const g = this.planet.structureGroup(t.id);
      if (!g) continue;
      const look = t.state === 'ready' ? 'ok' : 'ruin';
      if (this.styled.get(t.id) === look && g.userData.styled) continue;
      this.styled.set(t.id, look);
      g.userData.styled = true;
      const model = g.children[0];
      if (!model) continue;
      if (model.userData.restY === undefined) model.userData.restY = model.position.y;
      model.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || m.userData.hitbox) return;
        m.userData.orig ??= m.material;
        m.material = look === 'ruin' ? [m.userData.orig as THREE.Material | THREE.Material[]].flat().map((x) => this.ruinMat(x)) as unknown as THREE.Material : m.userData.orig;
        if (Array.isArray(m.material) && m.material.length === 1) m.material = m.material[0];
      });
      model.rotation.z = look === 'ruin' ? 0.07 * (t.id % 2 ? 1 : -1) : 0;
      model.rotation.x = look === 'ruin' ? 0.05 : 0;
      model.position.y = model.userData.restY - (look === 'ruin' ? 0.35 : 0);
    }
  }

  private ruinMat(m: THREE.Material): THREE.Material {
    let r = this.ruinMats.get(m);
    if (!r) {
      const c = m.clone() as THREE.MeshStandardMaterial;
      c.color?.multiplyScalar(0.28).lerp(new THREE.Color('#2a2420'), 0.35);
      if (c.emissive) c.emissive.set(0);
      c.roughness = 1;
      c.metalness = 0.05;
      r = c;
      this.ruinMats.set(m, r);
      this.extras.push(r);
    }
    return r;
  }

  private syncExtras(state: GameState) {
    const op = state.op;
    if (!op) return;
    const s = this.planet.surfaceInfo;
    op.holes.forEach((h, i) => (this.holes[i].visible = op.explored[h.y * s.w + h.x] === 1));
    this.rune.visible = !op.rune.taken && op.explored[op.rune.y * s.w + op.rune.x] === 1;
    // name + health bar + progress bar over every building of ours (shown only when zoomed in, see update)
    const seen = new Set<number>();
    for (const t of op.structures) {
      seen.add(t.id);
      let l = this.labels.get(t.id);
      if (!l) {
        const el = document.createElement('div');
        el.className = 'op-label';
        el.innerHTML = '<span></span><div class="op-bar hp"><i></i></div><div class="op-bar work"><i></i></div>';
        l = new CSS2DObject(el);
        const f = footprint(t.building);
        l.position.copy(this.toWorld(t.x + (f - 1) / 2, t.y + (f - 1) / 2, f * CELL * 0.62 + 0.6));
        this.root.add(l);
        this.labels.set(t.id, l);
      }
      const el = l.element;
      const text = statusText(t);
      const name = el.firstChild as HTMLElement;
      if (name.textContent !== text) name.textContent = text;
      el.classList.toggle('is-ruin', t.state === 'ruin');
      ((el.children[1] as HTMLElement).firstChild as HTMLElement).style.width = `${(t.hp / t.maxHp) * 100}%`;
      const work = progressOf(t);
      (el.children[2] as HTMLElement).style.display = work === null ? 'none' : '';
      if (work !== null) ((el.children[2] as HTMLElement).firstChild as HTMLElement).style.width = `${work * 100}%`;
    }
    for (const [id, l] of this.labels) if (!seen.has(id)) { this.root.remove(l); l.element.remove(); this.labels.delete(id); }
  }

  // ------------------------------------------------------------ input

  click(ray: THREE.Raycaster) {
    if (this.surfaceLink.getPlacing()) return this.planet.click(ray);
    const uid = this.pickUnit(ray);
    if (uid !== null) {
      this.surfaceLink.setStructure(null);
      return super.click(ray);
    }
    const sid = this.planet.pickStructure(ray);
    this.link.setSelection([]);
    this.surfaceLink.setStructure(sid);
  }

  contextClick(ray: THREE.Raycaster) {
    if (this.surfaceLink.getPlacing()) return this.surfaceLink.setPlacing(null);
    // a training building is selected: right-click sets where its new units go
    const sid = this.surfaceLink.getStructure();
    const t = sid === null ? null : this.engine.getState().op?.structures.find((x) => x.id === sid);
    if (t && BUILDINGS[t.building].op!.trains && !this.link.getSelection().length) {
      const c = this.planet.pointCell(ray);
      if (!c) return;
      this.onRally(t.id, c);
      this.marker.position.copy(this.toWorld(c.x, c.y, 0.2));
      this.markerT = 0;
      return;
    }
    super.contextClick(ray);
  }

  /** Rally flag + line for the selected training building. */
  private updateRally(op: GroundOp, t: number) {
    const sid = this.surfaceLink.getStructure();
    const st = sid === null ? null : op.structures.find((x) => x.id === sid);
    const r = st?.rally;
    this.rallyFlag.visible = this.rallyLine.visible = !!r;
    if (!st || !r) return;
    this.rallyFlag.position.copy(this.toWorld(r.x, r.y, 0));
    const cloth = this.rallyFlag.getObjectByName('cloth');
    if (cloth) cloth.rotation.y = Math.sin(t * 2.2) * 0.25;
    const f = footprint(st.building);
    const from = this.toWorld(st.x + (f - 1) / 2, st.y + (f - 1) / 2, 0.4);
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 24; i++) {
      const k = i / 24;
      const x = st.x + (f - 1) / 2 + (r.x - st.x - (f - 1) / 2) * k, y = st.y + (f - 1) / 2 + (r.y - st.y - (f - 1) / 2) * k;
      pts.push(i === 0 ? from : this.toWorld(x, y, 0.4));
    }
    this.rallyLine.geometry.setFromPoints(pts);
    this.rallyLine.computeLineDistances();
  }

  hover(ray: THREE.Raycaster) {
    if (this.surfaceLink.getPlacing()) return this.planet.hover(ray);
    return super.hover(ray) || this.planet.pickStructure(ray) !== null;
  }

  // ------------------------------------------------------------ frame

  update(ctx: FrameContext) {
    super.update(ctx);
    const state = this.engine.getState();
    const op = state.op;
    if (!op) return;
    this.updateFog(op);
    this.syncExtras(state);
    this.updateRally(op, ctx.t);
    const near = ctx.camera.position.distanceTo(ctx.controls.target) < BAR_DETAIL_DISTANCE;
    for (const l of this.labels.values()) l.visible = near;
    this.holeMat.uniforms.uTime.value = ctx.t;
    const halo = this.rune.getObjectByName('halo') as THREE.Sprite | undefined;
    if (halo) (halo.material as THREE.SpriteMaterial).opacity = 0.55 + Math.sin(ctx.t * 1.6) * 0.25;
  }

  dispose() {
    for (const l of this.labels.values()) l.element.remove();
    for (const d of this.extras) d.dispose();
    super.dispose();
  }
}

function statusText(t: GroundOp['structures'][number]): string {
  const name = BUILDINGS[t.building].name;
  if (t.state === 'ruin') return `${name} · ruined`;
  if (t.state === 'repairing') return `${name} · repairing`;
  if (t.state === 'building') return `${name} · building`;
  if (t.train.length) return `${name} · ${UNIT_DEFS[t.train[0].unit].name}${t.train.length > 1 ? ` +${t.train.length - 1}` : ''}`;
  return name;
}

/** 0..1 for repairs, construction and training; null when nothing is in progress. */
function progressOf(t: GroundOp['structures'][number]): number | null {
  if (t.state === 'repairing' || t.state === 'building') return t.work / BUILDINGS[t.building].cost;
  if (t.state === 'ready' && t.train.length) return t.train[0].t / UNIT_DEFS[t.train[0].unit].price!.ticks;
  return null;
}

/** A dark hole in the ground: black centre, a slow violet swirl at the rim. */
function holeMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, fog: false,
    uniforms: { uTime: { value: 0 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      varying vec2 vUv; uniform float uTime;
      void main() {
        vec2 p = vUv - 0.5; float r = length(p) * 2.0; float a = atan(p.y, p.x);
        float swirl = 0.5 + 0.5 * sin(a * 5.0 + r * 10.0 - uTime * 1.6);
        float rim = smoothstep(0.35, 0.8, r) * (1.0 - smoothstep(0.85, 1.0, r));
        vec3 c = mix(vec3(0.0), vec3(0.45, 0.12, 0.95), rim * (0.4 + 0.6 * swirl));
        float alpha = (1.0 - smoothstep(0.9, 1.0, r)) * (0.75 + 0.25 * (1.0 - r));
        gl_FragColor = vec4(c, alpha);
      }`,
  });
}

const smooth = (t: number) => { const u = Math.min(1, Math.max(0, t)); return u * u * (3 - 2 * u); };
function hash(x: number, y: number) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }
