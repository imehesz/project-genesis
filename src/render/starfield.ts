import * as THREE from 'three';

/** Distant stars as additive points on a large shell. */
export function createStarfield(count = 7000, radius = 400): THREE.Points {
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const u = Math.random() * 2 - 1;
    const t = Math.random() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const r = radius * (0.85 + Math.random() * 0.15);
    pos.set([Math.cos(t) * s * r, u * r, Math.sin(t) * s * r], i * 3);
    const k = Math.random();
    c.setHSL(k < 0.7 ? 0.6 : k < 0.9 ? 0.08 : 0.0, 0.5 + Math.random() * 0.4, 0.75 + Math.random() * 0.25);
    col.set([c.r, c.g, c.b], i * 3);
    size[i] = Math.random() < 0.03 ? 3.5 : 0.6 + Math.random() * 1.4;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('size', new THREE.BufferAttribute(size, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) } },
    vertexShader: /* glsl */ `
      attribute float size;
      varying vec3 vColor;
      varying float vTw;
      uniform float uTime;
      uniform float uPixelRatio;
      void main() {
        vColor = color;
        vTw = 0.75 + 0.25 * sin(uTime * 1.7 + position.x * 0.37 + position.y * 0.11);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * uPixelRatio * 2.0;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      varying float vTw;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d);
        gl_FragColor = vec4(vColor * vTw * a * 1.6, a);
      }`,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  return new THREE.Points(geo, mat);
}

/** Procedural nebula painted on the inside of a big sphere (fbm noise, no textures). */
export function createNebula(radius = 450): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      uniform float uTime;
      float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      float noise(vec3 x) {
        vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
                   mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
      }
      float fbm(vec3 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 6; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }
      void main() {
        vec3 d = vDir;
        float t = uTime * 0.004;
        float n1 = fbm(d * 2.2 + vec3(t, 0.0, -t));
        float n2 = fbm(d * 4.5 + n1 * 1.8);
        float band = exp(-pow(d.y * 2.6 + 0.35 * sin(d.x * 2.0), 2.0));
        vec3 teal = vec3(0.03, 0.22, 0.30);
        vec3 violet = vec3(0.20, 0.06, 0.32);
        vec3 amber = vec3(0.55, 0.28, 0.08);
        vec3 col = mix(teal, violet, smoothstep(0.35, 0.7, n2));
        col += amber * pow(smoothstep(0.55, 0.85, n2 * n1 * 1.6), 2.0) * band;
        float dens = smoothstep(0.32, 0.8, n2) * (0.25 + band * 0.9);
        vec3 base = vec3(0.004, 0.006, 0.014);
        gl_FragColor = vec4(base + col * dens * 0.55, 1.0);
      }`,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 32), mat);
}
