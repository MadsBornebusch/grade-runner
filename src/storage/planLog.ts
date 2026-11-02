// The past days' planned sessions (plan/planLog.ts), kept in the browser.
import { EMPTY_PLAN_LOG, type PlanLog } from "../plan/planLog";
import { createLocalStore } from "./localStore";

export const planLogStore = createLocalStore<PlanLog>("grade-runner.planLog.v1", EMPTY_PLAN_LOG);
