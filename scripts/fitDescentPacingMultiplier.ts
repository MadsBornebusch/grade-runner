// Fits an exponential-decay curve (f0/fInf/tauKm, same naming convention as
// ceiling.ts's own duration-decay fit) to descentSpeedVsDistance.ts's real
// actual/cap descent-speed-ratio-vs-total-distance data, for wiring into
// minetti.ts's new descentPacingMultiplier(). Grid search (coarse, then a
// refinement pass centered on the coarse winner) minimizing sum of squared
// residuals -- only 8 real race data points, so a closed-form regression
// isn't warranted; a grid search is easy to verify by eye against the
// printed residuals table.
//
// Usage: npx tsx scripts/fitDescentPacingMultiplier.ts

import { loadRaceDescentRatios } from "./descentSpeedVsDistance.ts";

function multiplierAt(distanceKm: number, f0: number, fInf: number, tauKm: number): number {
  return fInf + (f0 - fInf) * Math.exp(-distanceKm / tauKm);
}

function sse(points: { distanceKm: number; ratio: number }[], f0: number, fInf: number, tauKm: number): number {
  let sum = 0;
  for (const p of points) {
    const predicted = multiplierAt(p.distanceKm, f0, fInf, tauKm);
    const err = predicted - p.ratio;
    sum += err * err;
  }
  return sum;
}

function gridSearch(
  points: { distanceKm: number; ratio: number }[],
  f0Range: [number, number],
  fInfRange: [number, number],
  tauRange: [number, number],
  steps: number,
): { f0: number; fInf: number; tauKm: number; sse: number } {
  let best = { f0: f0Range[0], fInf: fInfRange[0], tauKm: tauRange[0], sse: Infinity };
  for (let i = 0; i <= steps; i++) {
    const f0 = f0Range[0] + ((f0Range[1] - f0Range[0]) * i) / steps;
    for (let j = 0; j <= steps; j++) {
      const fInf = fInfRange[0] + ((fInfRange[1] - fInfRange[0]) * j) / steps;
      for (let k = 0; k <= steps; k++) {
        const tauKm = tauRange[0] + ((tauRange[1] - tauRange[0]) * k) / steps;
        const err = sse(points, f0, fInf, tauKm);
        if (err < best.sse) best = { f0, fInf, tauKm, sse: err };
      }
    }
  }
  return best;
}

function main() {
  const races = loadRaceDescentRatios();
  console.log(`Fitting against ${races.length} real races:`);
  for (const r of races) console.log(`  ${r.distanceKm.toFixed(1).padStart(6)}km  ratio=${r.ratio.toFixed(2)}  ${r.name}`);

  const points = races.map((r) => ({ distanceKm: r.distanceKm, ratio: r.ratio }));

  // Coarse pass over a wide, physically sane range: f0 capped at 1.3 (don't
  // let short races extrapolate to an implausible 30%+ speed boost off a
  // single noisy 10.2km point), fInf floored at 0.3 (don't let ultra-distance
  // races extrapolate below the steepest observed ratio, 0.57), tau 5-200km.
  const coarse = gridSearch(points, [0.9, 1.3], [0.3, 0.9], [5, 200], 40);
  console.log(`\nCoarse best: f0=${coarse.f0.toFixed(3)}, fInf=${coarse.fInf.toFixed(3)}, tauKm=${coarse.tauKm.toFixed(1)}, SSE=${coarse.sse.toFixed(4)}`);

  // Refine, centered on the coarse winner.
  const refine = gridSearch(
    points,
    [Math.max(0.9, coarse.f0 - 0.05), Math.min(1.3, coarse.f0 + 0.05)],
    [Math.max(0.3, coarse.fInf - 0.05), Math.min(0.9, coarse.fInf + 0.05)],
    [Math.max(5, coarse.tauKm - 15), coarse.tauKm + 15],
    60,
  );
  console.log(`Refined best: f0=${refine.f0.toFixed(3)}, fInf=${refine.fInf.toFixed(3)}, tauKm=${refine.tauKm.toFixed(1)}, SSE=${refine.sse.toFixed(4)}`);

  console.log("\nResiduals at the refined fit:");
  console.log("Distance(km)  Actual ratio  Fitted ratio  Residual");
  for (const p of points) {
    const fitted = multiplierAt(p.distanceKm, refine.f0, refine.fInf, refine.tauKm);
    console.log(`${p.distanceKm.toFixed(1).padStart(11)}  ${p.ratio.toFixed(3).padStart(11)}  ${fitted.toFixed(3).padStart(11)}  ${(fitted - p.ratio).toFixed(3).padStart(8)}`);
  }

  console.log("\nSuggested constants for minetti.ts:");
  console.log(`  DESCENT_PACING_F0 = ${refine.f0.toFixed(2)}`);
  console.log(`  DESCENT_PACING_FINF = ${refine.fInf.toFixed(2)}`);
  console.log(`  DESCENT_PACING_TAU_KM = ${refine.tauKm.toFixed(0)}`);
}

main();
