import { CaretRight, CheckCircle, CircleHalf, Couch, ForkKnife, TrendDown, XCircle } from "@phosphor-icons/react";
import { KIND_ICON } from "./kindIcons";
import type { PlannedSession } from "../../plan/planGenerator";
import type { SessionState } from "../../plan/matchSessions";
import { KIND_TITLE, distanceLine, formatMinutes, formatMinutesExact } from "./planCopy";

interface SessionCardProps {
  session: PlannedSession;
  state?: SessionState | null;
  /** Minutes actually run that day, for the done line. */
  ranMin?: number;
  /** Bigger type, for Today's hero. */
  hero?: boolean;
  onOpen?: () => void;
}

export function SessionCard({ session, state, ranMin, hero, onOpen }: SessionCardProps) {
  const KindIcon = KIND_ICON[session.kind];
  const key = session.kind === "long" || session.kind === "race";
  const isRun = session.kind !== "strength" && session.kind !== "race";
  const cls = [
    "session-card",
    `kind-${session.kind}`,
    key && "session-card--key",
    hero && "session-card--hero",
    state === "done" && "session-card--done",
    state === "skipped" && "session-card--missed",
  ].filter(Boolean).join(" ");
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
          </>
        ) : (
          <span className="session-card__sub num">
            {formatMinutes(session.minutes)}
            {isRun && ` · ${distanceLine(session)}`}
          </span>
        )}
        {(session.descentM >= 50 && isRun) || session.carbsGPerH ? (
          <span className="session-card__chips">
            {isRun && session.descentM >= 50 && (
              <span className="chip chip--descent">
                <TrendDown size={14} /> {Math.round(session.descentM / 10) * 10} m down
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
