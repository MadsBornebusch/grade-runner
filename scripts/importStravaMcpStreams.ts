// Writes one activity into the scripts' .strava-cache/ from a Strava MCP
// get_activity_streams result saved to disk, for when the app's own
// /api/strava/* route (syncStravaCache.ts) isn't available. The MCP returns
// {location: [[lat, lon]...], altitude, heart_rate, watts, time} as parallel
// arrays, time in seconds from the start; the start instant comes from
// list_activities' start_local, interpreted in --timeZone.
//
//   npx tsx scripts/importStravaMcpStreams.ts --streams=<file> --id=<stravaId> \
//     --name="Evening Run" --startLocal=2026-10-18T19:55:35 \
//     --distanceM=7691.4 --movingS=3124 --elevationGainM=232 [--timeZone=Europe/Oslo]
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { arg } from "./stravaScriptHelpers.ts";

const CACHE = fileURLToPath(new URL("../.strava-cache/", import.meta.url));

/** The UTC instant whose wall-clock time in `timeZone` is `local`. */
function localToUtc(local: string, timeZone: string): Date {
  const asUtc = new Date(`${local}Z`);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(asUtc);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const shown = new Date(`${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}Z`);
  return new Date(asUtc.getTime() - (shown.getTime() - asUtc.getTime()));
}

const required = (name: string) => {
  const v = arg(name, "");
  if (!v) throw new Error(`--${name} is required`);
  return v;
};
const stravaId = Number(required("id"));
const name = required("name");
const start = localToUtc(required("startLocal"), arg("timeZone", "Europe/Oslo"));

const s = JSON.parse(readFileSync(required("streams"), "utf8")) as {
  location?: [number, number][]; altitude?: number[]; heart_rate?: number[]; watts?: number[]; time?: number[];
};
// Treadmill and indoor runs have no GPS: their summary row is still added,
// so the ledger can fall back to activityLoadFromSummary for them.
const points = (s.location?.length && s.time?.length ? s.location : []).map(([lat, lon], i) => ({
  lat, lon,
  ele: s.altitude?.[i] ?? null,
  time: new Date(start.getTime() + s.time![i] * 1000).toISOString(),
  hr: s.heart_rate?.[i] ?? null,
  power: s.watts?.[i] ?? null,
}));
if (points.length) writeFileSync(`${CACHE}activity-${stravaId}.json`, JSON.stringify({ name, points }));

const avg = (xs: number[] | undefined) => {
  const v = (xs ?? []).filter((x) => x > 0);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const path = `${CACHE}activities.json`;
const rows = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>[];
const id = `strava:${stravaId}`;
const existing = rows.find((r) => r.id === id);
const row = {
  id, name, addedAt: (existing?.addedAt as number | undefined) ?? Date.now(), points: null, stravaId,
  date: start.toISOString().replace(/\.\d{3}Z$/, "Z"),
  distanceKm: Number(required("distanceM")) / 1000,
  durationS: Number(required("movingS")),
  elevationGainM: Number(required("elevationGainM")),
  avgHeartRate: avg(s.heart_rate),
  avgWatts: avg(s.watts),
};
writeFileSync(path, JSON.stringify(existing ? rows.map((r) => (r.id === id ? row : r)) : [...rows, row]));
console.log(`${row.date.slice(0, 10)} ${name}: ${points.length} points, ${existing ? "updated" : "added"}`);
