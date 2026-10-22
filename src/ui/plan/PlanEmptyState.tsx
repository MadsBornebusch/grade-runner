import { CalendarDots, CloudArrowDown, Mountains, Timer, type Icon } from "@phosphor-icons/react";
import type { PlanState } from "../usePlan";
import type { TabId } from "../useHashRoute";

function Empty({ icon: I, tone, title, text, action }: { icon: Icon; tone: string; title: string; text: string; action?: { label: string; onClick: () => void } }) {
  return (
    <div className={`card empty-state empty-state--${tone}`}>
      <span className="empty-state__art" aria-hidden="true">
        <I size={56} weight="duotone" />
      </span>
      <h2>{title}</h2>
      <p>{text}</p>
      {action && (
        <button type="button" className="button-primary" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}

/** What stands between the athlete and a plan, or null when there's a
 * plan to show. */
export function PlanEmptyState({ plan, raceName, navigate }: { plan: PlanState; raceName?: string; navigate: (tab: TabId, ...rest: string[]) => void }) {
  if (plan.blocker === "noRace")
    return (
      <Empty
        icon={Mountains}
        tone="brand"
        title="Pick your goal race"
        text="Your plan is built backwards from race day. Choose a course and a date."
        action={{ label: "Choose a race", onClick: () => navigate("race") }}
      />
    );
  if (plan.blocker === "noPrediction")
    return <Empty icon={Timer} tone="long" title="Working out your race time" text={`Predicting your finish time for ${raceName ?? "the race"}, to size your long runs.`} />;
  if (plan.blocker === "noHistory")
    return (
      <Empty
        icon={CloudArrowDown}
        tone="quality"
        title="No runs yet"
        text="Your plan is sized from your recent running. Connect Strava in Runs and bring in your runs."
        action={{ label: "Open Runs", onClick: () => navigate("runs") }}
      />
    );
  if (plan.error && !plan.snapshot)
    return <Empty icon={CalendarDots} tone="quality" title="Couldn't make a plan" text={`Something in the plan settings tripped it up (${plan.error}). Try changing the race date or your week.`} />;
  if (!plan.history || !plan.snapshot)
    return (
      <Empty
        icon={CalendarDots}
        tone="long"
        title="Preparing your plan"
        text={plan.progress ? `Reading your runs: ${plan.progress.done} of ${plan.progress.total}.` : "Reading your runs."}
      />
    );
  return null;
}
