import type { IncomingMessage, ServerResponse } from "node:http";
import { getQuery, handleErrors, sendJson } from "../_lib/http.js";
import { requireValidAccessToken } from "../_lib/session.js";
import { buildPointsFromStreams, type StravaStreams } from "../_lib/stravaConvert.js";

interface StravaActivityDetail {
  name: string;
  start_date: string;
}

export default handleErrors(async (req: IncomingMessage, res: ServerResponse) => {
  const auth = await requireValidAccessToken(req, res);
  if (!auth) return;

  const id = getQuery(req).get("id");
  if (!id) {
    sendJson(res, 400, { error: "Missing id" });
    return;
  }

  const authHeaders = { Authorization: `Bearer ${auth.accessToken}` };
  const [detailRes, streamsRes] = await Promise.all([
    fetch(`https://www.strava.com/api/v3/activities/${encodeURIComponent(id)}`, { headers: authHeaders }),
    fetch(
      `https://www.strava.com/api/v3/activities/${encodeURIComponent(id)}/streams?keys=time,latlng,altitude,heartrate,watts&key_by_type=true`,
      { headers: authHeaders },
    ),
  ]);

  if (!detailRes.ok || !streamsRes.ok) {
    sendJson(res, 502, { error: "Failed to fetch activity from Strava" });
    return;
  }

  const detail = (await detailRes.json()) as StravaActivityDetail;
  const streams = (await streamsRes.json()) as StravaStreams;
  const points = buildPointsFromStreams(detail.start_date, streams);
  if (points.length === 0) {
    sendJson(res, 422, { error: "This activity has no GPS data." });
    return;
  }

  sendJson(res, 200, { name: detail.name, points });
});
