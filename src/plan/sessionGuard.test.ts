import { describe, expect, it } from "vitest";
import { GUARD_FLOORS, guardBreaches, referenceAt, runReferences, sessionAllowance, type GuardRun } from "./sessionGuard";

const run = (day: number, movingMin: number, distanceKm: number, descentM = 100, steepDescentM = 20, climbM = descentM): GuardRun => ({ day, movingMin, distanceKm, descentM, steepDescentM, climbM });

describe("runReferences", () => {
  // Five weeks of training, longest run 145 min / 18.6 km of trail, then a
  // 113 km race, then a flat road long run that is +15% by time but +53% by
  // distance over the longest *training* run (the 19 Oct 2025 shape).
  const training = Array.from({ length: 35 }, (_, d) => (d % 7 === 5 ? run(d, 145, 18.6, 700, 250) : d % 2 ? run(d, 50, 8) : null)).filter(
    (r): r is GuardRun => r !== null,
  );
  const runs = [...training, run(36, 820, 113, 1500, 200), run(50, 166, 28.5, 150, 10)];

  it("flags the race and keeps it out of later references", () => {
    const { reference, isRace } = runReferences(runs);
    expect(isRace.at(-2)).toBe(true);
    expect(isRace.at(-1)).toBe(false);
    expect(reference.at(-1)!.movingMin).toBe(145);
    expect(reference.at(-1)!.distanceKm).toBeCloseTo(18.6, 9);
  });

  it("catches the road long run on distance even though time is within 1.3x", () => {
    const { reference } = runReferences(runs);
    const breaches = guardBreaches(runs.at(-1)!, reference.at(-1)!);
    expect(breaches.map((b) => b.quantity)).toEqual(["movingMin", "distanceKm"]);
    expect(breaches[1].ratio).toBeCloseTo(28.5 / 18.6, 6);
  });
});

describe("sessionAllowance", () => {
  it("gives every athlete the floors, and 1.1x the reference above them", () => {
    const allow = sessionAllowance({ movingMin: 120, distanceKm: 2, descentM: 10, steepDescentM: 1000, climbM: 10 });
    expect(allow.movingMin).toBeCloseTo(132, 9);
    expect(allow.distanceKm).toBe(GUARD_FLOORS.distanceKm);
    expect(allow.descentM).toBe(GUARD_FLOORS.descentM);
    expect(allow.steepDescentM).toBeCloseTo(1100, 9);
  });

  it("falls back to half the 90-day longest after a break", () => {
    const ref = referenceAt([run(0, 200, 25)], 70);
    expect(ref.movingMin).toBe(100);
    expect(referenceAt([run(0, 200, 25)], 100).movingMin).toBe(0);
  });
});
