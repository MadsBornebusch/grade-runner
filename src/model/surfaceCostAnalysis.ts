// PLAN.md §14 Plan B, Stage 3: does surface category predict a real,
// non-circular pace slowdown, and how big is it per category? Productionizes
// §12 stage 6's "third attempt" (a deleted scratch harness: bucket segments
// by real device power and gradient, compare achieved speed across surface
// types within each cell) as real, tested, shipped code, using the full
// segment library instead of a handful of marquee races.
//
// Non-circularity (PLAN.md §14 Stage 0): only segments with real device
// power are used. Predicted speed comes from that device power (converted
// to Minetti-equivalent units via Stage 0's own calibration constant) and
// the segment's own gradient via costOfRunning/costOfWalking -- never from
// the segment's own GPS speed, which would make "predicted vs actual speed"
// circular by construction.
//
// Grade confound (found by tabulating real data before writing this):
// surface category correlates strongly with grade in this athlete's own
// library (path averages ~10% grade vs paved's ~3%, and is far more often
// walked) -- a single collapsed mean-residual-per-category would blend a
// real surface effect with "this category's segments happen to be
// steeper/more often walked," exactly the kind of confound already found
// (and fixed) twice earlier this session (the raw Stage 0 slope turning out
// to be a gait artifact; the gait-choice "agreement%" turning out to be
// near-tautological). The fix here is the same kind: compare WITHIN grade
// bins, never across them. buildSurfaceCostTable never averages a category
// across bins -- see summarizeAcrossGradeBins for the one place per-bin
// results get pooled into a single number, and even that stays honest about
// which bins actually had a paved comparison to pool.

import type { SurfaceCategory } from "../gpx/pipeline";
import type { TaggedMonotonicSegment } from "./segmentLibrary";
import { costOfRunning, costOfWalking } from "./minetti";
import { grossToNet } from "./energetics";

export interface SurfaceCostTableOptions {
  /** Default 0.05 (5%), same convention as Stage 0's own grade bins. */
  gradeBinWidth?: number;
  /**
   * Device-power-to-Minetti-gross-W/kg calibration constant (PLAN.md §14
   * Stage 0's own finding -- Stryd's power definition isn't in the same
   * units as this model's Minetti-calibrated gross power). Only affects
   * the ABSOLUTE residual level; a shared multiplicative constant cancels
   * exactly in the paved-relative comparison this table's real conclusions
   * rest on. Default reuses Stage 0's own 0.419 for consistency with the
   * already-committed result, not because its exact value matters here.
   */
  strydToMinettiCalibration?: number;
  /**
   * Restrict to running-gait segments only. Default true: Stage 0 found
   * Stryd's own accuracy weaker specifically on walking segments, and
   * walking concentrates on exactly the steep/technical surfaces under
   * test here (real data: path is 53% walked vs paved's 20%) -- including
   * walk segments would import both device error and a second grade
   * confound into the categories that matter most. Set false to see the
   * (far less trustworthy) walk-inclusive picture instead.
   */
  runningGaitOnly?: boolean;
}

export interface SurfaceCostCell {
  gradeBinCenter: number;
  surfaceCategory: SurfaceCategory;
  segmentCount: number;
  /** Distinct source runs contributing to this cell -- the real sample
   * size for cluster-robust purposes, not segmentCount (see module doc). */
  runCount: number;
  /** Duration-weighted mean of (actual − predicted) log-speed, this
   * category/bin only. Not comparable across categories on its own --
   * see relativeToPavedLogSpeedResidual, which is what's actually
   * comparable (the absolute level rests on the calibration constant). */
  meanLogSpeedResidual: number;
}

