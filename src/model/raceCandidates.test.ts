import { describe, expect, it } from "vitest";
import { looksLikeGenericStravaTitle } from "./raceCandidates";

describe("looksLikeGenericStravaTitle", () => {
  it("matches Strava's auto-generated time-of-day titles", () => {
    expect(looksLikeGenericStravaTitle("Morning Run")).toBe(true);
    expect(looksLikeGenericStravaTitle("Afternoon Trail Run")).toBe(true);
    expect(looksLikeGenericStravaTitle("Lunch Run")).toBe(true);
    expect(looksLikeGenericStravaTitle("Evening Run")).toBe(true);
  });

  it("does not match real event names, even short or ambiguous ones", () => {
    expect(looksLikeGenericStravaTitle("Oslo Trail Challenge 55 km")).toBe(false);
    expect(looksLikeGenericStravaTitle("Ecotrail 80")).toBe(false);
    expect(looksLikeGenericStravaTitle("Askerspurten 10 km")).toBe(false);
    expect(looksLikeGenericStravaTitle("Saksumdal 17")).toBe(false);
    expect(looksLikeGenericStravaTitle("Ås Backyard ultra")).toBe(false);
  });

  it("does not match a workout-style title just because it names a time of day", () => {
    expect(looksLikeGenericStravaTitle("Evening Intervals")).toBe(false);
    expect(looksLikeGenericStravaTitle("Morning Tempo Run")).toBe(false);
  });

  it("is case-insensitive and tolerant of surrounding whitespace", () => {
    expect(looksLikeGenericStravaTitle("  morning run  ")).toBe(true);
    expect(looksLikeGenericStravaTitle("MORNING RUN")).toBe(true);
  });
});
