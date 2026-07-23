import { describe, expect, it } from "vitest";
import type { CourseSegment } from "../gpx/pipeline";
import { findSustainableTheta, simulate, type SolverInputs } from "./solver";

function makeSegments(n: number, segLenM: number, gradient: number): CourseSegment[] {
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
      gradient,
      time: null,
      dtS: null,
      paused: false,
      heartRateBpm: null,
      powerWatts: null,
    });
  }
  return segments;
}

function baseInputs(overrides: Partial<SolverInputs> = {}): SolverInputs {
  return {
    segments: makeSegments(200, 50, 0), // flat 10km
    bodyMassKg: 70,
    fueling: { intakeGPerH: 60 },
    glycogenStoreG: 500,
    ...overrides,
  };
}

describe("simulate", () => {
  it("produces a plausible pace on a flat course at moderate effort", () => {
    const result = simulate(0.6, baseInputs());
    expect(result.feasible).toBe(true);

    const totalDistance = 200 * 50;
    const avgSpeed = totalDistance / result.finishTimeS;
    expect(avgSpeed).toBeGreaterThan(1.5); // faster than a crawl
    expect(avgSpeed).toBeLessThan(5); // slower than an elite sprint
  });

  it("walks on grades too steep to run efficiently", () => {
    const steep = baseInputs({ segments: makeSegments(20, 50, 0.35) });
    const result = simulate(0.5, steep);
    expect(result.feasible).toBe(true);
    expect(result.segments.every((s) => s.mode === "walk")).toBe(true);
  });

  it("runs on the flat at an effort demanding faster than the walk-speed cap", () => {
    // A short course so the duration-decay curve hasn't eroded the ceiling
    // yet; theta=0.9 keeps net target speed comfortably above v_walk_max.
    const result = simulate(0.9, baseInputs({ segments: makeSegments(20, 50, 0) }));
    expect(result.segments.every((s) => s.mode === "run")).toBe(true);
  });

  it("walks flat ground at very easy efforts (Cw < Cr, and the walk cap isn't binding yet)", () => {
    const result = simulate(0.5, baseInputs({ segments: makeSegments(5, 50, 0) }));
    expect(result.segments.every((s) => s.mode === "walk")).toBe(true);
  });

  it("intensityIsAbsolutePower changes what x0/k mean for the substrate split", () => {
    // Same numeric x0/k (0.5, 11) -- a sane %VO2max anchor, but a tiny
    // absolute power anchor. At theta=0.6 on flat ground, gross power is
    // ~8-9 W/kg: in %VO2max mode x is normalized down to ~0.5 (near the
    // anchor, a mixed split); in absolute-power mode x is that ~8-9 W/kg
    // directly (miles past the x0=0.5 anchor, saturating to nearly all carb).
    const asVo2max = simulate(0.6, baseInputs({ substrateParams: { x0: 0.5, k: 11 } }));
    const asPower = simulate(
      0.6,
      baseInputs({ substrateParams: { x0: 0.5, k: 11, intensityIsAbsolutePower: true } }),
    );
    expect(asPower.segments[0].carbRateWPerKg).toBeGreaterThan(asVo2max.segments[0].carbRateWPerKg);
  });

  it("bonks when glycogen is exhausted with no fueling", () => {
    const noFuel = baseInputs({
      segments: makeSegments(2000, 50, 0), // 100km
      fueling: { intakeGPerH: 0 },
      glycogenStoreG: 200,
    });
    const result = simulate(0.8, noFuel);
    expect(result.feasible).toBe(false);
    expect(result.bonkIndex).not.toBeNull();
    // simulation stops at the bonk, not the full course
    expect(result.segments.length).toBeLessThan(2000);
  });

  it("stays feasible over a long course when adequately fueled at low effort", () => {
    const wellFueled = baseInputs({
      segments: makeSegments(2000, 50, 0), // 100km
      fueling: { intakeGPerH: 60 },
      glycogenStoreG: 500,
    });
    const result = simulate(0.4, wellFueled);
    expect(result.feasible).toBe(true);
    expect(result.segments).toHaveLength(2000);
  });
});

