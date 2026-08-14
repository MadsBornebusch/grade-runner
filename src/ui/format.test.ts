import { describe, expect, it } from "vitest";
import { formatDuration, formatPace, parseDurationToSeconds } from "./format";

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
