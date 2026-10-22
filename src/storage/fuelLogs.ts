// Carbs taken on long runs (gut training), keyed by StoredRun.id.
import { createLocalStore } from "./localStore";

export interface FuelLog {
  /** Stored as g/h; a total in grams is converted with the moving time. */
  gPerH?: number;
  enteredAs: "gPerH" | "totalG";
  /** Stomach: 0 fine, 1 a bit, 2 bad, 3 had to stop. */
  gi?: 0 | 1 | 2 | 3;
  skipped?: true;
  /** Local date the log was made, YYYY-MM-DD. */
  loggedOn: string;
}

export const fuelLogStore = createLocalStore<{ version: 1; byRunId: Record<string, FuelLog> }>("grade-runner.fuelLogs.v1", {
  version: 1,
  byRunId: {},
});
