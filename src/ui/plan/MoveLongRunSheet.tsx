import { useState } from "react";
import { Sheet } from "./Sheet";
import { WEEKDAY_LONG, dayName, shortDate } from "./planCopy";

interface MoveLongRunSheetProps {
  weekStart: number;
  currentWeekday: number;
  today: number;
  onMove: (weekday: number) => void;
  onClose: () => void;
}

export function MoveLongRunSheet({ weekStart, currentWeekday, today, onMove, onClose }: MoveLongRunSheetProps) {
  const [picked, setPicked] = useState(currentWeekday);
  return (
    <Sheet title={`Move the long run, week of ${shortDate(weekStart)}`} onClose={onClose}>
      <div className="day-picker day-picker--wide" role="radiogroup" aria-label="Long run day">
        {Array.from({ length: 7 }, (_, wd) => {
          const day = weekStart + wd;
          return (
            <button
              key={wd}
              type="button"
              role="radio"
              aria-checked={picked === wd}
              disabled={day < today}
              className={picked === wd ? "day-picker__day day-picker__day--on" : "day-picker__day"}
              onClick={() => setPicked(wd)}
            >
              <span>{dayName(day)}</span>
              <span className="day-picker__date num">{shortDate(day).split(" ")[0]}</span>
            </button>
          );
        })}
      </div>
      <p className="help">The other runs move to fit around it. Later weeks keep their own day.</p>
      <div className="sheet__actions">
        <button type="button" className="button-primary" disabled={picked === currentWeekday} onClick={() => onMove(picked)}>
          Move to {WEEKDAY_LONG[picked]}
        </button>
        <button type="button" className="button-ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Sheet>
  );
}
