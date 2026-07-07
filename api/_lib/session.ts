// Cookie-based session: no database, since each visitor's browser already
// isolates its own state. Two cookies, both encrypted with the same
// SESSION_SECRET and scoped to Path=/api so they're never sent with normal
// page/asset requests:
//   gr_session  -- Strava tokens + athlete display name
//   gr_settings -- the FormInputs JSON blob (cross-device sync)

import { parseCookie, stringifySetCookie } from "cookie";
import type { IncomingMessage, ServerResponse } from "node:http";
import { decrypt, encrypt } from "./crypto.ts";
import { sendJson } from "./http.ts";

const SESSION_COOKIE = "gr_session";
const SETTINGS_COOKIE = "gr_settings";
const COOKIE_MAX_AGE_S = 60 * 60 * 24 * 365;

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
