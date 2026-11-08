import { asset } from './asset.ts';
/**
 * Cutscene registry. Drop the video file at public/cutscenes/<id>.mp4 and it plays;
 * until then a placeholder card is shown in its place.
 */
export interface CutsceneDef {
  id: string;
  title: string;
  /** Shown on the placeholder so you remember what the scene is for. */
  note: string;
}

export const CUTSCENES: Record<string, CutsceneDef> = {
  intro: {
    id: 'intro',
    title: 'Prologue',
    note: 'Campaign opening: the galaxy, the three powers, why the war begins.',
  },
  'c1-intro': {
    id: 'c1-intro',
    title: 'Campaign 1 · Opening',
    note: 'The commander receives the ship and the order to reach the silent colony in this system.',
  },
  'c1-briefing': {
    id: 'c1-briefing',
    title: 'Mission briefing',
    note: 'Short in-game briefing (plays in the popup): what the commander has to do, and the goals of this session.',
  },
  'c1-rune': {
    id: 'c1-rune',
    title: 'The rune',
    note: 'The commander touches the rune. What it shows them, and why Kharon and Nyx are now reachable.',
  },
};

export const cutsceneSrc = (id: string) => asset(`cutscenes/${id}.mp4`);
