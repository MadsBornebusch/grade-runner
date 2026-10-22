import { describe, expect, it } from "vitest";
import { DEFAULT_FORM_INPUTS, type FormInputs } from "../formInputs";
import { effortChip, howToRun } from "./planCopy";
import { heartRateAtPower, intensityTargets } from "./intensity";
import type { PlannedSession } from "../../plan/planGenerator";
import { paceToGrossPowerWPerKg } from "../../model/substrate";

// Synthetic thresholds, not anyone's lab values.
const base: FormInputs = { ...DEFAULT_FORM_INPUTS, lt1HeartRateBpm: null, lt2HeartRateBpm: null, fatOxPoints: [], hrPowerCalibrationSlope: null, hrPowerCalibrationIntercept: null };
const long = (steadyMinutes?: number): PlannedSession => ({ day: 0, kind: "long", minutes: 180, distanceKm: 25, mechanical: 0, descentM: 0, steepDescentM: 0, steadyMinutes });

describe("intensity targets", () => {
  it("has no heart rates without heart-rate settings, and falls back to words", () => {
    const t = intensityTargets(base, 8);
    expect(t).toMatchObject({ easyMaxHr: null, steady: null, quality: null });
    expect(heartRateAtPower(base)).toBeNull();
    expect(effortChip(long(20), t)).toBe("20 min steady");
    expect(howToRun(long(20), "R", false, t)).toContain("race effort");
  });

  it("uses LT2 heart rate directly for threshold work", () => {
    expect(intensityTargets({ ...base, lt2HeartRateBpm: 170 }, null).quality).toEqual({ lo: 165, hi: 172 });
  });

  it("puts the steady block between race effort and LT1, from the line through both thresholds", () => {
    const f = { ...base, lt1HeartRateBpm: 140, lt2HeartRateBpm: 170 };
    const hrAt = heartRateAtPower(f)!;
    const lt1Power = [...Array(400).keys()].map((k) => k / 20).find((x) => hrAt(x) >= 140)!;
    const t = intensityTargets(f, lt1Power - 1);
    expect(t.easyMaxHr).toBe(140);
    expect(t.steady!.hi).toBe(140);
    expect(t.steady!.lo).toBeLessThan(135);
    expect(t.raceAtLt1).toBe(false);
    // Race effort at or above LT1: steady is just under it.
    expect(intensityTargets(f, lt1Power + 1)).toMatchObject({ raceAtLt1: true, steady: { lo: 130, hi: 140 } });
  });

  it("reads heart rate from test stages, interpolating between them", () => {
    const f = { ...base, fatOxPoints: [6, 5.5, 5].map((pace, i) => ({ paceMinPerKm: pace, fatGPerMin: 0.4, carbGPerMin: 2, heartRateBpm: 120 + 10 * i })) };
    const hrAt = heartRateAtPower(f)!;
    const [p6, p55] = [6, 5.5].map((pace) => paceToGrossPowerWPerKg(pace, f.walkMaxMs));
    expect(hrAt(p6)).toBeCloseTo(120);
    expect(hrAt((p6 + p55) / 2)).toBeCloseTo(125);
  });
});
