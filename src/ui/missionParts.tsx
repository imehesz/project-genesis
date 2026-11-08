import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { CUTSCENES, cutsceneSrc } from '../cutscenes.ts';
import type { Mission } from '../engine/index.ts';
import { stageRef } from '../render/stageRef.ts';

/** The session's goals. Objective X stays a mystery until the player finds it. */
export function Objectives({ mission, compact }: { mission: Mission; compact?: boolean }) {
  return (
    <div className={`panel objectives ${compact ? 'is-compact' : ''}`}>
      <div className="panel-title small">Objectives</div>
      <ol>
        {mission.objectives.map((o) => (
          <li key={o.id} className={`${o.done ? 'is-done' : ''} ${o.revealed ? '' : 'is-hidden'}`}>
            <span className="obj-box">{o.done ? '✓' : ''}</span>
            <span>{o.revealed ? o.label : `${o.hidden} · ???`}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * Popup briefing: a short video (placeholder card until public/cutscenes/<id>.mp4 exists) beside
 * the goals for this session.
 */
export function Briefing({ id, mission, onClose }: { id: string; mission: Mission; onClose: () => void }) {
  const [missing, setMissing] = useState(false);
  const def = CUTSCENES[id];
  return (
    <div className="battle-modal">
      <div className="panel briefing">
        <div className="briefing-video">
          {!missing ? (
            <video src={cutsceneSrc(id)} autoPlay playsInline controls onError={() => setMissing(true)} />
          ) : (
            <div className="briefing-placeholder">
              <div className="cutscene-tag">Video placeholder</div>
              <h3>{def?.title ?? id}</h3>
              <p>{def?.note}</p>
              <code>public/{cutsceneSrc(id).replace(/^\/+/, '')}</code>
            </div>
          )}
        </div>
        <div className="briefing-side">
          <div className="battle-kicker">Orders, Commander</div>
          <Objectives mission={mission} />
          <button className="btn btn-primary" onClick={onClose}>Understood ▸</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- minimap

export interface MinimapLayer {
  /** Map size in cells (ground) or world units (space). */
  w: number;
  h: number;
  /** Cell/unit coords -> world X/Z. */
  toWorld(x: number, y: number): { x: number; z: number };
  fromWorld(x: number, z: number): { x: number; y: number };
  /** Static background, drawn once (already scaled to the canvas). */
  background(g: CanvasRenderingContext2D, size: number): void;
  /** Live overlay, redrawn ~12x a second. */
  overlay(g: CanvasRenderingContext2D, size: number): void;
  /** Optional click hook (cell coords); return true to skip the camera jump. */
  onClick?(x: number, y: number): boolean | void;
}

const MAP_PX = 196;

/**
 * Corner minimap: background + live overlay + the camera's view on the ground. Click or drag to move
 * the camera there.
 */
export function Minimap({ layer, label }: { layer: MinimapLayer; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const bg = useRef<HTMLCanvasElement | null>(null);
  const layerRef = useRef(layer);
  layerRef.current = layer;

  useEffect(() => {
    const c = document.createElement('canvas');
    c.width = c.height = MAP_PX;
    layer.background(c.getContext('2d')!, MAP_PX);
    bg.current = c;
  }, [layer.w, layer.h]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let raf = 0, last = 0;
    const draw = (t: number) => {
      raf = requestAnimationFrame(draw);
      if (t - last < 80) return;
      last = t;
      const cv = ref.current, L = layerRef.current;
      if (!cv) return;
      const g = cv.getContext('2d')!;
      g.clearRect(0, 0, MAP_PX, MAP_PX);
      if (bg.current) g.drawImage(bg.current, 0, 0);
      L.overlay(g, MAP_PX);
      // the camera's footprint on the ground
      const st = stageRef.current;
      if (!st) return;
      const pts: { x: number; y: number }[] = [];
      const ray = new THREE.Raycaster();
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      for (const [sx, sy] of [[-1, 1], [1, 1], [1, -1], [-1, -1]]) {
        ray.setFromCamera(new THREE.Vector2(sx, sy), st.camera);
        const hit = new THREE.Vector3();
        if (!ray.ray.intersectPlane(plane, hit)) {
          // looking above the horizon: clamp far along the view direction
          hit.copy(ray.ray.origin).addScaledVector(ray.ray.direction.setY(Math.min(ray.ray.direction.y, -0.05)).normalize(), 400);
        }
        pts.push(L.fromWorld(hit.x, hit.z));
      }
      const k = MAP_PX / Math.max(L.w, L.h);
      g.strokeStyle = 'rgba(255,255,255,0.85)';
      g.lineWidth = 1.2;
      g.beginPath();
      pts.forEach((p, i) => (i ? g.lineTo(p.x * k, p.y * k) : g.moveTo(p.x * k, p.y * k)));
      g.closePath();
      g.stroke();
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  const jump = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const L = layerRef.current;
    const k = Math.max(L.w, L.h) / r.width;
    const x = (e.clientX - r.left) * k, y = (e.clientY - r.top) * k;
    if (e.type === 'pointerdown' && L.onClick?.(x, y)) return;
    const st = stageRef.current;
    if (!st) return;
    const w = L.toWorld(x, y);
    const d = new THREE.Vector3(w.x, st.controls.target.y, w.z).sub(st.controls.target);
    st.controls.target.add(d);
    st.camera.position.add(d);
    st.controls.update();
  };

  return (
    <div className="panel minimap">
      <div className="minimap-label">{label}</div>
      <canvas
        ref={ref}
        width={MAP_PX}
        height={MAP_PX}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); jump(e); }}
        onPointerMove={(e) => { if (e.buttons & 1) jump(e); }}
      />
    </div>
  );
}
