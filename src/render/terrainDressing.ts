import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { findPath, footprint, type Colony, type PlanetType, type Surface } from '../engine/index.ts';

/**
 * Makes planet surfaces believable:
 *  - a splat-mapped ground material (Poly Haven CC0 textures, public/textures/terrain) blending
 *    ground / variation / cliff rock (triplanar) / shore / road per vertex,
 *  - dirt roads linking the colony's buildings (A* over land, minimum spanning tree),
 *  - instanced vegetation + rocks (Kenney Nature Kit CC0, public/models/nature) on free land.
 */

interface Biome {
  ground: string; ground2: string; rock: string; shore: string; road: string;
  tint: string;
  land: [string, number][]; landDensity: number;
  rough: [string, number][]; roughDensity: number;
  /** Recolour the props for this world (snowy pines, charred rocks). */
  propTint?: { color: string; amount: number };
  /** Per-material colour overrides for this world (sRGB hex), e.g. ash instead of grass tufts. */
  palette?: Record<string, string>;
}

const ROCKS: [string, number][] = [['rock_tallA', 2], ['rock_tallC', 2], ['rock_tallF', 1], ['rock_largeB', 2], ['rock_largeD', 1], ['stone_tallB', 1]];

const BIOMES: Record<PlanetType, Biome> = {
  terran: {
    ground: 'rocky_terrain_02', ground2: 'leafy_grass', rock: 'rock_face_03', shore: 'coast_sand_01', road: 'dry_ground_rocks', tint: '#ffffff',
    land: [['tree_oak', 3], ['tree_default', 3], ['tree_detailed', 2], ['tree_fat', 1], ['tree_pineRoundA', 2], ['plant_bush', 3], ['plant_bushLarge', 2], ['grass_large', 5], ['flower_yellowA', 2], ['flower_redA', 2], ['mushroom_redGroup', 1], ['stump_round', 1], ['log', 1], ['rock_smallA', 2], ['rock_largeA', 1]],
    landDensity: 1.15,
    rough: [['tree_pineTallA_detailed', 3], ['tree_pineRoundC', 2], ['tree_pineSmallA', 2], ...ROCKS], roughDensity: 1.3,
  },
  ocean: {
    ground: 'leafy_grass', ground2: 'sparse_grass', rock: 'rock_face_03', shore: 'coast_sand_01', road: 'dry_ground_rocks', tint: '#ffffff',
    land: [['tree_palmTall', 3], ['tree_palmBend', 3], ['tree_palmShort', 2], ['plant_bush', 3], ['plant_bushDetailed', 2], ['grass_large', 5], ['flower_redA', 1], ['rock_smallA', 2]],
    landDensity: 1.3,
    rough: [['tree_palmTall', 2], ...ROCKS], roughDensity: 1,
  },
  desert: {
    ground: 'sandstone_cracks', ground2: 'dry_ground_rocks', rock: 'rock_face_03', shore: 'dry_ground_rocks', road: 'stony_dirt_path', tint: '#fff2e2',
    land: [['cactus_tall', 3], ['cactus_short', 3], ['rock_smallFlatA', 3], ['rock_smallC', 2], ['rock_largeD', 1], ['stump_old', 1], ['tree_thin_dark', 1]],
    landDensity: 0.55,
    rough: [['rock_tallC', 3], ['rock_tallF', 3], ['rock_largeB', 2], ['rock_tallA', 1]], roughDensity: 1.1,
    propTint: { color: '#d9a06a', amount: 0.25 },
    palette: { grass: '#a48d58', leafsGreen: '#6f7d3a', leafsDark: '#5e6a34', dirt: '#9a6a42', _defaultMat: '#b08a68', stone: '#b9987a' },
  },
  volcanic: {
    ground: 'burned_ground_01', ground2: 'dark_rock_02', rock: 'dark_rock', shore: 'burned_ground_01', road: 'dry_ground_rocks', tint: '#e8dcd6',
    land: [['rock_largeD', 2], ['rock_smallC', 3], ['rock_smallFlatA', 2], ['tree_thin_dark', 2], ['stump_old', 1]],
    landDensity: 0.55,
    rough: [['rock_tallC', 3], ['rock_tallF', 3], ['rock_largeB', 2], ['stone_tallB', 2]], roughDensity: 1.1,
    propTint: { color: '#2a201c', amount: 0.3 },
    palette: { grass: '#3a2f2a', leafsGreen: '#2b2522', leafsDark: '#2b2522', leafsFall: '#3a2a22', dirt: '#2f2622', _defaultMat: '#3d3532', stone: '#4a403b', woodBark: '#241c18', woodBarkDark: '#1c1613' },
  },
  ice: {
    ground: 'snow_02', ground2: 'snow_field_aerial', rock: 'dark_rock_02', shore: 'snow_field_aerial', road: 'snow_field_aerial', tint: '#f4f8ff',
    land: [['tree_pineSmallA', 3], ['tree_pineRoundC', 1], ['rock_smallA', 2], ['stone_largeA', 1], ['rock_smallFlatA', 1]],
    landDensity: 0.6,
    rough: [['tree_pineTallA_detailed', 2], ['rock_tallA', 2], ['stone_tallB', 2], ['rock_largeB', 1]], roughDensity: 1,
    propTint: { color: '#e8f2fa', amount: 0.25 },
    palette: { grass: '#e6eef4', dirt: '#c9d6df', leafsGreen: '#3d5e4c', leafsDark: '#33503f', _defaultMat: '#7d8892', stone: '#8e9aa4' },
  },
  barren: {
    ground: 'ground_grey', ground2: 'rocky_terrain_02', rock: 'rock_face_03', shore: 'ground_grey', road: 'dry_ground_rocks', tint: '#d8d6d2',
    land: [['rock_smallA', 3], ['rock_smallC', 3], ['rock_largeA', 1], ['rock_smallFlatA', 3], ['stone_largeA', 1]],
    landDensity: 0.7,
    rough: [['rock_tallA', 3], ['rock_tallC', 2], ['rock_tallF', 2], ['stone_tallB', 2], ['rock_largeB', 2]], roughDensity: 1.2,
    propTint: { color: '#9a9690', amount: 0.2 },
    palette: { grass: '#7a756d', dirt: '#6f6a63', _defaultMat: '#85817b', stone: '#9a968f' },
  },
  gas: {
    ground: 'ground_grey', ground2: 'ground_grey', rock: 'rock_face_03', shore: 'ground_grey', road: 'dry_ground_rocks', tint: '#ffffff',
    land: [], landDensity: 0, rough: [], roughDensity: 0,
  },
};

