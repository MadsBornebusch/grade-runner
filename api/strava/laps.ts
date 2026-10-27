import type { IncomingMessage, ServerResponse } from "node:http";
import { getQuery, handleErrors, sendJson } from "../_lib/http.js";
import { requireValidAccessToken } from "../_lib/session.js";

interface StravaLap {
  lap_index: number;
  distance: number;
  moving_time: number;
}

/** An activity's laps (one request), for entering treadmill grades. */
export default handleErrors(async (req: IncomingMessage, res: ServerResponse) => {
  const auth = await requireValidAccessToken(req, res);
  if (!auth) return;

  const id = getQuery(req).get("id");
  if (!id) {
    sendJson(res, 400, { error: "Missing id" });
    return;
  }

  const lapsRes = await fetch(`https://www.strava.com/api/v3/activities/${encodeURIComponent(id)}/laps`, {
    headers: { Authorization: `Bearer ${auth.accessToken}` },
  });
  if (!lapsRes.ok) {
    if (lapsRes.status === 429) sendJson(res, 429, { error: "Strava rate limit reached" });
    else if (lapsRes.status === 401 || lapsRes.status === 403) sendJson(res, 401, { error: "Your Strava session expired. Reconnect Strava and try again." });
    else if (lapsRes.status === 404) sendJson(res, 404, { error: "This activity is no longer available on Strava." });
    else sendJson(res, 502, { error: "Failed to fetch laps from Strava" });
    return;
  }
  const laps = (await lapsRes.json()) as StravaLap[];
  sendJson(res, 200, {
    laps: laps.sort((a, b) => a.lap_index - b.lap_index).map((l) => ({ distanceM: l.distance, movingS: l.moving_time })),
  });
});
