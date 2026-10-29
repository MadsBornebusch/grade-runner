// "Race-day training": the 6-week load on race morning if the plan is
// followed (the bar) against the load before past races of similar length
// (the ticks). On All weeks and on Progress.
import type { Plan } from "../../plan/planGenerator";

export function ReadinessCard({ plan, raceLabel }: { plan: Plan; raceLabel: (day: number) => string }) {
  const best = [...plan.comparableRaces].sort((a, b) => b.chronicBefore - a.chronicBefore)[0];
  const scaleMax = Math.max(plan.projectedChronicAtRace, ...plan.comparableRaces.map((c) => c.chronicBefore)) * 1.15 || 1;
  return (
    <div className="card">
      <h3 className="card-title">Race-day training</h3>
      {plan.comparableRaces.length === 0 ? (
        <p className="help">No past race of similar length to compare with.</p>
      ) : (
        <>
          <div className="readiness">
            <div className="readiness__bar" style={{ width: `${(100 * plan.projectedChronicAtRace) / scaleMax}%` }} />
            {plan.comparableRaces.map((c) => (
              <span key={c.day} className="readiness__tick" style={{ left: `${(100 * c.chronicBefore) / scaleMax}%` }} title={raceLabel(c.day)} />
            ))}
          </div>
          <p className="help">
            Bar: your training on race day if you follow the plan. Ticks: before {[...new Set(plan.comparableRaces.map((c) => raceLabel(c.day)))].join(", ")}.
          </p>
          {best && plan.projectedChronicAtRace >= best.chronicBefore && <p>About as trained as before {raceLabel(best.day)}, or more.</p>}
        </>
      )}
    </div>
  );
}
