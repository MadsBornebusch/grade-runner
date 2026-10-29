// Each week's plan phase, kept once the week has started: the plan only
// holds this week and the ones ahead, and the Progress page's load chart
// shades past weeks by what they were planned as.
import type { Phase } from "../plan/planGenerator";
import { createLocalStore } from "./localStore";

export const phaseLogStore = createLocalStore<{ version: 1; byWeek: Record<string, Phase> }>("grade-runner.phaseLog.v1", {
  version: 1,
  byWeek: {},
});
