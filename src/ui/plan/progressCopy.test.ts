import { describe, expect, it } from "vitest";
import { loadTrend, modelFinishLabel, predictionDelta } from "./progressCopy";

describe("loadTrend", () => {
  it("shows a rise in any phase", () => {
    expect(loadTrend(0.08, "base")).toEqual({ text: "↑ 8% in 4 weeks", tone: "up" });
  });

  it("frames a drop in an easy phase as planned", () => {
    expect(loadTrend(-0.35, "recovery")?.text).toBe("Recovering, as planned");
    expect(loadTrend(-0.2, "deload")?.text).toBe("Easier week, as planned");
    expect(loadTrend(-0.2, "taper")?.text).toBe("Tapering, as planned");
  });

  it("doesn't headline a drop in a build week", () => {
    expect(loadTrend(-0.35, "base")).toBeNull();
    expect(loadTrend(-0.35, undefined)).toBeNull();
    expect(loadTrend(0.01, "base")?.text).toBe("Steady");
  });
});

describe("predictionDelta", () => {
  it("compares the last prediction with the first", () => {
    const e = [{ date: "2030-10-28", finishS: 30000 }, { date: "2030-11-02", finishS: 29700 }];
    expect(predictionDelta(e)).toEqual({ text: "5 min faster since 28 Oct", faster: true });
    expect(predictionDelta([{ date: "2030-10-28", finishS: 30000 }, { date: "2030-11-02", finishS: 34500 }])?.text).toBe("1 h 15 slower since 28 Oct");
    expect(predictionDelta(e.slice(0, 1))).toBeNull();
  });
});

describe("modelFinishLabel", () => {
  it("says best case until the pacing margin is fitted", () => {
    expect(modelFinishLabel(false)).toBe("Best-case finish");
    expect(modelFinishLabel(true)).toBe("Predicted finish");
  });
});
