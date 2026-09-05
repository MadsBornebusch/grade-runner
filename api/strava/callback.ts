import type { IncomingMessage, ServerResponse } from "node:http";
import { getQuery, handleErrors, redirect } from "../_lib/http.js";
import {
  clearedOAuthStateCookie,
  requireEnv,
  sessionCookieHeader,
  verifyOAuthState,
  type StravaSession,
} from "../_lib/session.js";

interface StravaTokenExchangeResponse {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  athlete?: { firstname?: string; lastname?: string };
}

export default handleErrors(async (req: IncomingMessage, res: ServerResponse) => {
  const query = getQuery(req);
  const code = query.get("code");
  if (!code) {
    redirect(res, "/?strava=error", [clearedOAuthStateCookie()]);
    return;
  }
  // Reject a callback we didn't initiate: without this an attacker can get
  // a victim's browser to complete the flow with the ATTACKER's code,
  // binding the victim's session to the attacker's Strava account.
  if (!verifyOAuthState(req, query.get("state"))) {
    redirect(res, "/?strava=error", [clearedOAuthStateCookie()]);
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
    redirect(res, "/?strava=error", [clearedOAuthStateCookie()]);
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
  // Nonce is one-shot: cleared whether the exchange succeeded or not.
  redirect(res, "/", [sessionCookieHeader(session), clearedOAuthStateCookie()]);
});
