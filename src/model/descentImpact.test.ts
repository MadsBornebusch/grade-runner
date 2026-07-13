import { describe, expect, it } from "vitest";
import type { CourseSegment } from "../gpx/pipeline";
import { descentImpact } from "./descentImpact";

function segment(overrides: Partial<CourseSegment> = {}): CourseSegment {
  return {
    index: 0,
    cumulativeDistance3D: 0,
    distanceHorizontal: 50,
    distance3D: 50,
    elevation: 0,
    gradient: 0,
    time: null,
    dtS: 25,
    paused: false,
    heartRateBpm: null,
    powerWatts: null,
    ...overrides,
  };
}

describe("descentImpact", () => {
  it("is zero on a flat course", () => {
    const segments = [segment({ elevation: 0 }), segment({ elevation: 0 }), segment({ elevation: 0 })];
    expect(descentImpact(segments)).toBe(0);
  });

  it("is zero on a pure climb", () => {
    const segments = [segment({ elevation: 10 }), segment({ elevation: 25 }), segment({ elevation: 45 })];
    expect(descentImpact(segments)).toBe(0);
  });

  it("accumulates descent meters times speed on a downhill stretch", () => {
    // 3 segments each dropping 10m over 50m horizontal in 25s -> speed = 50/25 = 2 m/s.
    const segments = [
      segment({ elevation: 100 }), // first segment: falls back to gradient x distanceHorizontal (0 here, no drop yet)
      segment({ elevation: 90, distance3D: 50, dtS: 25 }),
      segment({ elevation: 80, distance3D: 50, dtS: 25 }),
    ];
    // Segment 2: 100->90, drop 10m, speed 50/25=2 m/s -> impact 20
    // Segment 3: 90->80, drop 10m, speed 2 m/s -> impact 20
    expect(descentImpact(segments)).toBeCloseTo(40, 6);
  });

  it("gives a bigger impact for the same total descent covered faster", () => {
    const slowDescent = [
      segment({ elevation: 100 }),
      segment({ elevation: 50, distance3D: 50, dtS: 100 }), // 0.5 m/s
    ];
    const fastDescent = [
      segment({ elevation: 100 }),
      segment({ elevation: 50, distance3D: 50, dtS: 12.5 }), // 4 m/s
    ];
    expect(descentImpact(fastDescent)).toBeGreaterThan(descentImpact(slowDescent));
  });

  it("excludes paused segments even if they'd otherwise register as a fast descent", () => {
    const segments = [
      segment({ elevation: 100 }),
      segment({ elevation: 50, distance3D: 50, dtS: 5, paused: true }), // 10 m/s, but paused
    ];
    expect(descentImpact(segments)).toBe(0);
  });

  it("excludes segments without timing data", () => {
    const segments = [segment({ elevation: 100 }), segment({ elevation: 50, dtS: null })];
    expect(descentImpact(segments)).toBe(0);
  });

  it("only counts the descending portion of a mixed profile", () => {
    const segments = [
      segment({ elevation: 100 }),
      segment({ elevation: 120, distance3D: 50, dtS: 25 }), // climb, no impact
      segment({ elevation: 100, distance3D: 50, dtS: 25 }), // descent, 20m at 2 m/s -> 40
    ];
    expect(descentImpact(segments)).toBeCloseTo(40, 6);
  });

  it("approximates the first segment's delta from gradient x horizontal distance", () => {
    const segments = [segment({ elevation: -10, gradient: -0.2, distanceHorizontal: 50, distance3D: 50, dtS: 25 })];
    // gradient x distanceHorizontal = -0.2 * 50 = -10m descent, speed = 50/25 = 2 m/s -> impact 20
    expect(descentImpact(segments)).toBeCloseTo(20, 6);
  });
});
