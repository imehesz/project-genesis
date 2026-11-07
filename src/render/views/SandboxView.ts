import * as THREE from 'three';
import type { Engine, Entity, EntityId, GameState } from '../../engine/index.ts';
import type { CameraPreset, FrameContext, View } from '../View.ts';

const SPAWN_ANIM_S = 0.9;

interface CubeView {
  group: THREE.Group;
  born: number;
  spin: number;
}

/** Phase 1 state test: draws one glowing cube per engine entity on a holo-table. */
export class SandboxView implements View {
  root = new THREE.Group();
  preset: CameraPreset = {
    position: [14, 9, 16], target: [0, 1, 0],
    minDistance: 6, maxDistance: 60, maxPolarAngle: Math.PI * 0.49, autoRotateSpeed: 0.35,
  };
  private cubes = new Map<EntityId, CubeView>();
  private now = 0;
  private unsubscribe: () => void;
  private cubeGeo = new THREE.BoxGeometry(1, 1, 1);
  private edgeGeo = new THREE.EdgesGeometry(this.cubeGeo);
  private coreGeo = new THREE.OctahedronGeometry(0.18);
  private cubeMat = new THREE.MeshStandardMaterial({ color: 0x1a2230, metalness: 0.85, roughness: 0.32 });
  private edgeMat = new THREE.LineBasicMaterial({ color: new THREE.Color(0.35, 1.6, 2.2) });
  private coreMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.8, 1.0, 0.35) });

  constructor(engine: Engine) {
    this.root.add(new THREE.HemisphereLight(0x6fa8ff, 0x1a0f22, 0.6));
    const key = new THREE.DirectionalLight(0xffe2b8, 2.2);
    key.position.set(10, 14, 6);
    const rim = new THREE.DirectionalLight(0x5fd4ff, 1.4);
    rim.position.set(-12, 4, -10);
    this.root.add(key, rim, holoTable());

    this.sync(engine.getState());
    this.unsubscribe = engine.subscribe((s, prev) => {
      if (s.entities !== prev.entities) this.sync(s);
    });
  }

  private sync(state: GameState) {
    for (const [id, v] of this.cubes) {
      if (!state.entities[id]) {
        this.root.remove(v.group);
        this.cubes.delete(id);
      }
    }
    for (const e of Object.values(state.entities)) if (!this.cubes.has(e.id)) this.addCube(e);
  }

  private addCube(e: Entity) {
    const group = new THREE.Group();
    group.add(new THREE.Mesh(this.cubeGeo, this.cubeMat));
    group.add(new THREE.LineSegments(this.edgeGeo, this.edgeMat));
    group.add(new THREE.Mesh(this.coreGeo, this.coreMat));
    group.position.set(e.pos.x, e.pos.y, e.pos.z);
    group.scale.setScalar(0.001);
    this.root.add(group);
    this.cubes.set(e.id, { group, born: this.now, spin: 0.3 + (e.id % 5) * 0.12 });
  }

  update({ t, dt }: FrameContext) {
    this.now = t;
    for (const v of this.cubes.values()) {
      const k = Math.min(1, (t - v.born) / SPAWN_ANIM_S);
      const ease = 1 + 2.2 * Math.pow(k - 1, 3) + 1.2 * Math.pow(k - 1, 2); // easeOutBack
      v.group.scale.setScalar(Math.max(0.001, ease));
      v.group.rotation.y += dt * v.spin;
      v.group.rotation.x += dt * v.spin * 0.4;
    }
  }

  dispose() {
    this.unsubscribe();
    for (const g of [this.cubeGeo, this.edgeGeo, this.coreGeo]) g.dispose();
    for (const m of [this.cubeMat, this.edgeMat, this.coreMat]) m.dispose();
  }
}

function holoTable(): THREE.Group {
  const holo = new THREE.Group();
  const ringMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(0.2, 0.75, 1.1), transparent: true, opacity: 0.35,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  for (const r of [3, 6, 9, 12]) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(r - 0.02, r + 0.02, 128), ringMat);
    ring.rotation.x = -Math.PI / 2;
    holo.add(ring);
  }
  const grid = new THREE.PolarGridHelper(12, 16, 4, 64, 0x1f5f80, 0x123447);
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.35;
  holo.add(grid);
  return holo;
}
