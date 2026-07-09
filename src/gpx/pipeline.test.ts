import { describe, expect, it } from "vitest";
import {
  type GpxPoint,
  haversineDistance,
  parseGpx,
  rawCourseStats,
  runPipeline,
} from "./pipeline";

const DEG_PER_M = 1 / 111320;

/** Builds a straight line of points heading due north, climbing at a fixed
 * grade, spaced `spacingM` apart. Timestamps are omitted unless `speedMs` is given. */
function makeLine(opts: {
  n: number;
  spacingM: number;
  grade?: number;
  ele?: boolean;
  speedMs?: number;
}): GpxPoint[] {
  const { n, spacingM, grade = 0, ele = true, speedMs } = opts;
  const points: GpxPoint[] = [];
  for (let i = 0; i < n; i++) {
    const distance = i * spacingM;
    points.push({
      lat: 60 + distance * DEG_PER_M,
      lon: 10,
      ele: ele ? distance * grade : null,
      time: speedMs ? new Date((distance / speedMs) * 1000) : null,
      hr: null,
      power: null,
    });
  }
  return points;
}

describe("haversineDistance", () => {
  it("gives ~111.32 km for one degree of latitude", () => {
    const d = haversineDistance({ lat: 0, lon: 0 }, { lat: 1, lon: 0 });
    expect(d).toBeGreaterThan(110000);
    expect(d).toBeLessThan(112000);
  });
});

describe("parseGpx", () => {
  it("parses lat/lon/ele/time, tolerating missing fields and quote styles", () => {
    const xml = `
      <gpx><trk><trkseg>
        <trkpt lat="60.1" lon="10.2"><ele>123.4</ele><time>2024-01-01T10:00:00Z</time></trkpt>
        <trkpt lat='60.2' lon='10.3'></trkpt>
      </trkseg></trk></gpx>
    `;
    const points = parseGpx(xml);
    expect(points).toHaveLength(2);
    expect(points[0]).toEqual({
      lat: 60.1,
      lon: 10.2,
      ele: 123.4,
      time: new Date("2024-01-01T10:00:00Z"),
      hr: null,
      power: null,
    });
    expect(points[1].lat).toBe(60.2);
    expect(points[1].ele).toBeNull();
    expect(points[1].time).toBeNull();
  });

  it("parses heart rate from a namespaced gpxtpx:hr extension and power from a bare tag", () => {
    const xml = `
      <gpx><trk><trkseg>
        <trkpt lat="60.1" lon="10.2">
          <ele>123.4</ele>
          <extensions>
            <power>231</power>
            <gpxtpx:TrackPointExtension>
              <gpxtpx:hr>142</gpxtpx:hr>
              <gpxtpx:cad>84</gpxtpx:cad>
            </gpxtpx:TrackPointExtension>
          </extensions>
        </trkpt>
        <trkpt lat="60.2" lon="10.3"></trkpt>
      </trkseg></trk></gpx>
    `;
    const points = parseGpx(xml);
    expect(points[0].hr).toBe(142);
    expect(points[0].power).toBe(231);
    expect(points[1].hr).toBeNull();
    expect(points[1].power).toBeNull();
  });
});

