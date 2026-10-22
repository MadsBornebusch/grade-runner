// Daily check-in (sleep and morning HRV), entered by hand until Garmin
// health data is connected. One small row per local date.
import { createLocalStore } from "./localStore";

export interface Checkin {
  sleepH?: number;
  /** 1 poor, 2 ok, 3 good, 4 great. */
  sleepQuality?: 1 | 2 | 3 | 4;
  /** Morning rMSSD, ms. */
  hrvMs?: number;
  /** "Not today": don't ask again this day. */
  skipped?: true;
}

export const checkinStore = createLocalStore<{ version: 1; byDate: Record<string, Checkin> }>("grade-runner.checkins.v1", {
  version: 1,
  byDate: {},
});
