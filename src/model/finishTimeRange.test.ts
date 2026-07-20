import { describe, expect, it } from "vitest";
import type { CourseSegment } from "../gpx/pipeline";
import { ceilingPower, type CeilingParams } from "./ceiling";
import { predictFinishTimeRange } from "./finishTimeRange";
import type { EffortTrendPoint } from "./pacingFit";
import type { SolverInputs } from "./solver";

/** Builds points where actual power is a constant fraction of the ceiling
 * computed under `trueParams` -- mirrors pacingFit.test.ts's own helper of
 * the same name. */
function makeConstantEffortPoints(
  trueParams: CeilingParams,
  totalHours: number,
  stepMinutes = 5,
  effortLevel = 1.0,
): EffortTrendPoint[] {
  const points: EffortTrendPoint[] = [];
  const stepHours = stepMinutes / 60;
  for (let t = 0; t < totalHours; t += stepHours) {
    const ceiling = ceilingPower({ tMin: t * 60, altitudeM: 0, elapsedHours: t }, trueParams);
    points.push({ tHours: t, grossPowerWPerKg: ceiling * effortLevel, altitudeM: 0, dtS: stepMinutes * 60 });
  }
  return points;
}

/** Raw power trending at a fixed rate off some base level -- races too
 * short for tau to move their own ceiling shape at all, regardless of
 * candidate parameters (mirrors pacingFit.test.ts's "defaults tier" case). */
function makeShortRealisticRace(
  trueParams: CeilingParams,
  totalMinutes: number,
  baseLevel: number,
  trendPerHour: number,
  stepMinutes = 1,
): EffortTrendPoint[] {
  const points: EffortTrendPoint[] = [];
  const refCeiling = ceilingPower({ tMin: 0, altitudeM: 0, elapsedHours: 0 }, trueParams);
  for (let t = 0; t < totalMinutes; t += stepMinutes) {
    const hours = t / 60;
    points.push({ tHours: hours, grossPowerWPerKg: refCeiling * (baseLevel + trendPerHour * hours), altitudeM: 0, dtS: stepMinutes * 60 });
  }
  return points;
}

function makeFlatSegments(n: number, segLenM = 50): CourseSegment[] {
  const segments: CourseSegment[] = [];
  let cumulative = 0;
  for (let i = 0; i < n; i++) {
    cumulative += segLenM;
    segments.push({
      index: i,
      cumulativeDistance3D: cumulative,
      distanceHorizontal: segLenM,
      distance3D: segLenM,
      elevation: 0,
      gradient: 0,
      time: null,
      dtS: null,
      paused: false,
      heartRateBpm: null,
      powerWatts: null,
    });
  }
  return segments;
}

const solverBaseInputs: Omit<SolverInputs, "segments" | "ceilingParams"> = {
  bodyMassKg: 70,
  fueling: { intakeGPerH: 60, gutMaxGPerH: 60 },
  glycogenStoreG: 500,
  reserveG: 60,
};

/** Deterministic seeded PRNG (mulberry32) -- tests can't rely on real
 * Math.random(), and this project's own tooling elsewhere (Workflow
 * scripts) already treats real randomness as something to avoid wherever
 * determinism matters. */
