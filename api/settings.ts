import type { IncomingMessage, ServerResponse } from "node:http";
import { handleErrors, readJsonBody, sendJson } from "./_lib/http.ts";
import { getSession, getSettings, settingsCookieHeader } from "./_lib/session.ts";

// Cross-device settings sync is explicitly a Strava-login feature (per the
// user's request), not a generally open endpoint -- gated on gr_session
// existing rather than working for any anonymous visitor.
export default handleErrors(async (req: IncomingMessage, res: ServerResponse) => {
  const session = getSession(req);
  if (!session) {
    sendJson(res, 401, { error: "Not connected to Strava" });
    return;
  }

  if (req.method === "POST") {
    const body = await readJsonBody(req);
    sendJson(res, 200, { ok: true }, [settingsCookieHeader(body)]);
    return;
  }

  sendJson(res, 200, { settings: getSettings(req) });
});
