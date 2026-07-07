import { describe, expect, it } from "vitest";
import { buildPointsFromStreams } from "./stravaConvert.ts";

describe("buildPointsFromStreams", () => {
  const startDateIso = "2024-06-01T10:00:00Z";

  it("combines latlng/altitude/heartrate/watts into GpxPoints with absolute timestamps", () => {
    const points = buildPointsFromStreams(startDateIso, {
      time: { data: [0, 10, 20] },
      latlng: {
        data: [
          [60.1, 10.2],
          [60.2, 10.3],
          [60.3, 10.4],
        ],
      },
      altitude: { data: [100, 110, 120] },
      heartrate: { data: [140, 142, 145] },
      watts: { data: [250, 255, 260] },
    });

    expect(points).toHaveLength(3);
    expect(points[0]).toEqual({
      lat: 60.1,
      lon: 10.2,
      ele: 100,
      time: new Date("2024-06-01T10:00:00Z"),
      hr: 140,
      power: 250,
    });
    expect(points[2].time).toEqual(new Date("2024-06-01T10:00:20Z"));
  });

  it("fills missing optional streams with null", () => {
    const points = buildPointsFromStreams(startDateIso, {
      time: { data: [0, 5] },
      latlng: {
        data: [
          [60.1, 10.2],
          [60.2, 10.3],
        ],
      },
    });
    expect(points[0].ele).toBeNull();
    expect(points[0].hr).toBeNull();
    expect(points[0].power).toBeNull();
  });

  it("returns [] when there's no GPS stream at all", () => {
    const points = buildPointsFromStreams(startDateIso, {
      time: { data: [0, 5] },
      heartrate: { data: [140, 142] },
    });
    expect(points).toEqual([]);
  });

  it("leaves time null for a point past the end of a shorter time stream", () => {
    const points = buildPointsFromStreams(startDateIso, {
      time: { data: [0] },
      latlng: {
        data: [
          [60.1, 10.2],
          [60.2, 10.3],
        ],
      },
    });
    expect(points[0].time).toEqual(new Date(startDateIso));
    expect(points[1].time).toBeNull();
  });
});
