import { describe, expect, it } from "vitest";
import type { CourseSegment } from "../gpx/pipeline";
import {
  buildDescentCapObservations,
  fitDescentCapCurve,
  MIN_DESCENT_CAP_BAND_DISTANCE_M,
  MIN_DESCENT_CAP_DISTANCE_M,
  MIN_STEEP_DESCENT_DISTANCE_M,
  type DescentCapObservation,
} from "./pacingFit";
import { DEFAULT_DESCENT_CAP_CURVE, gradeOnlyMaxDescentSpeedMs } from "./minetti";

function seg(gradient: number, distance3D: number, speedMs: number, over: Partial<CourseSegment> = {}): CourseSegment {
  return {
    index: 0,
    cumulativeDistance3D: 0,
    distanceHorizontal: distance3D,
    distance3D,
    elevation: 0,
    gradient,
    time: null,
    dtS: distance3D / speedMs,
    paused: false,
    heartRateBpm: null,
    powerWatts: null,
    ...over,
  } as CourseSegment;
}

/** n segments of the same band and speed, enough distance to clear the
 * per-band minimum. */
function band(gradient: number, speedMs: number, totalM = 2500): CourseSegment[] {
  const n = 100;
  return Array.from({ length: n }, () => seg(gradient, totalM / n, speedMs));
}

describe("buildDescentCapObservations", () => {
  it("ignores flat, uphill and mild-downhill segments (above the ramp start)", () => {
    const obs = buildDescentCapObservations([[...band(0.1, 3), ...band(0, 3), ...band(-0.02, 4)]]);
    expect(obs).toEqual([]);
  });

  it("drops a band with too little distance to place a percentile on", () => {
    const thin = band(-0.15, 3, MIN_DESCENT_CAP_BAND_DISTANCE_M - 50);
    expect(buildDescentCapObservations([thin])).toEqual([]);
  });

  it("pools the same band across different runs", () => {
    const obs = buildDescentCapObservations([band(-0.15, 3, 1200), band(-0.15, 3, 1200)]);
    expect(obs).toHaveLength(1);
    expect(obs[0].distanceM).toBeCloseTo(2400, 6);
  });

  it("rejects a GPS spike instead of letting it set the band", () => {
    // 2:05/km on a -15% slope is not a run. Without the filter this single
    // segment would define the athlete's entire steep-descent capability.
    const withSpike = [...band(-0.15, 3, 2500), seg(-0.15, 200, 12)];
    const obs = buildDescentCapObservations([withSpike]);
    expect(obs[0].speedMs).toBeLessThan(4);
  });

  it("takes a high percentile, not the median -- most descent is paced, not maximal", () => {
    // 90% of the distance jogged at 2 m/s, 10% genuinely descending at 4.
    // The capability being measured is the 4, not the 2.
    const mixed = [...band(-0.15, 2, 9000), ...band(-0.15, 4, 1000)];
    const obs = buildDescentCapObservations([mixed]);
    expect(obs[0].speedMs).toBeGreaterThan(3);
  });

  it("skips paused segments", () => {
    const paused = band(-0.15, 3, 2500).map((s) => ({ ...s, paused: true }));
    expect(buildDescentCapObservations([paused])).toEqual([]);
  });
});

