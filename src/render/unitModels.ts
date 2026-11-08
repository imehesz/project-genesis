import { asset } from '../asset.ts';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { UnitId } from '../engine/index.ts';

/**
 * Ground unit models (public/models/units/*.glb).
 *
 * Two kinds:
 * - static (tank.glb, Higgsfield tripo_3d, faces +X): normalized to `size` world units on its largest axis.
 * - rigged (trooper.glb, CC0 Quaternius mannequin + pistol, built by src/tmp/project-genesis/trooper/build.mjs):
 *   a skinned humanoid in metres, facing +Z, feet at y = 0, carrying the clip contract
 *   Idle / Walk / Shoot / Hit / Die. A designer's replacement model only has to keep that contract
 *   (and say which way it faces + how tall it is in CONFIG).
 *
 * Either way the returned template faces +X, so GroundBattleView can steer it with rotation.y = -facing.
 */
interface ModelConfig {
  file: string;
  /** Static: world size of the largest axis. Rigged: world height. */
  size: number;
  rigged?: {
    /** Native height in model units (the mannequin is 1.83 m). */
    height: number;
    /** Yaw that turns the model's forward onto +X. */
    yaw: number;
    /** Ground speed of the Walk clip at timeScale 1, in model units / s (from the root-motion version). */
    walkSpeed: number;
    /** Material repaints by name: 'faction' = faction armour colour, otherwise a fixed colour. Others stay as authored. */
    tint: Record<string, string>;
  };
}

const CONFIG: Record<UnitId, ModelConfig> = {
  infantry: { file: 'trooper.glb', size: 1.2, rigged: { height: 1.83, yaw: Math.PI / 2, walkSpeed: 8.25, tint: { M_Main: 'faction', M_Joints: '#24282e' } } },
  tank: { file: 'tank.glb', size: 2.55 },
};

export interface UnitModel {
  /** Template; use instantiate() rather than clone() so skinned meshes get their own skeleton. */
  template: THREE.Object3D;
  clips: THREE.AnimationClip[];
  rigged: boolean;
  /** Rigged only: Walk clip ground speed in world units / s at timeScale 1. */
  walkSpeed: number;
  tint: Record<string, string>;
}

let loading: Promise<Partial<Record<UnitId, UnitModel>>> | null = null;

export function loadUnitModels(): Promise<Partial<Record<UnitId, UnitModel>>> {
  if (loading) return loading;
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const ids = Object.keys(CONFIG) as UnitId[];
  loading = Promise.all(
    ids.map((id) =>
      loader.loadAsync(asset(`models/units/${CONFIG[id].file}`)).then((g) => [id, build(g.scene, g.animations, CONFIG[id])] as const).catch(() => [id, null] as const),
    ),
  ).then((p) => Object.fromEntries(p.filter(([, m]) => m)) as Partial<Record<UnitId, UnitModel>>);
  return loading;
}

/** A fresh copy of a unit model; skinned models get their own bones. Materials are shared. */
export function instantiate(m: UnitModel): THREE.Object3D {
  return m.rigged ? SkeletonUtils.clone(m.template) : m.template.clone(true);
}

function build(scene: THREE.Object3D, clips: THREE.AnimationClip[], cfg: ModelConfig): UnitModel {
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.castShadow = true;
    // skinned bounds come from the bind pose; a running soldier can leave them and get culled at screen edges
    if ((m as THREE.SkinnedMesh).isSkinnedMesh) m.frustumCulled = false;
    for (const mat of [m.material].flat() as THREE.MeshStandardMaterial[]) mat.envMapIntensity = 0.7;
  });
  if (cfg.rigged) {
    const r = cfg.rigged;
    const outer = new THREE.Group();
    const s = cfg.size / r.height;
    scene.rotation.y = r.yaw;
    outer.add(scene);
    outer.scale.setScalar(s);
    return { template: outer, clips, rigged: true, walkSpeed: r.walkSpeed * s, tint: r.tint };
  }
  const box = new THREE.Box3().setFromObject(scene);
  const dim = box.getSize(new THREE.Vector3());
  const c = box.getCenter(new THREE.Vector3());
  scene.position.set(-c.x, -box.min.y, -c.z);
  const outer = new THREE.Group();
  outer.add(scene);
  outer.scale.setScalar(cfg.size / Math.max(dim.x, dim.y, dim.z));
  return { template: outer, clips, rigged: false, walkSpeed: 0, tint: {} };
}