describe("findSustainableTheta", () => {
  it("returns theta=1 when the course is easy relative to fueling/glycogen", () => {
    const easy = baseInputs(); // flat 10km, generous fueling
    const { theta, result } = findSustainableTheta(easy);
    expect(theta).toBe(1);
    expect(result.feasible).toBe(true);
  });

  it("finds an intermediate theta for a course that bonks at full effort but not at low effort", () => {
    const long = baseInputs({
      segments: makeSegments(3000, 50, 0), // 150km
      fueling: { intakeGPerH: 40 },
      glycogenStoreG: 400,
    });

    // Sanity: confirm the scenario actually brackets a feasibility boundary.
    // (0.2, not 0.15, is the first comfortably-feasible sample here — below
    // that, target power dips under resting metabolism and simulate reports
    // a stall rather than a bonk; see findSustainableTheta's doc comment.)
    expect(simulate(1, long).feasible).toBe(false);
    expect(simulate(0.2, long).feasible).toBe(true);

    const { theta, result } = findSustainableTheta(long);
    expect(theta).toBeGreaterThan(0.1);
    expect(theta).toBeLessThan(1);
    expect(result.feasible).toBe(true);

    // A meaningfully higher theta should no longer be feasible.
    expect(simulate(theta + 0.05, long).feasible).toBe(false);
  });

  it("predicts a plausible flat marathon finish time (external sanity check)", () => {
    // 42.2km flat, VO2max 50 (decent club runner), default everything else.
    const marathon = baseInputs({ segments: makeSegments(844, 50, 0) });
    const { result } = findSustainableTheta(marathon);
    expect(result.feasible).toBe(true);
    const hours = result.finishTimeS / 3600;
    expect(hours).toBeGreaterThan(3);
    expect(hours).toBeLessThan(4.5);
  });

  it("fuel becomes the binding constraint on a hilly ultra with modest fueling", () => {
    // Rolling +-15% grade over 100km with only 30 g/h intake: the aerobic
    // ceiling alone isn't the limiter here, glycogen is -- theta should be
    // pulled below 1 by the bisection, not just by the duration-decay curve.
    const hilly = makeSegments(2000, 50, 0).map((s, i) => ({
      ...s,
      gradient: Math.sin(i / 40) * 0.15,
    }));
    const hillyInputs = baseInputs({
      segments: hilly,
      fueling: { intakeGPerH: 30 },
      // 390, not 450 -- preserves the same usable-glycogen margin as before
      // the reserve floor moved from 60 to 0 (450-60 == 390-0), so this
      // scenario still lands on the same fuel-bound-not-ceiling-bound edge.
      glycogenStoreG: 390,
    });
    const { theta, result } = findSustainableTheta(hillyInputs);
    expect(result.feasible).toBe(true);
    expect(result.segments).toHaveLength(2000);
    expect(theta).toBeLessThan(1);
  });

  it("reports a real bonk point, not a degenerate stall, when no theta is feasible", () => {
    // Starting glycogen == reserve (0, the default floor): any positive carb
    // demand at all bonks immediately, at every effort level, so no theta
    // can ever be feasible.
    const impossible = baseInputs({
      segments: makeSegments(5000, 50, 0), // 250km
      fueling: { intakeGPerH: 0 },
      glycogenStoreG: 0,
    });
    const { result } = findSustainableTheta(impossible, { lo: 0.05 });
    expect(result.feasible).toBe(false);
    // Must not fall back to the near-zero-effort stall region (segments: [],
    // finishTimeS: 0) -- that would report a meaningless "bonked at 0km/0s"
    // instead of the actual bonk point.
    expect(result.segments.length).toBeGreaterThan(0);
    expect(result.finishTimeS).toBeGreaterThan(0);

    // At a theta well clear of the near-zero stall region, confirm the
    // failure is specifically an immediate bonk, not a stall.
    expect(simulate(0.3, impossible).bonkIndex).toBe(0);
  });
});

