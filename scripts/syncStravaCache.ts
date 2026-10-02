// Brings the scripts' on-disk caches up to date with Strava: new activity
// summaries into .strava-cache/activities.json, full 1 Hz points for every
// run not yet cached, and OSM surface tags for each into .surface-cache/.
//
// Talks to the app's own /api/strava/* routes with a copied gr_session
// cookie, exactly like the other scripts -- but the server is a parameter,
// so it works against the DEPLOYED app and needs no local `vercel dev`:
//
//   npx tsx scripts/syncStravaCache.ts --baseUrl=https://<your-deployment>
//
// The cookie must come from that same deployment (the session is encrypted
// with that deployment's SESSION_SECRET): log in there in the browser, copy
// the gr_session cookie value from DevTools > Application > Cookies, and
// save just the value in .strava-session.local (gitignored).
//
// Each activity costs two Strava API requests (summary + streams), against
// Strava's 100-requests-per-15-minutes read limit, so fetches are paced and
// the run stops cleanly on a 429 -- everything already fetched is kept, and
// rerunning picks up where it stopped.
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { arg, backfill, fetchActivityPoints, fetchSurfaceEdgesCached, loadCookie } from "./stravaScriptHelpers.ts";
import { meta } from "./powerRunHelpers.ts";

const BASE_URL = arg("baseUrl", "http://localhost:3000");
const SESSION_FILE = fileURLToPath(new URL("../.strava-session.local", import.meta.url));
const CACHE = fileURLToPath(new URL("../.strava-cache/", import.meta.url));
/** ~9 s between activities keeps 2 requests each under 100 per 15 min. */
const PACE_MS = Number(arg("paceMs", "9500"));
const RUN_TYPES = /run/i;

const latestCached = [...meta.values()].map((a) => a.date).sort().at(-1);
const since = new Date(arg("since", latestCached ? latestCached.slice(0, 10) : "2020-01-01"));

const cookie = loadCookie(SESSION_FILE, BASE_URL);
console.log(`Syncing from ${BASE_URL}, activities since ${since.toISOString().slice(0, 10)}`);

const runs = await backfill(BASE_URL, cookie, since);
const cached = new Set(readdirSync(CACHE).filter((f) => f.startsWith("activity-")).map((f) => Number(f.slice(9, -5))));
const todo = runs.filter((r) => r.stravaId !== undefined && !cached.has(r.stravaId) && RUN_TYPES.test(r.name + " run"));
console.log(`${runs.length} activities since then, ${todo.length} without cached points\n`);

let fetched = 0;
for (const [i, r] of todo.entries()) {
  try {
    const { points } = await fetchActivityPoints(BASE_URL, cookie, r.stravaId!);
    const edges = await fetchSurfaceEdgesCached(String(r.stravaId), points);
    fetched++;
    console.log(`  ${r.date?.slice(0, 10)}  ${r.name.slice(0, 36).padEnd(37)} ${points.length} pts  surface ${edges ? "ok" : "--"}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ${r.date?.slice(0, 10)}  ${r.name.slice(0, 36).padEnd(37)} FAILED: ${msg}`);
    if (/429/.test(msg)) {
      console.log("\nStrava rate limit -- stopping. Everything fetched so far is cached; rerun in ~15 minutes.");
      break;
    }
    if (/401/.test(msg)) {
      console.log(`\nSession rejected -- copy a fresh gr_session cookie from ${BASE_URL} into .strava-session.local.`);
      break;
    }
  }
  if (i < todo.length - 1) await new Promise((res) => setTimeout(res, PACE_MS));
}
console.log(`\nDone: ${fetched} activities fetched.`);
