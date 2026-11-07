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
};

export const cutsceneSrc = (id: string) => asset(`cutscenes/${id}.mp4`);
