import { describe, expect, it } from "vitest";
import type { GpxPoint } from "./pipeline";
import { detectTransitGaps, splitAtTransitGaps } from "./transitGap";

const DEG_PER_M = 1 / 111320;

/** A straight line of points heading due north, one per second, at speedMs. */
function makeLine(n: number, speedMs: number, startTimeS = 0): GpxPoint[] {
  const points: GpxPoint[] = [];
  for (let i = 0; i < n; i++) {
    const distance = i * speedMs;
    points.push({
      lat: 60 + distance * DEG_PER_M,
      lon: 10,
      ele: null,
      time: new Date((startTimeS + i) * 1000),
      hr: null,
      power: null,
    });
  }
  return points;
}

/** Appends `b` after `a`, rebasing b's own elapsed-time pattern to start
 * `gapS` seconds after a's last point (the gap itself). */
function withGap(a: GpxPoint[], b: GpxPoint[], gapS: number): GpxPoint[] {
  const lastA = a[a.length - 1];
  const rebased = b.map((p) => new Date(lastA.time!.getTime() + gapS * 1000 + (p.time!.getTime() - b[0].time!.getTime())));
  return [...a, ...b.map((p, i) => ({ ...p, time: rebased[i] }))];
}

describe("detectTransitGaps", () => {
  it("finds nothing in a plain run with no gaps", () => {
    const points = makeLine(20, 3);
    expect(detectTransitGaps(points)).toHaveLength(0);
  });

  it("does not flag a brief, near-zero-distance GPS jitter spike", () => {
    const points = makeLine(20, 3);
    // Inject a 1-point jitter jump: huge implied speed, but only ~10m of it.
    points[10] = { ...points[10], lat: points[10].lat + 10 * DEG_PER_M };
    expect(detectTransitGaps(points)).toHaveLength(0);
  });

  it("flags a real transit gap: large distance covered far faster than running", () => {
    const before = makeLine(10, 3); // 0-9s, running pace
    const after = makeLine(5, 3); // another running leg
    const points = withGap(before, after, 900); // 900s gap
    // Move the "after" leg's start point far away, consistent with a genuine
    // relocation (otherwise distance from lastBefore to firstAfter is ~0).
    points[10] = { ...points[10], lat: points[10].lat + 9000 * DEG_PER_M };
    for (let i = 11; i < points.length; i++) {
      points[i] = { ...points[i], lat: points[i].lat + 9000 * DEG_PER_M };
    }
    const gaps = detectTransitGaps(points);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].beforeIndex).toBe(9);
    expect(gaps[0].afterIndex).toBe(10);
    expect(gaps[0].distanceM).toBeGreaterThan(8000);
    expect(gaps[0].impliedSpeedMs).toBeGreaterThan(7);
  });

  it("ignores points with no timestamp", () => {
    const points = makeLine(10, 3).map((p) => ({ ...p, time: null }));
    expect(detectTransitGaps(points)).toHaveLength(0);
  });
});

describe("splitAtTransitGaps", () => {
  it("returns the input as a single leg when there's no gap", () => {
    const points = makeLine(20, 3);
    const legs = splitAtTransitGaps(points);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toBe(points);
  });

  it("splits into two legs at a real transit gap, dropping nothing but the gap itself", () => {
    const before = makeLine(10, 3);
    const after = makeLine(5, 3);
    let points = withGap(before, after, 900);
    points[10] = { ...points[10], lat: points[10].lat + 9000 * DEG_PER_M };
    for (let i = 11; i < points.length; i++) {
      points[i] = { ...points[i], lat: points[i].lat + 9000 * DEG_PER_M };
    }
    const legs = splitAtTransitGaps(points);
    expect(legs).toHaveLength(2);
    expect(legs[0]).toHaveLength(10);
    expect(legs[1]).toHaveLength(5);
  });

  it("handles two gaps, producing three legs", () => {
    const leg1 = makeLine(10, 3);
    const leg2 = makeLine(10, 3);
    const leg3 = makeLine(10, 3);
    let points = withGap(leg1, leg2, 900);
    for (let i = 10; i < points.length; i++) points[i] = { ...points[i], lat: points[i].lat + 9000 * DEG_PER_M };
    points = withGap(points, leg3, 900);
    for (let i = 20; i < points.length; i++) points[i] = { ...points[i], lat: points[i].lat + 18000 * DEG_PER_M };
    const legs = splitAtTransitGaps(points);
    expect(legs).toHaveLength(3);
    expect(legs.map((l) => l.length)).toEqual([10, 10, 10]);
  });
});
