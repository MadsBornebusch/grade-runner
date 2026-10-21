import { describe, expect, it } from "vitest";
import { descentFade, fitTileFade, flatFade, movingWindow, type PaceSample } from "./durabilityIndex";

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

describe("fitTileFade", () => {
  it("recovers each group's slope through tile and run effects", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const tileEffect = Array.from({ length: 40 }, () => rnd() - 0.5);
    const slope: Record<string, number> = { a: -0.05, b: -0.01 };
    const obs = [];
    for (let run = 0; run < 60; run++) {
      const group = run % 2 ? "a" : "b";
      const runEffect = 0.3 * (rnd() - 0.5);
      // Each run visits a random subset of tiles, in a random order, so a
      // tile is fresh in one run and late in another.
      for (let visit = 0; visit < 25; visit++) {
        const tile = Math.floor(rnd() * 40);
        const hours = 4 * rnd();
        obs.push({ tile: String(tile), hours, run: String(run), group, logSpeed: tileEffect[tile] + runEffect + slope[group] * hours + 0.01 * (rnd() - 0.5) });
      }
    }
    const fit = fitTileFade(obs);
    expect(fit.get("a")!).toBeCloseTo(-0.05, 2);
    expect(fit.get("b")!).toBeCloseTo(-0.01, 2);
  });

  it("isn't fooled by late tiles being faster terrain", () => {
    // Two thirds of the runs take the loop the way that reaches the fast
    // tiles late, and there is no fatigue: a raw early-vs-late comparison
    // would read late as faster.
    const obs = [];
    for (let run = 0; run < 30; run++) {
      for (let tile = 0; tile < 10; tile++) {
        const hours = (run % 3 ? tile : 9 - tile) / 3 + (run % 5) * 0.2;
        obs.push({ tile: String(tile), hours, run: String(run), group: "g", logSpeed: 0.05 * tile + 0.01 * (run % 3) });
      }
    }
    expect(Math.abs(fitTileFade(obs).get("g")!)).toBeLessThan(1e-4);
  });
});
