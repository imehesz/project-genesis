import type { FactionId, PlanetType, StarClass } from './engine/index.ts';

/** Visual palette shared by the Three.js views and the React UI. Not game logic. */
export const FACTION_STYLE: Record<FactionId, { color: string; short: string }> = {
  terran: { color: '#4fa3ff', short: 'Terran' },
  saurian: { color: '#ff7a3a', short: 'Saurian' },
  apex: { color: '#c46bff', short: 'Apex' },
};

export const STAR_STYLE: Record<StarClass, { color: string; size: number; label: string }> = {
  O: { color: '#9db4ff', size: 3.4, label: 'Blue giant' },
  B: { color: '#b4c8ff', size: 2.8, label: 'Blue-white star' },
  A: { color: '#dbe4ff', size: 2.4, label: 'White star' },
  F: { color: '#fbf6ea', size: 2.2, label: 'Yellow-white star' },
  G: { color: '#ffe19a', size: 2.2, label: 'Yellow star' },
  K: { color: '#ffb46b', size: 2.0, label: 'Orange star' },
  M: { color: '#ff7f5c', size: 1.7, label: 'Red dwarf' },
};

export const PLANET_STYLE: Record<PlanetType, { label: string; light: string; dark: string }> = {
  terran: { label: 'Terran', light: '#7fd39a', dark: '#1f5a7a' },
  ocean: { label: 'Ocean', light: '#6fc4ff', dark: '#123a7a' },
  desert: { label: 'Desert', light: '#f2c98a', dark: '#8a5a2a' },
  volcanic: { label: 'Volcanic', light: '#ff8a4a', dark: '#2a0d0a' },
  ice: { label: 'Ice', light: '#e8f6ff', dark: '#6a9ab8' },
  barren: { label: 'Barren', light: '#b8b2a8', dark: '#3c3834' },
  gas: { label: 'Gas giant', light: '#f0b878', dark: '#8a4a3a' },
};

export const PLANET_SIZE_LABEL = ['', 'Tiny', 'Small', 'Medium', 'Large', 'Giant'];
