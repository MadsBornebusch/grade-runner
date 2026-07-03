import { describe, expect, it } from "vitest";
import { formatDuration, formatPace } from "./format";

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
