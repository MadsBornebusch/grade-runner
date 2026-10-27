import { Backpack, CaretRight, CheckCircle, CircleHalf, Couch, ForkKnife, Heartbeat, TrendDown, XCircle } from "@phosphor-icons/react";
import { KIND_ICON } from "./kindIcons";
import type { PlannedSession } from "../../plan/planGenerator";
import type { SessionState } from "../../plan/matchSessions";
import { KIND_TITLE, climbDescentText, distanceLine, effortChip, formatMinutes, formatMinutesExact } from "./planCopy";
import type { IntensityTargets } from "./intensity";
import { STRENGTH_FOCUS_TITLE } from "./strengthCopy";

interface SessionCardProps {
  session: PlannedSession;
  state?: SessionState | null;
  /** Minutes actually run that day, for the done line. */
  ranMin?: number;
  /** Bigger type, for Today's hero. */
  hero?: boolean;
  /** Heart-rate targets for the effort chip. */
  targets: IntensityTargets;
  onOpen?: () => void;
}

export function SessionCard({ session, state, ranMin, hero, targets, onOpen }: SessionCardProps) {
  const KindIcon = KIND_ICON[session.kind];
  const key = session.kind === "long" || session.kind === "race";
  // Runs show a distance; hikes and strength only their time.
  const isRun = session.kind !== "strength" && session.kind !== "race" && session.kind !== "hike";
  // A hike's hills are its climb.
  const hills = (isRun && session.descentM >= 50) || (session.kind === "hike" && session.climbM >= 50);
  const focus = session.kind === "strength" && session.strengthFocus ? ` · ${STRENGTH_FOCUS_TITLE[session.strengthFocus]}` : "";
  const cls = [
    "session-card",
    `kind-${session.kind}`,
    key && "session-card--key",
    hero && "session-card--hero",
    state === "done" && "session-card--done",
    state === "skipped" && "session-card--missed",
  ].filter(Boolean).join(" ");
  const effort = state === "done" ? null : effortChip(session, targets);
  return (
    <button type="button" className={cls} onClick={onOpen} disabled={!onOpen}>
      <span className="session-card__tile" aria-hidden="true">
        <KindIcon size={hero ? 30 : 26} weight="duotone" />
      </span>
      <span className="session-card__body">
        <span className="session-card__title">{KIND_TITLE[session.kind]}</span>
        {session.kind === "race" ? null : hero ? (
          <>
            <span className="session-card__big num">{formatMinutes(session.minutes)}</span>
            {isRun && <span className="session-card__sub num">{distanceLine(session)}</span>}
            {focus && <span className="session-card__sub">{focus.slice(3)}</span>}
          </>
        ) : (
          <span className="session-card__sub num">
            {formatMinutes(session.minutes)}
            {isRun && ` · ${distanceLine(session)}`}
            {focus}
          </span>
        )}
        {hills || session.carbsGPerH || effort || session.packPct ? (
          <span className="session-card__chips">
            {effort && (
              <span className={`chip chip--effort${session.steadyMinutes || session.kind === "quality" ? " chip--effort-up" : ""}`}>
                <Heartbeat size={14} /> {effort}
              </span>
            )}
            {session.kind === "hike" && session.packPct && (
              <span className="chip chip--hike">
                <Backpack size={14} /> {session.packPct}% pack
              </span>
            )}
            {hills && (
              <span className="chip chip--descent">
                <TrendDown size={14} /> {climbDescentText(session.climbM, session.descentM)}
              </span>
            )}
            {session.carbsGPerH && session.kind !== "race" ? (
              <span className="chip">
                <ForkKnife size={14} /> {session.carbsGPerH} g/h carbs
              </span>
            ) : null}
          </span>
        ) : null}
      </span>
      <span className="session-card__end">
        {state === "done" && (
          <span className="status status--done">
            <CheckCircle size={18} weight="fill" /> {ranMin ? formatMinutesExact(ranMin) : "Done"}
          </span>
        )}
        {state === "partial" && (
          <span className="status status--partial">
            <CircleHalf size={18} /> {ranMin ? formatMinutesExact(ranMin) : "Shorter"}
          </span>
        )}
        {state === "skipped" && (
          <span className="status status--missed">
            <XCircle size={18} /> Missed
          </span>
        )}
        {onOpen && <CaretRight size={18} className="session-card__chevron" />}
      </span>
    </button>
  );
}

export function RestRow({ text }: { text: string }) {
  return (
    <div className="rest-row">
      <Couch size={20} weight="duotone" aria-hidden="true" />
      <span>{text}</span>
    </div>
  );
}
