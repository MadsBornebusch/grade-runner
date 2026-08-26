import { describe, expect, it } from "vitest";
import { formatDuration, formatMinPerKm, formatPace, parseDurationToSeconds } from "./format";

describe("formatDuration", () => {
  it("formats h:mm:ss", () => {
    expect(formatDuration(3661)).toBe("1:01:01");
    expect(formatDuration(59)).toBe("0:00:59");
    expect(formatDuration(0)).toBe("0:00:00");
  });
});

describe("formatPace", () => {
  it("formats min:sec/km", () => {
    expect(formatPace(1000 / 300)).toBe("5:00/km"); // 300s/km = 5:00/km
  });

  it("handles zero/negative speed", () => {
    expect(formatPace(0)).toBe("--:--");
    expect(formatPace(-1)).toBe("--:--");
  });

  it("carries a rounded-up seconds remainder into the minutes -- never shows e.g. '4:60/km'", () => {
    // secPerKm just under 300 (299.999...) -- rounding minutes and seconds
    // independently gives floor(299.999/60)=4 and round(299.999%60)=60,
    // i.e. the exact "4:60/km" bug. Must carry to "5:00/km" instead.
    expect(formatPace(1000 / 299.999)).toBe("5:00/km");
    // Same failure mode one minute up, for good measure.
    expect(formatPace(1000 / 359.999)).toBe("6:00/km");
  });

  it("never emits a seconds field of 60 for any speed in a realistic pace range", () => {
    for (let secPerKm = 120; secPerKm < 900; secPerKm += 0.137) {
      const [, s] = formatPace(1000 / secPerKm).replace("/km", "").split(":");
      expect(s).not.toBe("60");
    }
  });
});

describe("formatMinPerKm", () => {
  it("also carries correctly through the minPerKm -> speedMs -> formatPace chain", () => {
    // A pace expressed directly in minutes/km that lands just under a whole
    // minute boundary after the unit conversions -- same underlying bug,
    // reached the way the app's own avg-pace stat actually calls this.
    expect(formatMinPerKm(299.999 / 60)).toBe("5:00/km");
  });
});

describe("parseDurationToSeconds", () => {
  it("parses H:MM", () => {
    expect(parseDurationToSeconds("5:30")).toBe(5 * 3600 + 30 * 60);
  });

  it("parses H:MM:SS", () => {
    expect(parseDurationToSeconds("1:01:01")).toBe(3661);
  });

  it("round-trips with formatDuration", () => {
    expect(parseDurationToSeconds(formatDuration(3661))).toBe(3661);
  });

  it("returns null for empty or malformed input", () => {
    expect(parseDurationToSeconds("")).toBeNull();
    expect(parseDurationToSeconds("   ")).toBeNull();
    expect(parseDurationToSeconds("not a time")).toBeNull();
    expect(parseDurationToSeconds("5")).toBeNull();
    expect(parseDurationToSeconds("-1:00")).toBeNull();
  });
});
