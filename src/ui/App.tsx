import { asset } from '../asset.ts';
import { useEffect, useRef } from 'react';
import { useUi } from '../store/gameStore.ts';
import { GameCanvas } from './GameCanvas.tsx';
import { MainMenu } from './MainMenu.tsx';
import { Cutscene } from './Cutscene.tsx';
import { SandboxHud } from './SandboxHud.tsx';
import { GalaxyHud } from './GalaxyHud.tsx';
import { BattleHud } from './BattleHud.tsx';
import { GroundHud } from './GroundHud.tsx';
import { ControlsHelp } from './ControlsHelp.tsx';
import { MissionHud } from './MissionHud.tsx';
import { OpHud } from './OpHud.tsx';

const STRATEGIC = new Set(['galaxy', 'colony', 'research', 'surface']);

export function App() {
  const screen = useUi((s) => s.screen);
  const go = useUi((s) => s.go);
  const musicOn = useUi((s) => s.musicOn);
  const music = useRef<HTMLAudioElement>(null);

  // Menu theme: browsers block autoplay, so it starts on the first click/key.
  const wantMusic = musicOn && screen.name !== 'cutscene';
  useEffect(() => {
    const a = music.current;
    if (!a) return;
    a.volume = 0.45;
    if (!wantMusic) {
      a.pause();
      return;
    }
    const tryPlay = () => a.play().catch(() => {});
    tryPlay();
    window.addEventListener('pointerdown', tryPlay, { once: true });
    window.addEventListener('keydown', tryPlay, { once: true });
    return () => {
      window.removeEventListener('pointerdown', tryPlay);
      window.removeEventListener('keydown', tryPlay);
    };
  }, [wantMusic]);

  return (
    <>
      <GameCanvas
        view={screen.name === 'sandbox' ? 'sandbox' : screen.name === 'surface' ? 'surface' : screen.name === 'battle' ? 'battle' : screen.name === 'ground' ? 'ground' : screen.name === 'system' ? 'system' : screen.name === 'op' ? 'op' : STRATEGIC.has(screen.name) ? 'galaxy' : null}
        colonyId={screen.name === 'surface' ? screen.colonyId : undefined}
      />
      <audio ref={music} src={asset('audio/menu-theme.m4a')} loop preload="auto" />
      <div className="ui-layer">
        {screen.name === 'menu' && <MainMenu />}
        {screen.name === 'cutscene' && (
          <Cutscene id={screen.id} onDone={() => go(screen.then)} />
        )}
        {screen.name === 'sandbox' && <SandboxHud />}
        {STRATEGIC.has(screen.name) && <GalaxyHud />}
        {screen.name === 'battle' && <BattleHud />}
        {screen.name === 'ground' && <GroundHud />}
        {screen.name === 'system' && <MissionHud />}
        {screen.name === 'op' && <OpHud />}
        {(STRATEGIC.has(screen.name) || ['battle', 'ground', 'system', 'op'].includes(screen.name)) && <ControlsHelp />}
      </div>
    </>
  );
}