const isGreenGrass = (n: string) => n === 'rocky_terrain_02' || n === 'leafy_grass' || n === 'sparse_grass';
// rocky_terrain_02 is a grassy texture; on barren worlds we want it as gravelly ground, so grade it
const BARREN_GRADE = new THREE.Color(0.72, 0.7, 0.68);

// ---------------------------------------------------------------- ground material

const texCache = new Map<string, THREE.Texture>();
function tex(name: string): THREE.Texture {
  let t = texCache.get(name);
  if (!t) {
    t = new THREE.TextureLoader().load(`textures/terrain/${name}.webp`);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    texCache.set(name, t);
  }
  return t;
}

export function makeGroundMaterial(type: PlanetType): THREE.MeshStandardMaterial {
  const b = BIOMES[type];
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.96, metalness: 0 });
  const tint = new THREE.Color(b.tint);
  if (type === 'barren' && isGreenGrass(b.ground2)) tint.multiply(BARREN_GRADE);
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      tGround: { value: tex(b.ground) }, tGround2: { value: tex(b.ground2) }, tRock: { value: tex(b.rock) },
      tShore: { value: tex(b.shore) }, tRoad: { value: tex(b.road) }, uScale: { value: 1 / 9 }, uTint: { value: tint },
      uGrade2: { value: type === 'barren' ? 1 : 0 },
    });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aSplat;\nvarying vec4 vSplat;\nvarying vec3 vWPos;\nvarying vec3 vWNormal;')
      .replace('#include <fog_vertex>', '#include <fog_vertex>\nvSplat = aSplat;\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWNormal = normalize(mat3(modelMatrix) * objectNormal);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D tGround; uniform sampler2D tGround2; uniform sampler2D tRock; uniform sampler2D tShore; uniform sampler2D tRoad;
        uniform float uScale; uniform vec3 uTint; uniform float uGrade2;
        varying vec4 vSplat; varying vec3 vWPos; varying vec3 vWNormal;`)
      .replace('#include <map_fragment>', `
        vec2 uv = vWPos.xz * uScale;
        // two scales of the base ground break up visible tiling
        vec3 g1 = mix(texture2D(tGround, uv).rgb, texture2D(tGround, uv * 0.27 + vec2(0.37, 0.61)).rgb, 0.45);
        vec3 g2 = texture2D(tGround2, uv * 0.8 + 0.13).rgb;
        g2 = mix(g2, vec3(dot(g2, vec3(0.33))) * vec3(0.95, 0.93, 0.9), uGrade2);
        vec3 col = mix(g1, g2, vSplat.x);
        col = mix(col, texture2D(tShore, uv * 1.1).rgb, vSplat.z);
        vec3 w = abs(normalize(vWNormal)); w = pow(w, vec3(4.0)); w /= (w.x + w.y + w.z);
        float rs = uScale * 0.8;
        vec3 rock = texture2D(tRock, vWPos.zy * rs).rgb * w.x + texture2D(tRock, vWPos.xz * rs).rgb * w.y + texture2D(tRock, vWPos.xy * rs).rgb * w.z;
        col = mix(col, rock, vSplat.y);
        col = mix(col, texture2D(tRoad, uv * 1.6).rgb, vSplat.w);
        diffuseColor.rgb *= col * uTint;`);
  };
  return mat;
}

// ---------------------------------------------------------------- splat weights

export interface TerrainCtx {
  surface: Surface;
  cell: number;
  heightScale: number;
  world(cx: number, cy: number): { x: number; z: number };
  heightAt(fx: number, fy: number): number;
}

/** Writes aSplat = (variation, rock, shore, road) per vertex. Call after computeVertexNormals(). */
export function paintSplat(geo: THREE.BufferGeometry, ctx: TerrainCtx, roads: [number, number, number, number][], hasLiquid: boolean) {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const nrm = geo.attributes.normal as THREE.BufferAttribute;
  let attr = geo.attributes.aSplat as THREE.BufferAttribute | undefined;
  if (!attr) {
    attr = new THREE.BufferAttribute(new Float32Array(pos.count * 4), 4);
    geo.setAttribute('aSplat', attr);
  }
  const H = ctx.heightScale;
  const roadW = ctx.cell * 0.42;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const slope = 1 - nrm.getY(i);
    const vary = smooth(0.35, 0.75, valueNoise(x * 0.045, z * 0.045));
    let rock = Math.max(smooth(0.22, 0.42, slope), smooth(1.35 * H, 1.9 * H, y));
    const shore = hasLiquid ? smooth(0.32 * H, 0.05 * H, y) : smooth(-0.1 * H, -0.5 * H, y);
    let road = 0;
    if (roads.length && rock < 0.5) {
      let best = Infinity;
      for (const [ax, az, bx, bz] of roads) best = Math.min(best, segDist(x, z, ax, az, bx, bz));
      road = smooth(roadW, roadW * 0.55, best) * (0.85 + 0.15 * valueNoise(x * 0.6, z * 0.6));
      rock *= 1 - road;
    }
    attr.setXYZW(i, vary, rock, shore, road);
  }
  attr.needsUpdate = true;
}

/** Dirt roads: minimum spanning tree over the buildings, each edge walked with A* over land; plus one road off-map. */
export function roadSegments(ctx: TerrainCtx, colony: Colony | null): [number, number, number, number][] {
  if (!colony || colony.structures.length === 0) return [];
  const s = ctx.surface;
  const nodes = colony.structures.map((st) => {
    const f = footprint(st.building);
    // the road meets the building at the front edge of its footprint
    return [st.x + (f - 1) / 2, st.y + f - 0.5] as [number, number];
  });
  const segs: [number, number, number, number][] = [];
  const addPath = (from: [number, number], to: [number, number]) => {
    const path = findPath(s, from[0], from[1], to[0], to[1]);
    let prev = from;
    for (const p of path) {
      const a = ctx.world(prev[0], prev[1]), b = ctx.world(p[0], p[1]);
      segs.push([a.x, a.z, b.x, b.z]);
      prev = p;
    }
  };
  // Prim's MST on straight-line distance
  const inTree = [0];
  const rest = nodes.map((_, i) => i).slice(1);
  while (rest.length) {
    let bi = -1, bj = -1, bd = Infinity;
    for (const i of inTree)
      for (const j of rest) {
        const d = Math.hypot(nodes[i][0] - nodes[j][0], nodes[i][1] - nodes[j][1]);
        if (d < bd) [bi, bj, bd] = [i, j, d];
      }
    addPath(nodes[bi], nodes[bj]);
    inTree.push(bj);
    rest.splice(rest.indexOf(bj), 1);
  }
  // a supply road out to the nearest reachable map edge
  const hub = nodes[0];
  const edges: [number, number][] = [];
  for (let i = 0; i < s.w; i++)
    for (const [ex, ey] of [[i, 0], [i, s.h - 1], [0, i], [s.w - 1, i]] as [number, number][])
      if (s.kinds[ey * s.w + ex] === 'land') edges.push([ex, ey]);
  edges.sort((a, b) => Math.hypot(a[0] - hub[0], a[1] - hub[1]) - Math.hypot(b[0] - hub[0], b[1] - hub[1]));
  // the nearest edge cell might be cut off by water or ridges: take the first one we can actually reach
  const edge = edges.slice(0, 12).find((e) => findPath(s, hub[0], hub[1], e[0], e[1]).length > 0) ?? null;
  if (edge) {
    addPath(hub, edge);
    const a = ctx.world(edge[0], edge[1]);
    const dir = edge[0] === 0 ? [-1, 0] : edge[0] === s.w - 1 ? [1, 0] : edge[1] === 0 ? [0, -1] : [0, 1];
    const b = ctx.world(edge[0] + dir[0] * 3, edge[1] + dir[1] * 3);
    segs.push([a.x, a.z, b.x, b.z]);
  }
  return segs;
}

// ---------------------------------------------------------------- props

/**
 * Kenney authored the kit's colours as sRGB numbers in glTF's linear baseColorFactor, so they render
 * pastel (mint leaves, salmon dirt). Repaint by material name with a natural palette (sRGB hex).
 */
const PALETTE: Record<string, string> = {
  leafsGreen: '#4c7f2d', leafsDark: '#2f5d2b', leafsFall: '#b5651f', grass: '#5c8a34',
  woodBark: '#5c3e28', woodBarkDark: '#3f2b1e', woodInner: '#b89a72', woodBirch: '#d9d3c5',
  dirt: '#6b4b33', _defaultMat: '#8e8a84', stone: '#9ba1a3', colorRed: '#b3343a', colorYellow: '#dca631',
};

const propCache = new Map<string, Promise<THREE.Object3D | null>>();
function loadProp(name: string): Promise<THREE.Object3D | null> {
  let p = propCache.get(name);
  if (!p) {
    p = new GLTFLoader().loadAsync(`models/nature/${name}.glb`).then((g) => {
      g.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (m && PALETTE[m.name]) { m.color.set(PALETTE[m.name]); m.roughness = 0.9; m.metalness = 0; }
      });
      return g.scene;
    }).catch(() => null);
    propCache.set(name, p);
  }
  return p;
}

/**
 * Instanced scatter of trees/rocks/plants. Rebuild whenever the free land changes;
 * `blocked(cx, cy)` says whether a surface cell is taken (buildings, construction, roads).
 */
export async function buildScatter(
  type: PlanetType, ctx: TerrainCtx, margin: number, seed: number,
  blocked: (cx: number, cy: number) => boolean, roads: [number, number, number, number][],
  clearing: { x: number; y: number; r: number } | null = null,
): Promise<THREE.Group> {
  const b = BIOMES[type];
  const group = new THREE.Group();
  const s = ctx.surface;
  const placements = new Map<string, THREE.Matrix4[]>();
  const rnd = mulberry(seed);
  const pick = (table: [string, number][]) => {
    let r = rnd() * table.reduce((n, [, w]) => n + w, 0);
    for (const [name, w] of table) if ((r -= w) <= 0) return name;
    return table[table.length - 1][0];
  };
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  const roadW = ctx.cell * 0.45;
  for (let cy = -margin; cy < s.h + margin; cy++)
    for (let cx = -margin; cx < s.w + margin; cx++) {
      const inside = cx >= 0 && cy >= 0 && cx < s.w && cy < s.h;
      const kind = inside ? s.kinds[cy * s.w + cx] : 'rough';
      if (kind === 'liquid' || (inside && kind === 'land' && blocked(cx, cy))) { rnd(); continue; }
      const table = kind === 'land' ? b.land : b.rough;
      let n = kind === 'land' ? b.landDensity : b.roughDensity;
      if (!inside) n *= 0.8;
      // clumpy, natural distribution: low-frequency noise thins some areas out
      n *= 0.35 + 1.3 * valueNoise(cx * 0.21 + seed * 0.001, cy * 0.21);
      // the settlement sits in a clearing that thins out toward the wilds
      if (clearing && kind === 'land') n *= Math.min(1, Math.max(0.08, (Math.hypot(cx - clearing.x, cy - clearing.y) - clearing.r) / 4));
      let count = Math.floor(n) + (rnd() < n % 1 ? 1 : 0);
      while (count-- > 0 && table.length) {
        const fx = cx + (rnd() - 0.5) * 0.9, fy = cy + (rnd() - 0.5) * 0.9;
        const w = ctx.world(fx, fy);
        if (roads.length && roads.some(([ax, az, bx, bz]) => segDist(w.x, w.z, ax, az, bx, bz) < roadW)) continue;
        const name = pick(table);
        const big = name.startsWith('tree') || name.startsWith('rock_tall') || name.startsWith('stone_tall') || name.startsWith('cactus_tall');
        const scale = (big ? 2.2 : 1.6) + rnd() * (big ? 1.4 : 1);
        q.setFromAxisAngle(up, rnd() * Math.PI * 2);
        m.compose(new THREE.Vector3(w.x, ctx.heightAt(fx, fy) - 0.05, w.z), q, new THREE.Vector3(scale, scale, scale));
        (placements.get(name) ?? placements.set(name, []).get(name)!).push(m.clone());
      }
    }

  const tint = b.propTint ? new THREE.Color(b.propTint.color) : null;
  await Promise.all([...placements].map(async ([name, mats]) => {
    const proto = await loadProp(name);
    if (!proto) return;
    proto.updateMatrixWorld(true);
    proto.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      let material = mesh.material as THREE.MeshStandardMaterial;
      const override = b.palette?.[material.name];
      const own = !!(tint || override);
      if (own) {
        material = material.clone();
        if (override) material.color.set(override);
        if (tint) material.color.lerp(tint, b.propTint!.amount);
      }
      const inst = new THREE.InstancedMesh(mesh.geometry, material, mats.length);
      mats.forEach((mm, i) => inst.setMatrixAt(i, mm.clone().multiply(mesh.matrixWorld)));
      inst.castShadow = true;
      inst.receiveShadow = true;
      inst.userData.ownMaterial = own;
      group.add(inst);
    });
  }));
  return group;
}

export function disposeScatter(g: THREE.Group) {
  g.traverse((o) => {
    const i = o as THREE.InstancedMesh;
    if (!i.isInstancedMesh) return;
    i.dispose();
    if (i.userData.ownMaterial) (i.material as THREE.Material).dispose();
  });
}

// ---------------------------------------------------------------- helpers

function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
  return Math.hypot(px - ax - t * dx, pz - az - t * dz);
}
const smooth = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
function hash(x: number, y: number) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function valueNoise(x: number, y: number) {
  const x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0;
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  const a = hash(x0, y0) + (hash(x0 + 1, y0) - hash(x0, y0)) * sx;
  const b = hash(x0, y0 + 1) + (hash(x0 + 1, y0 + 1) - hash(x0, y0 + 1)) * sx;
  return a + (b - a) * sy;
}
function mulberry(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