export interface SurfaceCostCellComparison extends SurfaceCostCell {
  /** This cell's meanLogSpeedResidual minus paved's OWN residual in the
   * SAME grade bin -- null if paved has no data in this bin, in which case
   * this cell simply isn't comparable (not defaulted to 0 or dropped
   * silently -- surfaced as null so a caller can see the gap). */
  relativeToPavedLogSpeedResidual: number | null;
  /** exp(-relativeToPavedLogSpeedResidual) -- implied cost multiplier vs.
   * paved at matched grade and device power (PLAN.md §12 stage 6's own
   * convention: cost_x/cost_paved = v_paved/v_x at fixed power+gradient).
   * Null under the same condition as the field above. */
  impliedCostMultiplierVsPaved: number | null;
}

const DEFAULT_GRADE_BIN_WIDTH = 0.05;
/** See strydToMinettiCalibration's own doc above for why this specific
 * value (not its precision) is what matters. */
const DEFAULT_CALIBRATION = 0.419;

/**
 * log(actual speed) − log(speed the model predicts from this segment's own
 * device power and gradient) -- null if this segment has no device power,
 * or the calibrated net power comes out non-positive (a resting-metabolism-
 * dominated reading, not a real moving effort).
 */
function logSpeedResidual(seg: TaggedMonotonicSegment, calibration: number): number | null {
  if (seg.avgMeasuredPowerWPerKg === null) return null;
  const netPowerWPerKg = grossToNet(seg.avgMeasuredPowerWPerKg / calibration);
  if (netPowerWPerKg <= 0) return null;
  const cost = seg.gaitMode === "walk" ? costOfWalking(seg.avgGradient) : costOfRunning(seg.avgGradient);
  const predictedSpeedMs = netPowerWPerKg / cost;
  if (predictedSpeedMs <= 0) return null;
  return Math.log(seg.avgSpeedMs) - Math.log(predictedSpeedMs);
}

/**
 * Builds the grade-bin x surface-category table: within each grade bin,
 * how much slower/faster is each surface category than paved, at matched
 * device power? Never averages a category across grade bins itself (see
 * summarizeAcrossGradeBins for the one place that happens, deliberately
 * kept separate and explicit about which bins fed it).
 */