describe("fitDescentCapCurve", () => {
  const obs = (gradient: number, speedMs: number, distanceM = 1500): DescentCapObservation => ({
    gradient,
    speedMs,
    distanceM,
  });

  it("falls back to defaults without enough total descent distance", () => {
    const fit = fitDescentCapCurve([obs(-0.12, 3, 400), obs(-0.3, 2, 400)]);
    expect(fit.tier).toBe("defaults");
    expect(fit.curve).toEqual(DEFAULT_DESCENT_CAP_CURVE);
  });

  it("never returns a curve that forbids a speed the athlete demonstrated", () => {
    // The whole point. The default cap allows 5:24/km at -10% while this
    // athlete ran 3:44/km there; a fit that still forbids that is the bug.
    const observations = [obs(-0.11, 4.5), obs(-0.17, 3.2), obs(-0.25, 2.4), obs(-0.35, 1.8)];
    const fit = fitDescentCapCurve(observations);
    expect(fit.tier).toBe("full");
    for (const o of observations) {
      expect(gradeOnlyMaxDescentSpeedMs(o.gradient, fit.curve)).toBeGreaterThanOrEqual(o.speedMs - 0.06);
    }
  });

  it("is tight, not merely permissive -- it touches at least one band", () => {
    const fit = fitDescentCapCurve([obs(-0.11, 4.5), obs(-0.17, 3.2), obs(-0.25, 2.4), obs(-0.35, 1.8)]);
    expect(fit.bindingGradients.length).toBeGreaterThan(0);
  });

  it("raises the cap for a fast descender and lowers it for a cautious one", () => {
    const fast = fitDescentCapCurve([obs(-0.11, 4.5), obs(-0.25, 2.8), obs(-0.35, 2.2)]);
    const cautious = fitDescentCapCurve([obs(-0.11, 2.0), obs(-0.25, 1.2), obs(-0.35, 0.8)]);
    expect(fast.curve.onsetSpeedMs).toBeGreaterThan(DEFAULT_DESCENT_CAP_CURVE.onsetSpeedMs);
    expect(cautious.curve.onsetSpeedMs).toBeLessThan(DEFAULT_DESCENT_CAP_CURVE.onsetSpeedMs);
  });

  it("never lets the cap rise as the slope steepens", () => {
    // A fit that produced clamp > onset would say steeper is faster.
    const fit = fitDescentCapCurve([obs(-0.11, 2.5), obs(-0.25, 3.5), obs(-0.4, 3.9)]);
    expect(fit.curve.clampSpeedMs).toBeLessThanOrEqual(fit.curve.onsetSpeedMs);
    const speeds = [-0.12, -0.2, -0.3, -0.4].map((g) => gradeOnlyMaxDescentSpeedMs(g, fit.curve));
    for (let k = 1; k < speeds.length; k++) expect(speeds[k]).toBeLessThanOrEqual(speeds[k - 1]);
  });

  it("holds the clamp anchor at the fallback's shape when there is no steep descent to measure it from", () => {
    // Everything above the steep pivot: the steep end of the line would be
    // pure extrapolation, which is exactly how the hard-coded default got a
    // shape nobody had measured.
    const shallowOnly = [obs(-0.11, 4.5, 4000), obs(-0.15, 3.6, 3000)];
    const fit = fitDescentCapCurve(shallowOnly);
    expect(fit.tier).toBe("onsetOnly");
    expect(fit.steepDescentM).toBeLessThan(MIN_STEEP_DESCENT_DISTANCE_M);
    const ratio = DEFAULT_DESCENT_CAP_CURVE.clampSpeedMs / DEFAULT_DESCENT_CAP_CURVE.onsetSpeedMs;
    expect(fit.curve.clampSpeedMs / fit.curve.onsetSpeedMs).toBeCloseTo(ratio, 6);
  });

  it("reaches the full tier once there is real steep-descent support", () => {
    const fit = fitDescentCapCurve([obs(-0.11, 4.5, 4000), obs(-0.25, 2.4, 2000), obs(-0.35, 1.8, 1000)]);
    expect(fit.tier).toBe("full");
    expect(fit.steepDescentM).toBeGreaterThanOrEqual(MIN_STEEP_DESCENT_DISTANCE_M);
  });

  it("reports the distance behind it so a caller can say how well supported it is", () => {
    const fit = fitDescentCapCurve([obs(-0.11, 4.5, 4000), obs(-0.25, 2.4, 2000)]);
    expect(fit.totalDescentM).toBe(6000);
    expect(fit.bandCount).toBe(2);
    expect(fit.totalDescentM).toBeGreaterThanOrEqual(MIN_DESCENT_CAP_DISTANCE_M);
  });
});
