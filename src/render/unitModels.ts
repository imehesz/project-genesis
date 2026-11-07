import { asset } from '../asset.ts';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { UnitId } from '../engine/index.ts';

/**
 * Ground unit models (public/models/units/<id>.glb, Higgsfield tripo_3d). Both face +X.
 * Normalized: standing on y = 0, centred, and scaled to `size` world units on their largest axis.
 */
const SIZE: Record<UnitId, number> = { infantry: 2.4, tank: 3.4 };
let loading: Promise<Partial<Record<UnitId, THREE.Object3D>>> | null = null;

export function loadUnitModels(): Promise<Partial<Record<UnitId, THREE.Object3D>>> {
  if (loading) return loading;
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const ids = Object.keys(SIZE) as UnitId[];
  loading = Promise.all(
    ids.map((id) =>
      loader.loadAsync(asset(`models/units/${id}.glb`)).then((g) => [id, normalize(g.scene, SIZE[id])] as const).catch(() => [id, null] as const),
    ),
  ).then((p) => Object.fromEntries(p.filter(([, m]) => m)) as Partial<Record<UnitId, THREE.Object3D>>);
  return loading;
}

function normalize(scene: THREE.Object3D, size: number): THREE.Object3D {
  const box = new THREE.Box3().setFromObject(scene);
  const dim = box.getSize(new THREE.Vector3());
  const c = box.getCenter(new THREE.Vector3());
  scene.position.set(-c.x, -box.min.y, -c.z);
  const outer = new THREE.Group();
  outer.add(scene);
  outer.scale.setScalar(size / Math.max(dim.x, dim.y, dim.z));
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) { m.castShadow = true; (m.material as THREE.MeshStandardMaterial).envMapIntensity = 0.7; }
  });
  return outer;
}
