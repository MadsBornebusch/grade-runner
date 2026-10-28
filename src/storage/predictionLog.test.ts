import { describe, expect, it } from "vitest";
import { raceLogKey, withPrediction } from "./predictionLog";

describe("withPrediction", () => {
  it("adds a changed value and skips an unchanged one", () => {
    const a = withPrediction([], "2030-01-01", 30000);
    expect(a).toEqual([{ date: "2030-01-01", finishS: 30000 }]);
    expect(withPrediction(a, "2030-01-05", 30000.4)).toBe(a);
    expect(withPrediction(a, "2030-01-05", 29500)).toEqual([...a, { date: "2030-01-05", finishS: 29500 }]);
  });

  it("keeps one entry per day, the latest", () => {
    const a = withPrediction(withPrediction([], "2030-01-01", 30000), "2030-01-02", 29000);
    expect(withPrediction(a, "2030-01-02", 28000)).toEqual([
      { date: "2030-01-01", finishS: 30000 },
      { date: "2030-01-02", finishS: 28000 },
    ]);
    // Changed back the same day: the day's change is dropped.
    expect(withPrediction(a, "2030-01-02", 30000)).toEqual([{ date: "2030-01-01", finishS: 30000 }]);
  });

  it("keys by course and date", () => {
    expect(raceLogKey({ courseId: "c1", date: "2030-06-01" })).not.toBe(raceLogKey({ courseId: "c1", date: "2031-06-01" }));
  });
});
