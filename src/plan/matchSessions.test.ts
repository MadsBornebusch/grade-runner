import { describe, expect, it } from "vitest";
import { matchDay, matchWeek } from "./matchSessions";
import type { PlannedSession } from "./planGenerator";

const session = (day: number, kind: PlannedSession["kind"], minutes: number): PlannedSession => ({
  day, kind, minutes, distanceKm: minutes / 6, mechanical: 0, descentM: 0, steepDescentM: 0,
});
const sessions = [session(1, "easy", 50), session(1, "strength", 25), session(3, "long", 150), session(5, "easy", 45)];

describe("matchDay", () => {
  it("marks a run on the day done, a short one partial, none skipped", () => {
    expect(matchDay(1, sessions, [{ day: 1, movingMin: 48, distanceKm: 8 }], 4).state).toBe("done");
    expect(matchDay(3, sessions, [{ day: 3, movingMin: 90, distanceKm: 14 }], 4).state).toBe("partial");
    expect(matchDay(3, sessions, [], 4).state).toBe("skipped");
  });

  it("adds two runs on one day together", () => {
    const runs = [{ day: 3, movingMin: 80, distanceKm: 12 }, { day: 3, movingMin: 40, distanceKm: 6 }];
    expect(matchDay(3, sessions, runs, 4).state).toBe("done");
  });

  it("keeps today open until the run is long enough, and later days upcoming", () => {
    expect(matchDay(5, sessions, [], 5).state).toBe("today");
    expect(matchDay(5, sessions, [{ day: 5, movingMin: 20, distanceKm: 3 }], 5).state).toBe("today");
    expect(matchDay(5, sessions, [], 4).state).toBe("upcoming");
  });

  it("flags a run on a day with no run session as extra, and leaves strength-only days unmatched", () => {
    const m = matchDay(2, sessions, [{ day: 2, movingMin: 30, distanceKm: 5 }], 4);
    expect(m.extra).toBe(true);
    expect(m.state).toBeNull();
    expect(matchDay(1, [session(1, "strength", 25)], [], 4).state).toBeNull();
  });
});

describe("matchWeek", () => {
  it("returns seven days from the Monday", () => {
    expect(matchWeek(0, sessions, [], 0).map((d) => d.day)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});
