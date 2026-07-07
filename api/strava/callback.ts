import type { IncomingMessage, ServerResponse } from "node:http";
import { getQuery, handleErrors, redirect } from "../_lib/http.ts";
import { requireEnv, sessionCookieHeader, type StravaSession } from "../_lib/session.ts";

interface StravaTokenExchangeResponse {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  athlete?: { firstname?: string; lastname?: string };
}

export default handleErrors(async (req: IncomingMessage, res: ServerResponse) => {
  const code = getQuery(req).get("code");
  if (!code) {
    redirect(res, "/?strava=error");
    return;
  }

  const tokenRes = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: requireEnv("STRAVA_CLIENT_ID"),
      client_secret: requireEnv("STRAVA_CLIENT_SECRET"),
      code,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    redirect(res, "/?strava=error");
    return;
  }

  const body = (await tokenRes.json()) as StravaTokenExchangeResponse;
  const athleteName = [body.athlete?.firstname, body.athlete?.lastname].filter(Boolean).join(" ") || "Strava athlete";
  const session: StravaSession = {
    refreshToken: body.refresh_token,
    accessToken: body.access_token,
    accessTokenExpiresAt: body.expires_at,
    athleteName,
  };
  redirect(res, "/", [sessionCookieHeader(session)]);
});