function seededRng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("predictFinishTimeRange", () => {
  const trueParams: CeilingParams = { vo2MaxMlPerKgPerMin: 50, lt2Fraction: 0.85, f0: 0.94, fInf: 0.55, tauMin: 300 };

  it("returns null when the underlying fit can't clear the support gate (the real Soria Moria case)", async () => {
    const races = [
      makeShortRealisticRace(trueParams, 15, 0.8, -0.1),
      makeShortRealisticRace(trueParams, 20, 0.78, -0.05),
      makeShortRealisticRace(trueParams, 18, 0.76, -0.08),
    ];
    const result = await predictFinishTimeRange(
      races,
      races.map(() => null),
      trueParams,
      solverBaseInputs,
      makeFlatSegments(200),
      { rng: seededRng(1) },
    );
    expect(result).toBeNull();
  });

  it("returns a sensible, ordered band on a well-supported synthetic training set", async () => {
    const races = [1, 3, 6, 10, 15].map((h) => makeConstantEffortPoints(trueParams, h));
    const result = await predictFinishTimeRange(
      races,
      races.map(() => null),
      trueParams,
      solverBaseInputs,
      makeFlatSegments(400), // 20km flat
      { rng: seededRng(42), bootstrapSamples: 40 },
    );
    expect(result).not.toBeNull();
    expect(["joint", "tauOnly"]).toContain(result!.tier);
    expect(result!.sampleCount + result!.skippedCount).toBe(40);
    expect(result!.lowFinishTimeS).toBeLessThanOrEqual(result!.medianFinishTimeS);
    expect(result!.medianFinishTimeS).toBeLessThanOrEqual(result!.highFinishTimeS);
    expect(result!.pointEstimateFinishTimeS).toBeGreaterThan(0);
    // The point estimate should sit within a reasonable neighborhood of the
    // bootstrap band, not wildly outside it.
    expect(result!.pointEstimateFinishTimeS).toBeGreaterThan(result!.lowFinishTimeS * 0.8);
    expect(result!.pointEstimateFinishTimeS).toBeLessThan(result!.highFinishTimeS * 1.2);
  });

  it("is deterministic given the same seeded rng", async () => {
    const races = [1, 3, 6, 10, 15].map((h) => makeConstantEffortPoints(trueParams, h));
    const raceDates = races.map(() => null);
    const segments = makeFlatSegments(400);
    const a = await predictFinishTimeRange(races, raceDates, trueParams, solverBaseInputs, segments, {
      rng: seededRng(7),
      bootstrapSamples: 20,
    });
    const b = await predictFinishTimeRange(races, raceDates, trueParams, solverBaseInputs, segments, {
      rng: seededRng(7),
      bootstrapSamples: 20,
    });
    expect(a).toEqual(b);
  });

  it("produces a narrower band with more informative races than with fewer", async () => {
    // makeConstantEffortPoints alone is noiseless (every race matches
    // trueParams' curve exactly), so any subset recovers essentially the
    // same tau and the bootstrap band is near-zero width regardless of
    // sample count -- real cross-race disagreement (real athletes' races
    // don't all fade at exactly the same rate) is what bootstrap variance
    // is actually measuring. Each race gets its own small, deterministic
    // tau jitter (+/-30min) uncorrelated with duration, so pooling more of
    // them genuinely averages out more disagreement than pooling few.
    const jitteredTau = (i: number) => trueParams.tauMin! + (((i * 37) % 21) - 10) * 3;
    const manyRaces = [1, 2, 3, 5, 6, 8, 10, 12, 15, 18].map((h, i) =>
      makeConstantEffortPoints({ ...trueParams, tauMin: jitteredTau(i) }, h),
    );
    const fewRaces = [10, 15].map((h, i) => makeConstantEffortPoints({ ...trueParams, tauMin: jitteredTau(i) }, h));
    const segments = makeFlatSegments(400);

    const many = await predictFinishTimeRange(manyRaces, manyRaces.map(() => null), trueParams, solverBaseInputs, segments, {
      rng: seededRng(3),
      bootstrapSamples: 60,
    });
    const few = await predictFinishTimeRange(fewRaces, fewRaces.map(() => null), trueParams, solverBaseInputs, segments, {
      rng: seededRng(3),
      bootstrapSamples: 60,
    });

    expect(many).not.toBeNull();
    expect(few).not.toBeNull();
    const manyWidth = many!.highFinishTimeS - many!.lowFinishTimeS;
    const fewWidth = few!.highFinishTimeS - few!.lowFinishTimeS;
    expect(manyWidth).toBeLessThan(fewWidth);
  });
});
