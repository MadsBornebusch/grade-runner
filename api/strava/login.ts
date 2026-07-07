import type { IncomingMessage, ServerResponse } from "node:http";
import { baseUrl, handleErrors, redirect } from "../_lib/http.js";
import { requireEnv } from "../_lib/session.js";

export default handleErrors((req: IncomingMessage, res: ServerResponse) => {
  const redirectUri = `${baseUrl(req)}/api/strava/callback`;
  const authorizeUrl = new URL("https://www.strava.com/oauth/authorize");
  authorizeUrl.searchParams.set("client_id", requireEnv("STRAVA_CLIENT_ID"));
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("approval_prompt", "auto");
  // read_all (not just read) -- the athlete is importing their own runs,
  // including ones marked private.
  authorizeUrl.searchParams.set("scope", "activity:read_all");
  redirect(res, authorizeUrl.toString());
});
