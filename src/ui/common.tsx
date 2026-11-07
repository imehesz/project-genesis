import type { CSSProperties, ReactNode } from 'react';

export function Stat({ label, value, sub, accent }: { label: string; value: ReactNode; sub?: ReactNode; accent?: boolean }) {
  return (
    <div className={`stat ${accent ? 'stat-accent' : ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub !== undefined && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export function Meter({ value, max, color, marker }: { value: number; max: number; color?: string; marker?: number }) {
  const pct = (v: number) => `${Math.max(0, Math.min(100, (v / Math.max(max, 0.0001)) * 100))}%`;
  return (
    <div className="meter" style={color ? ({ '--mc': color } as CSSProperties) : undefined}>
      <div className="meter-fill" style={{ width: pct(value) }} />
      {marker !== undefined && <div className="meter-marker" style={{ left: pct(marker) }} />}
    </div>
  );
}

export const signed = (v: number, digits = 0) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}`;
