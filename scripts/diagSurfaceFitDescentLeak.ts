// Does the surface cost multiplier fit pick up descent slowdown that
// maxDescentSpeedMs already models as a speed limit?
//
// On a technical descent an athlete is slow at LOW heart rate, for footing
// and braking reasons, not metabolic ones. The intensity-conditioned
// regression sees "slower than this intensity predicts" and has only grade
// and gradeSquared to explain it -- so if unpaved terrain is
// disproportionately descending, the surface coefficient absorbs the
// control limit and the solver then pays for it a SECOND time through the
// descent cap.
//
// Refits the multipliers on the same library with descending segments
// excluded, and compares.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPipeline, type CourseSegment, type GpxPoint, type SurfaceCategory } from "../src/gpx/pipeline.ts";
import { attachSurfaceData, type ValhallaSurfaceEdge } from "../src/model/surfaceExposure.ts";
import { buildSegmentLibrary } from "../src/model/segmentLibrary.ts";
import { fitSurfaceCostMultipliersFromIntensity } from "../src/model/pacingFit.ts";
import { DEFAULT_FORM_INPUTS, resolveCeilingParams } from "../src/ui/formInputs.ts";

const CACHE = fileURLToPath(new URL("../.strava-cache/", import.meta.url));
const SURFACE = fileURLToPath(new URL("../.surface-cache/", import.meta.url));
const ceilingParams = resolveCeilingParams(DEFAULT_FORM_INPUTS);

const inputs: { runId: string; segments: CourseSegment[] }[] = [];
for (const f of readdirSync(CACHE).filter((x) => x.startsWith("activity-"))) {
  const id = f.slice(9, -5);
  const sp = `${SURFACE}${id}.json`;
  if (!existsSync(sp)) continue;
  try {
    const raw = JSON.parse(readFileSync(`${CACHE}${f}`, "utf8"));
    const pts: GpxPoint[] = raw.points.map((p: any) => ({ ...p, time: p.time ? new Date(p.time) : null }));
    if (pts.length < 50) continue;
    const c = runPipeline(pts);
    if (!c.hasTimestamps) continue;
    inputs.push({ runId: id, segments: attachSurfaceData(c.segments, JSON.parse(readFileSync(sp, "utf8")) as ValhallaSurfaceEdge[]) });
  } catch { /* skip unreadable */ }
}

const library = buildSegmentLibrary(inputs, { bodyMassKg: DEFAULT_FORM_INPUTS.bodyMassKg, ceilingParams });
console.log(`library: ${library.length} monotonic segments from ${inputs.length} runs\n`);

// How much of each surface category's distance is DESCENDING? If path is
// disproportionately downhill, that is the leak's mechanism.
const mix = new Map<string, { down: number; total: number }>();
for (const s of library) {
  if (s.surfaceCategory === undefined) continue;
  const e = mix.get(s.surfaceCategory) ?? { down: 0, total: 0 };
  e.total += s.distance3D;
  if (s.avgGradient < -0.02) e.down += s.distance3D;
  mix.set(s.surfaceCategory, e);
}
console.log("surface     distance   share descending");
for (const [c, e] of [...mix.entries()].sort((a, b) => b[1].total - a[1].total)) {
  console.log(`  ${c.padEnd(10)} ${(e.total / 1000).toFixed(0).padStart(6)} km   ${((e.down / e.total) * 100).toFixed(0).padStart(3)}%`);
}

const all = fitSurfaceCostMultipliersFromIntensity(library);
const noDescent = fitSurfaceCostMultipliersFromIntensity(library.filter((s) => s.avgGradient >= -0.02));
const onlyDescent = fitSurfaceCostMultipliersFromIntensity(library.filter((s) => s.avgGradient < -0.02));

const cats: SurfaceCategory[] = ["gravel", "dirt", "compacted", "path", "other"];
console.log(`\nsurface     as fit (all)   flat+uphill only   descending only`);
for (const c of cats) {
  const a = all?.surfaceCostMultipliers[c];
  const n = noDescent?.surfaceCostMultipliers[c];
  const d = onlyDescent?.surfaceCostMultipliers[c];
  if (a === undefined && n === undefined) continue;
  console.log(
    `  ${c.padEnd(10)} ${(a?.toFixed(3) ?? "  --").padStart(10)}x ${(n?.toFixed(3) ?? "  --").padStart(16)}x ${(d?.toFixed(3) ?? "  --").padStart(16)}x`,
  );
}
console.log(`\nsegments: all ${all?.segmentCount}, flat+uphill ${noDescent?.segmentCount}, descending ${onlyDescent?.segmentCount}`);
console.log(`runs ${all?.runCount}, within-run R^2 ${all?.rSquaredWithinRun.toFixed(3)}`);
console.log("\nvariance inflation (rule of thumb: >5-10 means the category is not separable):");
for (const c of cats) {
  const v = all?.variableInflationFactors[c];
  if (v !== undefined) console.log(`  ${c.padEnd(10)} VIF ${v.toFixed(1)}${v > 5 ? "   <-- shaky" : ""}`);
}
