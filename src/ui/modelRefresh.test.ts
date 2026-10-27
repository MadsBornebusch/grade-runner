import { describe, expect, it } from "vitest";
import { fitInputsKey } from "./modelRefresh";

const run = (id: string, points: boolean, raceTag?: "race" | "notRace") => ({ id, points: points ? [] : null, raceTag });

describe("fitInputsKey", () => {
  it("is the same for the same runs in any order", () => {
    expect(fitInputsKey([run("a", true), run("b", true, "race")])).toBe(fitInputsKey([run("b", true, "race"), run("a", true)]));
  });

  it("changes when a run gains full data or a race tag, not for summary-only runs", () => {
    const base = fitInputsKey([run("a", true), run("b", false)]);
    expect(fitInputsKey([run("a", true), run("b", false, "race")])).toBe(base);
    expect(fitInputsKey([run("a", true), run("b", true)])).not.toBe(base);
    expect(fitInputsKey([run("a", true, "race"), run("b", false)])).not.toBe(base);
  });

  it("leaves out runs downloaded only for the plan, unless they're races or fit picks", () => {
    const base = fitInputsKey([run("a", true)]);
    expect(fitInputsKey([run("a", true), { ...run("p", true), fullDataForPlan: true }])).toBe(base);
    expect(fitInputsKey([run("a", true), { ...run("p", true, "race"), fullDataForPlan: true }])).not.toBe(base);
    expect(fitInputsKey([run("a", true), { ...run("p", true), fullDataForPlan: true, wantsFullData: true }])).not.toBe(base);
  });
});
