// Why does the duration-ceiling envelope rest on the races it does?
// Mirrors runFitBatch.ts's own computation of DurationCeilingObservation
// exactly, then shows each confirmed race against the fitted curve, so the
// hull membership can be read off rather than guessed at.
//
// The absolute level of sustainedFraction depends on the athlete's VO2max
// (DEFAULT_FORM_INPUTS here, not their saved profile), so the raw
// percentages below are NOT the athlete's own and cannot be compared
// against the stored curve directly -- a wrong VO2max scales every race
// together and would put them all above or all below it.
//
// What survives that is the RATIO sustained / curve(duration): scaling the
// denominator multiplies every race's ratio by the same constant, so the
// RANKING is exact even when the level is not. The envelope touches the
// highest-ratio races, so the ranking is what decides hull membership.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPipeline, type GpxPoint } from "../src/gpx/pipeline.ts";
import { splitAtTransitGaps } from "../src/gpx/transitGap.ts";
import { analyzeRun } from "../src/model/analysis.ts";
import { maxAerobicPower } from "../src/model/ceiling.ts";
import {
  DEFAULT_FORM_INPUTS,
  resolveCeilingParams,
  resolveGlycogenStoreG,
} from "../src/ui/formInputs.ts";

const CACHE = fileURLToPath(new URL("../.strava-cache/", import.meta.url));
// The six the athlete has confirmed, as listed in the pacing-margin panel.
const CONFIRMED = [
  "Saksumdal 17", "Oslo Trail Challenge 55 km", "Ecotrail 80",
  "Askerspurten 10 km", "Soria Moria til Verdens Ende",
];
const F60 = 0.799, EXP = 0.16;

const fi = DEFAULT_FORM_INPUTS;
const ceilingParams = resolveCeilingParams(fi);
const refMaxAerobicPower = maxAerobicPower(0, ceilingParams);

interface Meta { stravaId: number; name: string }
const activities = JSON.parse(readFileSync(`${CACHE}activities.json`, "utf8")) as Meta[];
const cached = new Set(readdirSync(CACHE).filter((f) => f.startsWith("activity-")).map((f) => Number(f.slice(9, -5))));

interface Obs { name: string; durationMin: number; frac: number }
const obs: Obs[] = [];

for (const a of activities) {
  if (!cached.has(a.stravaId)) continue;
  if (!CONFIRMED.some((c) => a.name.startsWith(c))) continue;
  let pts: GpxPoint[];
  try {
    const raw = JSON.parse(readFileSync(`${CACHE}activity-${a.stravaId}.json`, "utf8"));
    pts = raw.points.map((p: any) => ({ ...p, time: p.time ? new Date(p.time) : null }));
  } catch { continue; }
  for (const leg of splitAtTransitGaps(pts)) {
    const course = runPipeline(leg);
    if (!course.hasTimestamps) continue;
    const analysis = analyzeRun(course.segments, {
      bodyMassKg: fi.bodyMassKg,
      ceilingParams,
      fueling: { intakeGPerH: fi.intakeGPerH },
      glycogenStoreG: resolveGlycogenStoreG(fi),
      walkMaxMs: fi.walkMaxMs,
      altitudeAdjustment: fi.altitudeAdjustment,
    });
    if (!(analysis.totalMovingTimeS > 0)) continue;
    let weighted = 0, weight = 0;
    for (const seg of analysis.segments) {
      if (seg.paused || seg.timeS <= 0) continue;
      weighted += (seg.grossPowerWPerKg / refMaxAerobicPower) * seg.timeS;
      weight += seg.timeS;
    }
    if (weight <= 0) continue;
    obs.push({ name: a.name, durationMin: analysis.totalMovingTimeS / 60, frac: weighted / weight });
  }
}

obs.sort((x, y) => x.durationMin - y.durationMin);
const curve = (m: number) => Math.min(1, F60 * Math.pow(m / 60, -EXP));

console.log("What the ENVELOPE actually sees -- absolute % of VO2max held, race-long:\n");
const ranked = obs
  .map((o) => ({ ...o, ratio: o.frac / curve(o.durationMin) }))
  .sort((x, y) => y.ratio - x.ratio);
const top = ranked[0].ratio;

console.log("race                              dur      sustained   vs curve   rank");
console.log("-".repeat(80));
for (const o of ranked) {
  const rel = o.ratio / top;
  const binds = rel > 0.995;
  console.log(
    `${o.name.slice(0, 30).padEnd(31)} ${(o.durationMin / 60).toFixed(2).padStart(5)}h ` +
      `${(o.frac * 100).toFixed(1).padStart(9)}% ${o.ratio.toFixed(3).padStart(10)} ` +
      `${binds ? "  <-- BINDS (on the hull)" : `  ${((1 - rel) * 100).toFixed(1)}% of headroom below the hull`}`,
  );
}
console.log("-".repeat(80));
console.log(`
The hull is the tightest curve no race sits above, so it touches whichever
races rank highest on sustained-fraction-FOR-THEIR-OWN-DURATION -- the
"vs curve" column above, not the raw percentage and not the duration.

It is NOT the races with the highest "chosen %" in the pacing-margin list.
That column is theta: how hard the athlete went relative to the model's
ceiling FOR THAT COURSE. Different numerator, different denominator. A race
can sit at 92% of a low ceiling -- low because the model thinks that course
is expensive -- while the athlete held only a modest absolute fraction of
VO2max across it. Those two readings disagreeing is itself a signal that
the course's modelled cost is off.`);
