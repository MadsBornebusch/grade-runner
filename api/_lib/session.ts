// Cookie-based session: no database, since each visitor's browser already
// isolates its own state. Two cookies, both encrypted with the same
// SESSION_SECRET and scoped to Path=/api so they're never sent with normal
// page/asset requests:
//   gr_session  -- Strava tokens + athlete display name
//   gr_settings -- the FormInputs JSON blob (cross-device sync)

import { randomBytes, timingSafeEqual } from "node:crypto";
import { parseCookie, stringifySetCookie } from "cookie";
import type { IncomingMessage, ServerResponse } from "node:http";
import { decrypt, encrypt } from "./crypto.js";
import { sendJson } from "./http.js";

const SESSION_COOKIE = "gr_session";
/** Short-lived, holds only the OAuth CSRF state nonce between the redirect
 * out to Strava and the callback coming back. */
const OAUTH_STATE_COOKIE = "gr_oauth_state";
const SETTINGS_COOKIE = "gr_settings";
const COOKIE_MAX_AGE_S = 60 * 60 * 24 * 365;
/** The user has to finish Strava's consent screen within this window. Long
 * enough not to be annoying, short enough that a stolen nonce is useless. */
const OAUTH_STATE_MAX_AGE_S = 10 * 60;

export interface StravaSession {
  refreshToken: string;
  accessToken: string;
  /** Unix seconds, matches Strava's `expires_at`. */
  accessTokenExpiresAt: number;
  athleteName: string;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function readCookie(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  return parseCookie(header)[name] ?? null;
}

function cookieHeader(name: string, value: string, maxAgeS: number): string {
  return stringifySetCookie({
    name,
    value,
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/api",
    maxAge: maxAgeS,
  });
}

export function getSession(req: IncomingMessage): StravaSession | null {
  const raw = readCookie(req, SESSION_COOKIE);
  return raw ? decrypt<StravaSession>(requireEnv("SESSION_SECRET"), raw) : null;
}

export function sessionCookieHeader(session: StravaSession): string {
  return cookieHeader(SESSION_COOKIE, encrypt(requireEnv("SESSION_SECRET"), session), COOKIE_MAX_AGE_S);
}

/**
 * OAuth CSRF protection. Without a state check, an attacker can complete
 * the flow with THEIR authorization code in a victim's browser, silently
 * binding the victim's session to the attacker's Strava account. SameSite
 * does not help: the callback is a top-level GET navigation, which lax
 * cookies are sent with by design.
 *
 * The nonce is stored in its own cookie rather than server-side because
 * there's no session store to put it in -- the same reason the tokens live
 * in a cookie. It's compared with timingSafeEqual and cleared on use, so a
 * nonce is good for exactly one callback.
 */
export function createOAuthState(): { state: string; cookie: string } {
  const state = randomBytes(32).toString("base64url");
  return {
    state,
    // Path=/api/strava so it rides along with the callback but nothing else.
    cookie: stringifySetCookie({
      name: OAUTH_STATE_COOKIE,
      value: state,
      httpOnly: true,
      secure: true,
      // "lax" is sufficient AND correct: the callback is a cross-site
      // top-level GET navigation, which is precisely the case Lax still
      // sends cookies for. "none" would be needlessly permissive.
      sameSite: "lax",
      path: "/api/strava",
      maxAge: OAUTH_STATE_MAX_AGE_S,
    }),
  };
}

/** True only if the callback's `state` matches the nonce we issued. */
export function verifyOAuthState(req: IncomingMessage, stateFromQuery: string | null): boolean {
  const expected = readCookie(req, OAUTH_STATE_COOKIE);
  if (!expected || !stateFromQuery) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(stateFromQuery);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Expires the one-shot nonce, whether the callback succeeded or not. */
export function clearedOAuthStateCookie(): string {
  return stringifySetCookie({
    name: OAUTH_STATE_COOKIE,
    value: "",
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/api/strava",
    maxAge: 0,
  });
}

export function clearedCookieHeaders(): string[] {
  return [cookieHeader(SESSION_COOKIE, "", 0), cookieHeader(SETTINGS_COOKIE, "", 0)];
}

export function getSettings(req: IncomingMessage): unknown | null {
  const raw = readCookie(req, SETTINGS_COOKIE);
  return raw ? decrypt(requireEnv("SESSION_SECRET"), raw) : null;
}

export function settingsCookieHeader(value: unknown): string {
  return cookieHeader(SETTINGS_COOKIE, encrypt(requireEnv("SESSION_SECRET"), value), COOKIE_MAX_AGE_S);
}

interface StravaTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

const REFRESH_MARGIN_S = 5 * 60;

/**
 * Refreshes the Strava access token if it's expiring within the next 5
 * minutes. Returns the valid access token, plus an updated session (with a
 * Set-Cookie header the caller must apply) if a refresh happened -- Strava
 * may rotate the refresh token on refresh, so the old one can't just be
 * reused indefinitely.
 */
export async function getValidAccessToken(
  session: StravaSession,
): Promise<{ accessToken: string; refreshedSession: StravaSession | null }> {
  const nowS = Math.floor(Date.now() / 1000);
  if (session.accessTokenExpiresAt > nowS + REFRESH_MARGIN_S) {
    return { accessToken: session.accessToken, refreshedSession: null };
  }

  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: requireEnv("STRAVA_CLIENT_ID"),
      client_secret: requireEnv("STRAVA_CLIENT_SECRET"),
      grant_type: "refresh_token",
      refresh_token: session.refreshToken,
    }),
  });
  if (!res.ok) throw new Error(`Strava token refresh failed: ${res.status}`);

  const body = (await res.json()) as StravaTokenResponse;
  const refreshedSession: StravaSession = {
    ...session,
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    accessTokenExpiresAt: body.expires_at,
  };
  return { accessToken: refreshedSession.accessToken, refreshedSession };
}

/**
 * Shared guard for the Strava API routes: reads the session, refreshes the
 * access token if needed (re-setting the cookie if Strava rotated the
 * refresh token), and writes a 401 itself if there's no session -- so each
 * route just does `const auth = await requireValidAccessToken(req, res); if
 * (!auth) return;`.
 */
export async function requireValidAccessToken(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<{ accessToken: string } | null> {
  const session = getSession(req);
  if (!session) {
    sendJson(res, 401, { error: "Not connected to Strava" });
    return null;
  }
  const { accessToken, refreshedSession } = await getValidAccessToken(session);
  if (refreshedSession) {
    res.setHeader("Set-Cookie", sessionCookieHeader(refreshedSession));
  }
  return { accessToken };
}
