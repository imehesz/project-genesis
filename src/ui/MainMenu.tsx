import { startNewCampaign, startStoryCampaign, useGame, useUi } from '../store/gameStore.ts';

export function MainMenu() {
  const go = useUi((s) => s.go);
  const musicOn = useUi((s) => s.musicOn);
  const toggleMusic = useUi((s) => s.toggleMusic);
  const hasCampaign = useGame((s) => s.campaign !== null);
  const inStory = useGame((s) => s.mission !== null);
  const onPlanet = useGame((s) => s.op !== null);

  return (
    <div className="menu">
      <div className="menu-art" />
      <div className="menu-vignette" />
      <div className="menu-panel">
        <div className="menu-kicker">A GALACTIC STRATEGY</div>
        <h1 className="menu-title">
          PROJECT <span>GENESIS</span>
        </h1>
        <div className="menu-rule" />
        <nav className="menu-buttons">
          {hasCampaign && (
            <button className="btn btn-primary" onClick={() => go(inStory ? { name: onPlanet ? 'op' : 'system' } : { name: 'galaxy' })}>
              {inStory ? 'Resume Campaign' : 'Resume Open Galaxy'}
            </button>
          )}
          <button
            className={`btn ${hasCampaign ? '' : 'btn-primary'}`}
            onClick={() => {
              startStoryCampaign();
              go({ name: 'cutscene', id: 'c1-intro', then: { name: 'system' } });
            }}
          >
            New Campaign
          </button>
          <button
            className="btn"
            onClick={() => {
              startNewCampaign();
              go({ name: 'cutscene', id: 'intro', then: { name: 'galaxy' } });
            }}
          >
            Open Galaxy <em>sandbox</em>
          </button>
          <button className="btn" onClick={() => go({ name: 'sandbox' })}>
            Engine Sandbox
          </button>
          <button className="btn" disabled title="Phase 2">
            Multiplayer <em>soon</em>
          </button>
          <button className="btn" disabled>
            Settings <em>soon</em>
          </button>
        </nav>
        <button className="music-toggle" onClick={toggleMusic}>
          {musicOn ? '♪ Music on' : '♪ Music off'}
        </button>
      </div>
      <div className="menu-footer">Phase 1 build · {new Date().getFullYear()}</div>
    </div>
  );
}