describe("descent-based durability drift (PLAN.md §12/§13 stage 5)", () => {
  /**
   * A steep descent for the first half, flat for the second -- so a
   * descent-driven drift term should suppress the ceiling specifically in
   * the second half, slowing it down relative to an otherwise-identical
   * pure-flat course.
   *
   * Elevation actually accumulates here (unlike makeSegments, which always
   * pins elevation at 0 regardless of gradient -- fine for the grade-cost
   * tests above, but this describe block's whole point is exercising
   * solver.ts's own eleDelta tracking, which reads consecutive segments'
   * `elevation`, not `gradient`). altitudeAdjustment is turned off below so
   * the resulting large negative elevation doesn't also perturb the ceiling
   * via the (here, irrelevant) Cerretelli altitude correction -- same
   * reasoning withinRaceDescentDiagnostic.test.ts's synthetic course uses.
   */
  /** Theta chosen so the flat course's baseline run speed sits comfortably
   * above walkMaxMs (~2.96 m/s vs. a 2.0 m/s cap) -- otherwise ANY
   * configured drift rate immediately tips the run/walk choice over to the
   * walk-speed cap, which is then completely insensitive to the rate's
   * actual magnitude and makes every basis/rate combination converge on the
   * exact same (mode-capped, not power-limited) finish time -- a real trap
   * this test tripped into during development. */
  const DESCENT_TEST_THETA = 0.8;

  function frontLoadedDescentSegments(descentSteps: number, flatSteps: number): CourseSegment[] {
    const segLenM = 50;
    const descentGradient = -0.15;
    const segments: CourseSegment[] = [];
    let cumulativeDistance3D = 0;
    let elevation = 0;
    for (let i = 0; i < descentSteps; i++) {
      cumulativeDistance3D += segLenM;
      elevation += descentGradient * segLenM;
      segments.push({
        index: i,
        cumulativeDistance3D,
        distanceHorizontal: segLenM,
        distance3D: segLenM,
        elevation,
        gradient: descentGradient,
        time: null,
        dtS: null,
        paused: false,
        heartRateBpm: null,
        powerWatts: null,
      });
    }
    for (let i = 0; i < flatSteps; i++) {
      cumulativeDistance3D += segLenM;
      segments.push({
        index: descentSteps + i,
        cumulativeDistance3D,
        distanceHorizontal: segLenM,
        distance3D: segLenM,
        elevation, // stays at the bottom of the descent for the flat tail
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

  // 2.5km descent (@ -15% -> 375m) then a 15km flat tail -- long enough
  // after the descent for a moderate drift rate to show up as a genuinely
  // graduated pace change, not just an earlier flip into the walk cap.
  const TEST_COURSE = () => frontLoadedDescentSegments(50, 300);

  it("finishes slower than an otherwise-identical flat course when a descent-drift rate is configured", () => {
    const flat = baseInputs({ segments: makeSegments(350, 50, 0), altitudeAdjustment: false });
    const descentThenFlat = baseInputs({ segments: TEST_COURSE(), altitudeAdjustment: false });

    const withoutDrift = simulate(DESCENT_TEST_THETA, {
      ...descentThenFlat,
      ceilingParams: { durabilityDriftPerDescentUnit: 0.0001 },
      // No basis configured -- exposure never populated, so the rate above must be inert.
    });
    const withDrift = simulate(DESCENT_TEST_THETA, {
      ...descentThenFlat,
      ceilingParams: { durabilityDriftPerDescentUnit: 0.0001 },
      descentExposureBasis: "descentMeters",
    });

    // Must still complete the course -- a rate strong enough to fully
    // saturate the ceiling (driftFactor clamped to 0) would stall the
    // simulation instead of genuinely slowing it, which wouldn't test what
    // this is meant to test.
    expect(withDrift.feasible).toBe(true);
    expect(withDrift.finishTimeS).toBeGreaterThan(withoutDrift.finishTimeS);
    // A real, graduated effect, not a rounding-level nudge.
    expect(withDrift.finishTimeS / withoutDrift.finishTimeS).toBeGreaterThan(1.02);

    // Sanity: the flat course (no descent at all) is unaffected by the same
    // configured rate, confirming the slowdown above is genuinely coming
    // from the descent, not just from the rate being set.
    const flatWithDrift = simulate(DESCENT_TEST_THETA, {
      ...flat,
      ceilingParams: { durabilityDriftPerDescentUnit: 0.0001 },
      descentExposureBasis: "descentMeters",
    });
    const flatWithoutDrift = simulate(DESCENT_TEST_THETA, flat);
    expect(flatWithDrift.finishTimeS).toBeCloseTo(flatWithoutDrift.finishTimeS, 6);
  });

  it("is byte-for-byte unchanged when descentExposureBasis is omitted, even with a rate configured", () => {
    const inputs = baseInputs({ segments: TEST_COURSE(), altitudeAdjustment: false });
    const withRateNoBasis = simulate(DESCENT_TEST_THETA, {
      ...inputs,
      ceilingParams: { durabilityDriftPerDescentUnit: 0.0001 },
    });
    const plain = simulate(DESCENT_TEST_THETA, inputs);
    expect(withRateNoBasis).toEqual(plain);
  });

  it("descentImpact and descentImpactSquared bases also produce a graduated slowdown, without stalling", () => {
    const inputs = baseInputs({ segments: TEST_COURSE(), altitudeAdjustment: false });
    const baseline = simulate(DESCENT_TEST_THETA, inputs);
    // Each basis's units span orders of magnitude apart (see
    // DescentExposureBasis's doc comment in pacingFit.ts), so each needs its
    // own rate to land in a comparable "meaningfully slower, still feasible,
    // still power-limited (not walk-cap-limited)" zone -- not a shared
    // constant.
    const ratesByBasis = { descentImpact: 0.00003, descentImpactSquared: 0.000006 } as const;
    for (const basis of ["descentImpact", "descentImpactSquared"] as const) {
      const result = simulate(DESCENT_TEST_THETA, {
        ...inputs,
        ceilingParams: { durabilityDriftPerDescentUnit: ratesByBasis[basis] },
        descentExposureBasis: basis,
      });
      expect(result.feasible).toBe(true);
      expect(result.finishTimeS / baseline.finishTimeS).toBeGreaterThan(1.01);
    }
  });
});

describe("unpaved terrain cost multiplier", () => {
  const SURFACE_TEST_THETA = 0.8;

  function segmentsWithSurface(n: number, segLenM: number, unpaved: boolean | undefined): CourseSegment[] {
    return makeSegments(n, segLenM, 0).map((s) => ({ ...s, surfaceUnpaved: unpaved }));
  }

  it("finishes slower on an unpaved course than an otherwise-identical paved one, when a multiplier is configured", () => {
    const unpavedCourse = baseInputs({ segments: segmentsWithSurface(200, 50, true), unpavedCostMultiplier: 1.75 });
    const pavedCourse = baseInputs({ segments: segmentsWithSurface(200, 50, false), unpavedCostMultiplier: 1.75 });

    const unpaved = simulate(SURFACE_TEST_THETA, unpavedCourse);
    const paved = simulate(SURFACE_TEST_THETA, pavedCourse);

    expect(unpaved.feasible).toBe(true);
    expect(unpaved.finishTimeS).toBeGreaterThan(paved.finishTimeS);
    // Paved course, all surfaceUnpaved:false, should be unaffected by the
    // multiplier entirely -- it only ever applies to unpaved segments.
    const pavedNoMultiplier = simulate(SURFACE_TEST_THETA, baseInputs({ segments: segmentsWithSurface(200, 50, false) }));
    expect(paved.finishTimeS).toBeCloseTo(pavedNoMultiplier.finishTimeS, 6);
  });

  it("is byte-for-byte unchanged when no segment has surface data, even with a multiplier configured", () => {
    const inputs = baseInputs({ segments: segmentsWithSurface(200, 50, undefined) });
    const withMultiplierNoData = simulate(SURFACE_TEST_THETA, { ...inputs, unpavedCostMultiplier: 1.75 });
    const plain = simulate(SURFACE_TEST_THETA, inputs);
    expect(withMultiplierNoData).toEqual(plain);
  });

  it("multiplier=1 (the default) is a no-op even on a fully unpaved course", () => {
    const segments = segmentsWithSurface(200, 50, true);
    const withDefault = simulate(SURFACE_TEST_THETA, baseInputs({ segments }));
    const withExplicitOne = simulate(SURFACE_TEST_THETA, baseInputs({ segments, unpavedCostMultiplier: 1 }));
    expect(withDefault).toEqual(withExplicitOne);
  });

  it("is a flat, instantaneous effect with no carryover -- a paved segment right after a long unpaved stretch is unaffected", () => {
    // Half unpaved, then half paved -- if this were a cumulative/durability
    // effect (like the discarded earlier design), the back half would still
    // show some lingering penalty. It shouldn't: cost is evaluated fresh
    // per segment from surfaceUnpaved alone. Flat ceiling (f0=fInf, no
    // time-based fade) isolates this from the ceiling's own natural decay,
    // which would otherwise also make the back half differ between the two
    // courses (it starts later, at a different elapsed time, in the mixed
    // course) for a reason that has nothing to do with surface.
    const flatCeiling = { f0: 0.7, fInf: 0.7, tauMin: 250 };
    const segments = [...segmentsWithSurface(100, 50, true), ...segmentsWithSurface(100, 50, false)];
    const mixed = simulate(SURFACE_TEST_THETA, baseInputs({ segments, unpavedCostMultiplier: 1.75, ceilingParams: flatCeiling }));
    const allPaved = simulate(
      SURFACE_TEST_THETA,
      baseInputs({ segments: segmentsWithSurface(200, 50, false), ceilingParams: flatCeiling }),
    );
    const mixedBackHalfTimeS = mixed.segments.slice(100).reduce((s, r) => s + r.timeS, 0);
    const pavedBackHalfTimeS = allPaved.segments.slice(100).reduce((s, r) => s + r.timeS, 0);
    expect(mixedBackHalfTimeS).toBeCloseTo(pavedBackHalfTimeS, 6);
  });
});

describe("per-category surface cost multiplier", () => {
  const SURFACE_TEST_THETA = 0.8;

  function segmentsWithCategory(n: number, segLenM: number, category: CourseSegment["surfaceCategory"]): CourseSegment[] {
    return makeSegments(n, segLenM, 0).map((s) => ({ ...s, surfaceCategory: category }));
  }

  it("finishes slower on a course with a per-category multiplier configured for its surface", () => {
    const pathCourse = baseInputs({ segments: segmentsWithCategory(200, 50, "path"), surfaceCostMultipliers: { path: 1.3 } });
    const baseline = baseInputs({ segments: segmentsWithCategory(200, 50, "path") });
    const withMultiplier = simulate(SURFACE_TEST_THETA, pathCourse);
    const withoutMultiplier = simulate(SURFACE_TEST_THETA, baseline);
    expect(withMultiplier.feasible).toBe(true);
    expect(withMultiplier.finishTimeS).toBeGreaterThan(withoutMultiplier.finishTimeS);
  });

  it("takes priority over unpavedCostMultiplier when the segment's category has an entry", () => {
    const segments = segmentsWithCategory(200, 50, "gravel").map((s) => ({ ...s, surfaceUnpaved: true }));
    const combined = simulate(SURFACE_TEST_THETA, baseInputs({ segments, unpavedCostMultiplier: 1.75, surfaceCostMultipliers: { gravel: 1.1 } }));
    const perCategoryOnly = simulate(SURFACE_TEST_THETA, baseInputs({ segments, surfaceCostMultipliers: { gravel: 1.1 } }));
    expect(combined.finishTimeS).toBeCloseTo(perCategoryOnly.finishTimeS, 6);
  });

  it("falls back to unpavedCostMultiplier when the segment's own category has no entry in the map", () => {
    const segments = segmentsWithCategory(200, 50, "dirt").map((s) => ({ ...s, surfaceUnpaved: true }));
    const combined = simulate(SURFACE_TEST_THETA, baseInputs({ segments, unpavedCostMultiplier: 1.75, surfaceCostMultipliers: { path: 1.3 } }));
    const unpavedOnly = simulate(SURFACE_TEST_THETA, baseInputs({ segments, unpavedCostMultiplier: 1.75 }));
    expect(combined.finishTimeS).toBeCloseTo(unpavedOnly.finishTimeS, 6);
  });

  it("is byte-for-byte unchanged when no segment has a surfaceCategory, even with multipliers configured", () => {
    const inputs = baseInputs({ segments: segmentsWithCategory(200, 50, undefined) });
    const withMultiplierNoData = simulate(SURFACE_TEST_THETA, { ...inputs, surfaceCostMultipliers: { path: 1.3 } });
    const plain = simulate(SURFACE_TEST_THETA, inputs);
    expect(withMultiplierNoData).toEqual(plain);
  });
});
