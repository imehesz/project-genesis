import { asset } from '../asset.ts';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { ShipId } from '../engine/index.ts';
import { glowTexture } from './glow.ts';

/**
 * 3D ship models (public/models/<id>.glb, generated with Higgsfield tripo_3d, optimized with gltf-transform).
 * `yaw` turns each model so its nose points along +Z (what Object3D.lookAt() aims).
 * `engines` are rear engine-flare positions in normalized model space (length 1 along Z, nose at +0.5).
 */
const CONFIG: Record<ShipId, { yaw: number; engines: [number, number, number][] }> = {
  frigate: { yaw: Math.PI / 2, engines: [[0, 0, -0.52]] },
  scout: { yaw: Math.PI / 2, engines: [[0, 0, -0.52]] },
  colony: { yaw: Math.PI / 2, engines: [[0, 0, -0.52]] },
  transport: { yaw: Math.PI / 2, engines: [[0, 0, -0.52]] },
};

let loading: Promise<Partial<Record<ShipId, THREE.Object3D>>> | null = null;

/** Loads every ship model once; resolves with whatever loaded (a missing file just falls back). */
export function loadShipModels(): Promise<Partial<Record<ShipId, THREE.Object3D>>> {
  if (loading) return loading;
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const ids = Object.keys(CONFIG) as ShipId[];
  loading = Promise.all(
    ids.map((id) =>
      loader
        .loadAsync(asset(`models/${id}.glb`))
        .then((g) => [id, normalize(g.scene, CONFIG[id].yaw)] as const)
        .catch(() => [id, null] as const),
    ),
  ).then((pairs) => Object.fromEntries(pairs.filter(([, m]) => m)) as Partial<Record<ShipId, THREE.Object3D>>);
  return loading;
}

/** Nose to +Z, centered, 1 unit long. */
function normalize(scene: THREE.Object3D, yaw: number): THREE.Object3D {
  const inner = new THREE.Group();
  scene.rotation.y = yaw;
  inner.add(scene);
  inner.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(inner);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  scene.position.sub(center);
  const outer = new THREE.Group();
  outer.add(inner);
  outer.scale.setScalar(1 / Math.max(size.z, 0.0001));
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mat = m.material as THREE.MeshStandardMaterial;
    mat.envMapIntensity = 0.6;
    mat.color.multiplyScalar(0.72); // tame bloom on the light grey hulls
  });
  return outer;
}

/** A ship instance for the map/battle: model clone + faction-coloured engine flares. */
export function makeShip(template: THREE.Object3D, id: ShipId, color: THREE.Color): THREE.Group {
  const g = new THREE.Group();
  g.add(template.clone(true)); // geometry + materials stay shared with the template
  for (const [x, y, z] of CONFIG[id].engines) {
    const flare = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTexture(), color: color.clone().multiplyScalar(3),
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      }),
    );
    flare.position.set(x, y, z);
    flare.scale.setScalar(0.6);
    flare.userData.flare = true;
    g.add(flare);
  }
  return g;
}

/** Which model represents a fleet on the map: its most important ship. */
export function flagshipOf(ships: Partial<Record<ShipId, number>>): ShipId {
  for (const s of ['frigate', 'transport', 'colony', 'scout'] as ShipId[]) if ((ships[s] ?? 0) > 0) return s;
  return 'scout';
}