describe("runPipeline", () => {
  it("propagates heart rate and power onto segments, and flags their presence", () => {
    const points = makeLine({ n: 20, spacingM: 5 }).map((p, i) => ({
      ...p,
      hr: 140 + i,
      power: 200 + i,
    }));
    const withData = runPipeline(points);
    expect(withData.hasHeartRate).toBe(true);
    expect(withData.hasPower).toBe(true);
    expect(withData.segments.every((s) => s.heartRateBpm !== null)).toBe(true);
    expect(withData.segments.every((s) => s.powerWatts !== null)).toBe(true);

    const withoutData = runPipeline(makeLine({ n: 20, spacingM: 5 }));
    expect(withoutData.hasHeartRate).toBe(false);
    expect(withoutData.hasPower).toBe(false);
    expect(withoutData.segments.every((s) => s.heartRateBpm === null)).toBe(true);
  });

  it("computes gradient, total along-slope distance, and elevation gain for a steady climb", () => {
    const grade = 0.1;
    const points = makeLine({ n: 201, spacingM: 5, grade });
    const result = runPipeline(points);

    expect(result.hasElevation).toBe(true);
    expect(result.hasTimestamps).toBe(false);
    expect(result.segments.length).toBeGreaterThan(0);

    const meanGradient =
      result.segments.reduce((sum, s) => sum + s.gradient, 0) /
      result.segments.length;
    expect(meanGradient).toBeGreaterThan(grade - 0.02);
    expect(meanGradient).toBeLessThan(grade + 0.02);

    const horizontalDistance = 200 * 5;
    const expectedDistance3D = horizontalDistance * Math.sqrt(1 + grade * grade);
    expect(result.totalDistance3D).toBeGreaterThan(expectedDistance3D * 0.98);
    expect(result.totalDistance3D).toBeLessThan(expectedDistance3D * 1.02);

    const expectedGain = horizontalDistance * grade;
    expect(result.totalElevationGain).toBeGreaterThan(expectedGain * 0.9);
    expect(result.totalElevationGain).toBeLessThan(expectedGain * 1.05);

    // cumulative distance must be monotonically increasing
    for (let i = 1; i < result.segments.length; i++) {
      expect(result.segments[i].cumulativeDistance3D).toBeGreaterThan(
        result.segments[i - 1].cumulativeDistance3D,
      );
    }
  });

  it("tracks elevation loss on a steady descent, separately from gain", () => {
    const grade = -0.1;
    const points = makeLine({ n: 201, spacingM: 5, grade });
    const result = runPipeline(points);

    const horizontalDistance = 200 * 5;
    const expectedLoss = horizontalDistance * Math.abs(grade);
    expect(result.totalElevationLoss).toBeGreaterThan(expectedLoss * 0.9);
    expect(result.totalElevationLoss).toBeLessThan(expectedLoss * 1.05);
    expect(result.totalElevationGain).toBeLessThan(expectedLoss * 0.1);
  });

  it("accumulates both gain and loss on an out-and-back climb", () => {
    const up = makeLine({ n: 101, spacingM: 5, grade: 0.1 });
    const lastUp = up[up.length - 1];
    const down = Array.from({ length: 100 }, (_, i) => {
      const distance = (i + 1) * 5;
      return {
        lat: lastUp.lat + distance * DEG_PER_M,
        lon: lastUp.lon,
        ele: (lastUp.ele ?? 0) - distance * 0.1,
        time: null,
        hr: null,
        power: null,
      };
    });
    const result = runPipeline([...up, ...down]);
    expect(result.totalElevationGain).toBeGreaterThan(40);
    expect(result.totalElevationLoss).toBeGreaterThan(40);
  });

  it("falls back to flat (gradient 0) when elevation is missing", () => {
    const points = makeLine({ n: 50, spacingM: 5, ele: false });
    const result = runPipeline(points);

    expect(result.hasElevation).toBe(false);
    for (const segment of result.segments) {
      expect(segment.gradient).toBe(0);
    }
  });

  it("flags a stopped stretch as a paused segment", () => {
    const moving1 = makeLine({ n: 20, spacingM: 5, speedMs: 3 });
    const lastMoving = moving1[moving1.length - 1];
    const pauseStartMs = lastMoving.time!.getTime();

    const pause: GpxPoint[] = Array.from({ length: 20 }, (_, i) => ({
      lat: lastMoving.lat,
      lon: lastMoving.lon,
      ele: 0,
      time: new Date(pauseStartMs + (i + 1) * 30_000), // 30s apart, 600s total
      hr: null,
      power: null,
    }));

    const resumeStartMs = pause[pause.length - 1].time!.getTime();
    const moving2: GpxPoint[] = Array.from({ length: 20 }, (_, i) => {
      const distance = (i + 1) * 5;
      return {
        lat: lastMoving.lat + distance * DEG_PER_M,
        lon: lastMoving.lon,
        ele: 0,
        time: new Date(resumeStartMs + (distance / 3) * 1000),
        hr: null,
        power: null,
      };
    });

    const points = [...moving1, ...pause, ...moving2];
    const result = runPipeline(points);

    expect(result.hasTimestamps).toBe(true);
    expect(result.segments.some((s) => s.paused)).toBe(true);
    // dtS should sum to the total elapsed time across the whole run.
    const totalDtS = result.segments.reduce((sum, s) => sum + (s.dtS ?? 0), 0);
    const expectedTotalS = (moving2[moving2.length - 1].time!.getTime() - moving1[0].time!.getTime()) / 1000;
    expect(totalDtS).toBeCloseTo(expectedTotalS, 0);
  });

  it("leaves dtS null when the course has no timestamps", () => {
    const points = makeLine({ n: 20, spacingM: 5 });
    const result = runPipeline(points);
    for (const segment of result.segments) {
      expect(segment.dtS).toBeNull();
    }
  });

  it("smoothingWindowM changes the result independently of segmentLengthM", () => {
    // Regression guard: an earlier version converted smoothingWindowM to a
    // point-count radius on the resampled grid and floored it at 1 point,
    // which collapsed to the same radius (hence identical output) for any
    // smoothingWindowM smaller than roughly 3x segmentLengthM -- silently
    // making the "smoothing window" control a no-op across most of its
    // range. Noisy elevation (alternating +/-2m jitter) makes smoothing
    // actually change the computed gain, so this would fail on that bug.
    const points = makeLine({ n: 400, spacingM: 2, grade: 0.05 }).map((p, i) => ({
      ...p,
      ele: (p.ele ?? 0) + (i % 2 === 0 ? 2 : -2),
    }));

    const light = runPipeline(points, { segmentLengthM: 50, smoothingWindowM: 10 });
    const heavy = runPipeline(points, { segmentLengthM: 50, smoothingWindowM: 300 });

    expect(heavy.totalElevationGain).toBeLessThan(light.totalElevationGain);
  });

  it("smoothing extent is independent of segmentLengthM at a fixed smoothingWindowM", () => {
    const points = makeLine({ n: 400, spacingM: 2, grade: 0.05 }).map((p, i) => ({
      ...p,
      ele: (p.ele ?? 0) + (i % 2 === 0 ? 2 : -2),
    }));

    const fine = runPipeline(points, { segmentLengthM: 20, smoothingWindowM: 200 });
    const coarse = runPipeline(points, { segmentLengthM: 100, smoothingWindowM: 200 });

    // Both apply the same real-world smoothing window, so gain shouldn't
    // diverge sharply just because segmentLengthM (display resolution) differs.
    const ratio = fine.totalElevationGain / coarse.totalElevationGain;
    expect(ratio).toBeGreaterThan(0.8);
    expect(ratio).toBeLessThan(1.25);
  });
});