export function buildSurfaceCostTable(
  library: TaggedMonotonicSegment[],
  options: SurfaceCostTableOptions = {},
): SurfaceCostCellComparison[] {
  const gradeBinWidth = options.gradeBinWidth ?? DEFAULT_GRADE_BIN_WIDTH;
  const calibration = options.strydToMinettiCalibration ?? DEFAULT_CALIBRATION;
  const runningGaitOnly = options.runningGaitOnly ?? true;

  interface CellAccumulator {
    weightedResidualSum: number;
    weight: number;
    segmentCount: number;
    runIds: Set<string>;
  }
  const cells = new Map<string, CellAccumulator>();

  for (const seg of library) {
    if (seg.surfaceCategory === undefined) continue;
    if (runningGaitOnly && seg.gaitMode !== "run") continue;
    const residual = logSpeedResidual(seg, calibration);
    if (residual === null) continue;

    const gradeBinCenter = Math.round(seg.avgGradient / gradeBinWidth) * gradeBinWidth;
    const key = `${gradeBinCenter}|${seg.surfaceCategory}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { weightedResidualSum: 0, weight: 0, segmentCount: 0, runIds: new Set() };
      cells.set(key, cell);
    }
    cell.weightedResidualSum += residual * seg.timeS;
    cell.weight += seg.timeS;
    cell.segmentCount += 1;
    cell.runIds.add(seg.runId);
  }

  const rawCells: SurfaceCostCell[] = [...cells.entries()].map(([key, acc]) => {
    const separatorIndex = key.indexOf("|");
    return {
      gradeBinCenter: parseFloat(key.slice(0, separatorIndex)),
      surfaceCategory: key.slice(separatorIndex + 1) as SurfaceCategory,
      segmentCount: acc.segmentCount,
      runCount: acc.runIds.size,
      meanLogSpeedResidual: acc.weightedResidualSum / acc.weight,
    };
  });

  const pavedResidualByBin = new Map<number, number>();
  for (const c of rawCells) {
    if (c.surfaceCategory === "paved") pavedResidualByBin.set(c.gradeBinCenter, c.meanLogSpeedResidual);
  }

  return rawCells.map((c) => {
    const pavedResidual = pavedResidualByBin.get(c.gradeBinCenter);
    const relative = pavedResidual !== undefined ? c.meanLogSpeedResidual - pavedResidual : null;
    return {
      ...c,
      relativeToPavedLogSpeedResidual: relative,
      impliedCostMultiplierVsPaved: relative !== null ? Math.exp(-relative) : null,
    };
  });
}

export interface SurfaceCostSummary {
  surfaceCategory: SurfaceCategory;
  /** Sum of segmentCount across every bin that had a paved comparison --
   * excludes bins with no paved data, so this is smaller than the
   * category's total segment count whenever paved coverage has gaps. */
  comparableSegmentCount: number;
  /** Sum of each comparable bin's own runCount -- an UPPER BOUND on
   * distinct runs (a run spanning two grade bins in this category is
   * counted once per bin), not a true union; SurfaceCostCellComparison
   * doesn't retain individual runIds to dedupe across bins from. */
  comparableRunCount: number;
  /** Number of distinct grade bins this category could be compared to
   * paved in at all -- a real effect should hold across several, not rest
   * on one bin (PLAN.md §12 stage 6's own "held across all 20 cells" bar). */
  comparableBinCount: number;
  /** Segment-count-weighted mean of relativeToPavedLogSpeedResidual across
   * only the comparable bins. Null if there were none. */
  meanRelativeToPavedLogSpeedResidual: number | null;
  impliedCostMultiplierVsPaved: number | null;
}

/**
 * Pools the per-bin comparisons in `table` into one summary number per
 * category, weighted by each bin's own segment count -- the one place this
 * module averages across grade bins, kept separate from buildSurfaceCostTable
 * itself so a caller can always see the per-bin table a summary came from.
 * A category with real data but no bin ever containing paved data gets
 * meanRelativeToPavedLogSpeedResidual: null, not silently 0.
 */
export function summarizeAcrossGradeBins(table: SurfaceCostCellComparison[]): SurfaceCostSummary[] {
  const byCategory = new Map<SurfaceCategory, SurfaceCostCellComparison[]>();
  for (const cell of table) {
    if (cell.surfaceCategory === "paved") continue; // paved is the reference, not its own comparison
    if (!byCategory.has(cell.surfaceCategory)) byCategory.set(cell.surfaceCategory, []);
    byCategory.get(cell.surfaceCategory)!.push(cell);
  }

  return [...byCategory.entries()].map(([surfaceCategory, cells]) => {
    const comparable = cells.filter((c) => c.relativeToPavedLogSpeedResidual !== null);
    const comparableSegmentCount = comparable.reduce((sum, c) => sum + c.segmentCount, 0);
    // SurfaceCostCellComparison only retains each bin's own runCount, not
    // the underlying runIds, so this sums per-bin counts rather than taking
    // a true union -- an upper bound (a run spanning two grade bins in this
    // category would be counted once per bin), documented on the field
    // itself rather than presented as an exact distinct-run count.
    const comparableRunCount = comparable.reduce((sum, c) => sum + c.runCount, 0);

    if (comparableSegmentCount === 0) {
      return {
        surfaceCategory,
        comparableSegmentCount: 0,
        comparableRunCount: 0,
        comparableBinCount: 0,
        meanRelativeToPavedLogSpeedResidual: null,
        impliedCostMultiplierVsPaved: null,
      };
    }

    const weightedSum = comparable.reduce((sum, c) => sum + c.relativeToPavedLogSpeedResidual! * c.segmentCount, 0);
    const meanRelative = weightedSum / comparableSegmentCount;
    return {
      surfaceCategory,
      comparableSegmentCount,
      comparableRunCount,
      comparableBinCount: comparable.length,
      meanRelativeToPavedLogSpeedResidual: meanRelative,
      impliedCostMultiplierVsPaved: Math.exp(-meanRelative),
    };
  });
}
