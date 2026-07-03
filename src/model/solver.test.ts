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
      paused: false,
    });
  }
  return segments;
}

function baseInputs(overrides: Partial<SolverInputs> = {}): SolverInputs {
  return {
    segments: makeSegments(200, 50, 0), // flat 10km
    bodyMassKg: 70,
    fueling: { intakeGPerH: 60, gutMaxGPerH: 60 },
    glycogenStoreG: 500,
    reserveG: 60,
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

  it("bonks when glycogen is exhausted with no fueling", () => {
    const noFuel = baseInputs({
      segments: makeSegments(2000, 50, 0), // 100km
      fueling: { intakeGPerH: 0, gutMaxGPerH: 0 },
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
      fueling: { intakeGPerH: 60, gutMaxGPerH: 60 },
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
      fueling: { intakeGPerH: 40, gutMaxGPerH: 60 },
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
      fueling: { intakeGPerH: 30, gutMaxGPerH: 60 },
      glycogenStoreG: 450,
    });
    const { theta, result } = findSustainableTheta(hillyInputs);
    expect(result.feasible).toBe(true);
    expect(result.segments).toHaveLength(2000);
    expect(theta).toBeLessThan(1);
  });

  it("returns the floor theta when the runner starts already at the reserve floor", () => {
    // Starting glycogen == reserve: any positive carb demand at all bonks
    // immediately, at every effort level, so no theta can ever be feasible.
    const impossible = baseInputs({
      segments: makeSegments(5000, 50, 0), // 250km
      fueling: { intakeGPerH: 0, gutMaxGPerH: 0 },
      glycogenStoreG: 60,
      reserveG: 60,
    });
    const { theta, result } = findSustainableTheta(impossible, { lo: 0.05 });
    expect(theta).toBe(0.05);
    expect(result.feasible).toBe(false);

    // At a theta well clear of the near-zero stall region, confirm the
    // failure is specifically an immediate bonk, not a stall.
    expect(simulate(0.3, impossible).bonkIndex).toBe(0);
  });
});
