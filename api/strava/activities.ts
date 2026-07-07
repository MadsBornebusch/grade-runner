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

  const perPage = getQuery(req).get("per_page") ?? "20";
  const stravaRes = await fetch(
    `https://www.strava.com/api/v3/athlete/activities?per_page=${encodeURIComponent(perPage)}`,
    { headers: { Authorization: `Bearer ${auth.accessToken}` } },
  );
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
  sendJson(res, 200, runs);
});
