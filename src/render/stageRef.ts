import type { Stage } from './Stage.ts';

/** The live Stage (camera + controls), for HTML widgets that steer the camera (minimaps). */
export const stageRef: { current: Stage | null } = { current: null };