describe("rawCourseStats", () => {
  it("matches a simple, noise-free climb exactly (no smoothing to disagree with)", () => {
    const grade = 0.1;
    const points = makeLine({ n: 21, spacingM: 10, grade });
    const stats = rawCourseStats(points);
    expect(stats.distanceM).toBeCloseTo(200, 0);
    expect(stats.elevationGain).toBeCloseTo(20, 0);
    expect(stats.series).toHaveLength(21);
    expect(stats.series[0].distanceM).toBe(0);
    expect(stats.series[20].distanceM).toBeCloseTo(200, 0);
  });

  it("counts noisy up/down jitter as gain, unlike the smoothed pipeline", () => {
    // Flat course with alternating +/-1m jitter: every "up" step counts
    // toward raw gain even though the course doesn't climb at all.
    const points = makeLine({ n: 40, spacingM: 5 }).map((p, i) => ({
      ...p,
      ele: i % 2 === 0 ? 1 : 0,
    }));
    const stats = rawCourseStats(points);
    expect(stats.elevationGain).toBeGreaterThan(15); // ~half the 39 steps are +1m ups

    const processed = runPipeline(points, { segmentLengthM: 20, smoothingWindowM: 40 });
    expect(processed.totalElevationGain).toBeLessThan(stats.elevationGain);
  });
});
