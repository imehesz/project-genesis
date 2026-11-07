import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BUILDING_IDS, type BuildingId } from '../engine/index.ts';

let loading: Promise<Partial<Record<BuildingId, THREE.Object3D>>> | null = null;

/**
 * Colony building models (public/models/buildings/<id>.glb, Higgsfield tripo_3d).
 * Normalized: foundation centred on the origin, sitting on y = 0, widest side 1 unit.
 */
export function loadBuildingModels(): Promise<Partial<Record<BuildingId, THREE.Object3D>>> {
  if (loading) return loading;
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  loading = Promise.all(
    BUILDING_IDS.map((id) =>
      loader
        .loadAsync(`models/buildings/${id}.glb`)
        .then((g) => [id, normalize(g.scene)] as const)
        .catch(() => [id, null] as const),
    ),
  ).then((pairs) => Object.fromEntries(pairs.filter(([, m]) => m)) as Partial<Record<BuildingId, THREE.Object3D>>);
  return loading;
}

function normalize(scene: THREE.Object3D): THREE.Object3D {
  const box = new THREE.Box3().setFromObject(scene);
  const size = box.getSize(new THREE.Vector3());
  const c = box.getCenter(new THREE.Vector3());
  scene.position.set(-c.x, -box.min.y, -c.z);
  const outer = new THREE.Group();
  outer.add(scene);
  outer.scale.setScalar(1 / Math.max(size.x, size.z, 0.0001));
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.castShadow = true;
    m.receiveShadow = true;
    (m.material as THREE.MeshStandardMaterial).envMapIntensity = 0.7;
  });
  return outer;
}

/** Height of a normalized model (for the construction clip plane). */
export function modelHeight(template: THREE.Object3D): number {
  return new THREE.Box3().setFromObject(template).getSize(new THREE.Vector3()).y;
}
