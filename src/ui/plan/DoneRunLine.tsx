import { useEffect, useState } from "react";
import { CaretRight } from "@phosphor-icons/react";
import type { DatedHistoryRun } from "../../plan/historyFromRuns";
import { looksIndoor } from "../../model/suggestRuns";
import { getStoredRun, type StoredRun } from "../../storage/runLibrary";
import { LapGrades } from "../TreadmillRuns";
import { formatMinutesExact } from "./planCopy";

/** "Ran 45 min · 8.0 km · 120 m up, 120 m down". A run that looks indoor
 * opens its treadmill lap grades from here. */
export function DoneRunLine({ run: r, className }: { run: DatedHistoryRun; className?: string }) {
  const [stored, setStored] = useState<StoredRun | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let cancelled = false;
    getStoredRun(r.runId)
      .then((x) => !cancelled && setStored(x ?? null))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [r]);
  const line = (
    <>
      Ran {formatMinutesExact(r.movingMin)} · {r.distanceKm.toFixed(1)} km · {r.source === "summary" ? "≈" : ""}
      {Math.round(r.climbM)} m up, {Math.round(r.descentM)} m down
    </>
  );
  if (!stored || !looksIndoor(stored)) return <p className={`num ${className ?? ""}`}>{line}</p>;
  return (
    <div className={className}>
      <button type="button" className="done-run num" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span>{line}</span>
        <span className="done-run__action">
          {stored.treadmillLaps ? "Edit grades" : "Add treadmill grades"} <CaretRight size={14} />
        </span>
      </button>
      {open && <LapGrades run={stored} onSaved={() => setOpen(false)} />}
    </div>
  );
}
