// Is the descent-speed cap tighter than what this athlete actually ran?
// Compares, on the SAME descent segments of a real race: his recorded GPS
// speed, the cap the model imposes, and what the model would choose with
// the cap lifted. If recorded > cap, the cap is provably too tight.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPipeline, type GpxPoint } from "../src/gpx/pipeline.ts";
import { gradeOnlyMaxDescentSpeedMs } from "../src/model/minetti.ts";

const CACHE = fileURLToPath(new URL("../.strava-cache/", import.meta.url));
const RACES = [
  { id: 15777092101, name: "Askerspurten 10 km" },
  { id: 14579457702, name: "Ecotrail 80" },
  { id: 12524841443, name: "Oslo Trail Challenge 55 km" },
];
const pace = (ms: number) => (ms <= 0 ? "--" : `${Math.floor(1000 / ms / 60)}:${String(Math.round((1000 / ms) % 60)).padStart(2, "0")}`);

for (const race of RACES) {
  const raw = JSON.parse(readFileSync(`${CACHE}activity-${race.id}.json`, "utf8"));
  const pts: GpxPoint[] = raw.points.map((p: any) => ({ ...p, time: p.time ? new Date(p.time) : null }));
  const course = runPipeline(pts);
  console.log(`\n${race.name}`);
  console.log("  grade band   distance   recorded pace   cap pace   recorded/cap");
  for (const [lo, hi] of [[-0.08, -0.04], [-0.12, -0.08], [-0.18, -0.12], [-0.5, -0.18]] as [number, number][]) {
    let m = 0, t = 0, capWeighted = 0;
    for (const s of course.segments) {
      if (s.gradient < lo || s.gradient >= hi) continue;
      if (s.paused || !(s.dtS !== null && s.dtS > 0)) continue;
      m += s.distance3D; t += s.dtS as number;
      const cap = gradeOnlyMaxDescentSpeedMs(s.gradient); // grade-only, no distance term
      capWeighted += (Number.isFinite(cap) ? cap : 99) * s.distance3D;
    }
    if (m < 200) continue;
    const recorded = m / t;
    const cap = capWeighted / m;
    console.log(
      `  ${(lo * 100).toFixed(0).padStart(4)}..${(hi * 100).toFixed(0).padStart(3)}%  ${(m / 1000).toFixed(1).padStart(6)} km   ` +
        `${pace(recorded).padStart(9)}/km   ${pace(cap).padStart(6)}/km   ` +
        `${(recorded / cap).toFixed(2).padStart(6)}${recorded > cap ? "  <-- CAP IS BELOW WHAT HE RAN" : ""}`,
    );
  }
}
