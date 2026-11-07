import { engine, useGame, useUi } from '../store/gameStore.ts';
import { TECHS, TECH_IDS, empireTotals, researchBlocker, type TechField, type TechId } from '../engine/index.ts';
import { Meter } from './common.tsx';

const FIELDS: TechField[] = ['Engineering', 'Science', 'Society'];

export function ResearchScreen() {
  const state = useGame((s) => s);
  const go = useUi((s) => s.go);
  const me = state.campaign?.playerFaction;
  const empire = me && state.empires[me];
  if (!me || !empire) return null;
  const perTurn = empireTotals(state, me).research;
  const cur = empire.research.current ? TECHS[empire.research.current] : null;
  const eta = cur ? Math.max(1, Math.ceil((cur.cost - empire.research.progress) / Math.max(0.1, perTurn))) : null;

  return (
    <div className="sheet research">
      <div className="sheet-head">
        <button className="hud-back" onClick={() => go({ name: 'galaxy' })}>
          ◂ Galaxy
        </button>
        <div className="sheet-title">
          <h1>Research</h1>
          <span>
            {perTurn.toFixed(1)} points per turn
            {cur ? ` · ${cur.name} in ${eta} turn${eta! > 1 ? 's' : ''}` : ' · no project selected'}
          </span>
        </div>
      </div>
      <div className="tech-columns">
        {FIELDS.map((field) => (
          <section key={field}>
            <h3 className="field-title">{field}</h3>
            {TECH_IDS.filter((t) => TECHS[t].field === field).map((t) => (
              <TechCard key={t} id={t} done={empire.techs.includes(t)} current={empire.research.current === t}
                progress={empire.research.progress} blocker={researchBlocker(empire, t)} />
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

function TechCard({ id, done, current, progress, blocker }: { id: TechId; done: boolean; current: boolean; progress: number; blocker: string | null }) {
  const t = TECHS[id];
  const cls = done ? 'is-done' : current ? 'is-current' : blocker ? 'is-locked' : '';
  return (
    <button className={`tech-card ${cls}`} disabled={!!blocker && !done}
      onClick={() => !done && engine.dispatch({ type: 'SET_RESEARCH', tech: current ? null : id })}>
      <div className="tech-top">
        <span className="tech-name">{t.name}</span>
        <span className="tech-cost">{done ? '✓' : `${t.cost} rp`}</span>
      </div>
      <div className="tech-effect">{t.effect}</div>
      {current && <Meter value={progress} max={t.cost} />}
      <div className="tech-status">
        {done ? 'Researched' : current ? 'In progress · click to pause' : blocker ?? 'Click to research'}
      </div>
    </button>
  );
}
