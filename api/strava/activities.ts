import type { IncomingMessage, ServerResponse } from "node:http";
import { getQuery, handleErrors, sendJson } from "../_lib/http.js";
import { requireValidAccessToken } from "../_lib/session.js";

interface StravaActivitySummary {
  id: number;
  name: string;
  sport_type: string;
  start_date: string;
  distance: number;
  moving_time: number;
}

const RUN_SPORT_TYPES = new Set(["Run", "TrailRun", "VirtualRun"]);

export default handleErrors(async (req: IncomingMessage, res: ServerResponse) => {
  const auth = await requireValidAccessToken(req, res);
  if (!auth) return;

  const perPage = Number(getQuery(req).get("per_page") ?? "20");
  const page = Number(getQuery(req).get("page") ?? "1");
  const before = getQuery(req).get("before");

  const url = new URL("https://www.strava.com/api/v3/athlete/activities");
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("page", String(page));
  // Unix seconds -- Strava returns activities strictly before this cutoff,
  // which is how "jump to a date" is implemented: fix the cutoff once, then
  // keep paging within it.
  if (before) url.searchParams.set("before", before);

  const stravaRes = await fetch(url, { headers: { Authorization: `Bearer ${auth.accessToken}` } });
  if (!stravaRes.ok) {
    sendJson(res, stravaRes.status, { error: `Strava activities request failed: ${stravaRes.status}` });
    return;
  }

  const activities = (await stravaRes.json()) as StravaActivitySummary[];
  const runs = activities
    .filter((a) => RUN_SPORT_TYPES.has(a.sport_type))
    .map((a) => ({
      id: a.id,
      name: a.name,
      date: a.start_date,
      distanceKm: a.distance / 1000,
      movingTimeS: a.moving_time,
    }));
  // A full page of raw activities (before the run-type filter) means there's
  // likely another page; a short page means we've hit the end of history --
  // this has to be judged on the raw count, since filtering can otherwise
  // shrink even a "full" page down to look empty.
  sendJson(res, 200, { runs, hasMore: activities.length === perPage });
});
