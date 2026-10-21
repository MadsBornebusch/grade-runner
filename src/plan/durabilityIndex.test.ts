import { describe, expect, it } from "vitest";
import { descentFade, flatFade, movingWindow, type PaceSample } from "./durabilityIndex";

/** 10 s samples over `hours`, cycling through flat, -7% and -13%, with
 * descent speed falling linearly by `lateLoss` (a fraction) over the run
 * and a steeper-is-slower grade effect. */
function syntheticRun(hours: number, lateLoss: number, lateExtraSteep = 0): PaceSample[] {
  const out: PaceSample[] = [];
  const n = Math.round((hours * 3600) / 10);
  for (let k = 1; k <= n; k++) {
    const phase = Math.floor(k / 30) % 3;
    const frac = k / n;
    let gradient = phase === 0 ? 0 : phase === 1 ? -0.07 : -0.13;
    if (phase > 0 && frac > 0.6) gradient -= lateExtraSteep;
    const base = phase === 0 ? 3 : 4 - 5 * (-gradient - 0.05);
    const speedMs = phase === 0 ? base : base * (1 - lateLoss * frac);
    out.push({ tS: 10 * k, dtS: 10, gradient, speedMs });
  }
  return out;
}

const split = (s: PaceSample[]) => [movingWindow(s, 0, 1 / 3), movingWindow(s, 2 / 3, 1)] as const;

describe("descentFade", () => {
  it("reads about zero on a run with no slowdown", () => {
    const [early, late] = split(syntheticRun(3, 0));
    const f = descentFade(early, late);
    expect(f.bands.length).toBe(2);
    expect(Math.abs(f.logFade!)).toBeLessThan(1e-9);
  });

  it("recovers an injected late slowdown", () => {
    const s = syntheticRun(3, 0.15);
    const [early, late] = split(s);
    // Mean speed factor in each window, from the injected linear loss.
    const mean = (xs: PaceSample[]) => xs.reduce((a, x) => a + x.tS, 0) / xs.length / s.at(-1)!.tS;
    const expected = Math.log((1 - 0.15 * mean(late)) / (1 - 0.15 * mean(early)));
    expect(descentFade(early, late).logFade!).toBeCloseTo(expected, 2);
  });

  it("doesn't count steeper late ground as fade", () => {
    // Late descents 2 points steeper, same grade-speed law, no fatigue.
    const [early, late] = split(syntheticRun(3, 0, 0.02));
    expect(Math.abs(descentFade(early, late).logFade!)).toBeLessThan(0.01);
  });

  it("returns null without enough descent time in both windows", () => {
    const [early, late] = split(syntheticRun(3, 0.1));
    expect(descentFade(early, late, undefined, 3600).logFade).toBeNull();
  });
});

describe("flatFade", () => {
  it("ignores descent-only slowdown", () => {
    const [early, late] = split(syntheticRun(3, 0.2));
    // FLAT_BAND reaches down to -5%, so only the flat phase counts here.
    expect(Math.abs(flatFade(early, late)!)).toBeLessThan(1e-9);
  });
});
