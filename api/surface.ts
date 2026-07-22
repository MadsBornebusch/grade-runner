import type { IncomingMessage, ServerResponse } from "node:http";
import { handleErrors, readJsonBody, sendJson } from "./_lib/http.js";

// Proxies a route's lat/lon points to Valhalla's public map-matching
// service for per-edge surface classification (src/model/surfaceExposure.ts
// consumes the response). Deliberately NOT gated on gr_session/Strava
// connection, unlike the other API routes -- a GPX file uploaded directly
// in Planning mode never touches Strava at all, and surface lookup should
// work for that path too. The shape-point cap below is this route's only
// abuse guard (no per-user rate limiting -- Vercel functions are
// stateless and this is public map data, not anything sensitive).
const MAX_SHAPE_POINTS = 1000;
const VALHALLA_URL = "https://valhalla1.openstreetmap.de/trace_attributes";

interface LatLon {
  lat: number;
  lon: number;
}

interface SurfaceRequestBody {
  shape?: LatLon[];
}

export default handleErrors(async (req: IncomingMessage, res: ServerResponse) => {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const body = (await readJsonBody(req)) as SurfaceRequestBody | undefined;
  const shape = body?.shape;
  if (!Array.isArray(shape) || shape.length < 2) {
    sendJson(res, 400, { error: "Missing or too-short shape (need at least 2 {lat, lon} points)" });
    return;
  }
  if (shape.length > MAX_SHAPE_POINTS) {
    sendJson(res, 400, { error: `shape has ${shape.length} points, max ${MAX_SHAPE_POINTS}` });
    return;
  }
  if (!shape.every((p) => typeof p?.lat === "number" && typeof p?.lon === "number")) {
    sendJson(res, 400, { error: "Every shape point needs numeric lat/lon" });
    return;
  }

  const valhallaRes = await fetch(VALHALLA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      shape,
      costing: "pedestrian",
      shape_match: "map_snap",
      filters: { attributes: ["edge.surface", "edge.length"], action: "include" },
    }),
  });

  if (!valhallaRes.ok) {
    sendJson(res, 502, { error: `Valhalla request failed: ${valhallaRes.status}` });
    return;
  }

  const valhallaBody = (await valhallaRes.json()) as { edges?: unknown };
  sendJson(res, 200, { edges: valhallaBody.edges ?? [] });
});
