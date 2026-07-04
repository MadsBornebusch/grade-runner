import { describe, expect, it } from "vitest";
import {
  type GpxPoint,
  haversineDistance,
  parseGpx,
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
    });
    expect(points[1].lat).toBe(60.2);
    expect(points[1].ele).toBeNull();
    expect(points[1].time).toBeNull();
  });
});

describe("runPipeline", () => {
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
    }));

    const resumeStartMs = pause[pause.length - 1].time!.getTime();
    const moving2: GpxPoint[] = Array.from({ length: 20 }, (_, i) => {
      const distance = (i + 1) * 5;
      return {
        lat: lastMoving.lat + distance * DEG_PER_M,
        lon: lastMoving.lon,
        ele: 0,
        time: new Date(resumeStartMs + (distance / 3) * 1000),
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
});
