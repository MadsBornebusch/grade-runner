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

  it("puts steady between race effort and LT1, and ends easy where steady starts", () => {
    const f = { ...base, lt1HeartRateBpm: 140, lt2HeartRateBpm: 170 };
    const hrAt = heartRateAtPower(f)!;
    const powerAt = (hr: number) => [...Array(4000).keys()].map((k) => k / 200).find((x) => hrAt(x) >= hr)!;
    // Race effort at 132 bpm: steady 132-140, easy under 132.
    expect(intensityTargets(f, powerAt(132))).toMatchObject({ easyMaxHr: 132, steady: { lo: 132, hi: 140 }, raceAtLt1: false });
    // Far below LT1 (a very long race): held to 15 bpm under.
    expect(intensityTargets(f, powerAt(110)).steady).toEqual({ lo: 125, hi: 140 });
    // At or above LT1: the narrow band just under it.
    expect(intensityTargets(f, powerAt(141))).toMatchObject({ raceAtLt1: true, easyMaxHr: 135, steady: { lo: 135, hi: 140 } });
  });

  it("reads heart rate from test stages, interpolating between them", () => {
    const f = { ...base, fatOxPoints: [6, 5.5, 5].map((pace, i) => ({ paceMinPerKm: pace, fatGPerMin: 0.4, carbGPerMin: 2, heartRateBpm: 120 + 10 * i })) };
    const hrAt = heartRateAtPower(f)!;
    const [p6, p55] = [6, 5.5].map((pace) => paceToGrossPowerWPerKg(pace, f.walkMaxMs));
    expect(hrAt(p6)).toBeCloseTo(120);
    expect(hrAt((p6 + p55) / 2)).toBeCloseTo(125);
  });
});
