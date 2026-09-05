import type { IncomingMessage } from "node:http";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearedCookieHeaders,
  clearedOAuthStateCookie,
  createOAuthState,
  getSession,
  getSettings,
  sessionCookieHeader,
  settingsCookieHeader,
  verifyOAuthState,
} from "./session.ts";

function fakeRequest(cookieHeader: string | undefined): IncomingMessage {
  return { headers: { cookie: cookieHeader } } as IncomingMessage;
}

/** A real Set-Cookie header looks like "name=value; HttpOnly; ...", but a
 * request's Cookie header is just "name=value" -- pull that part out to
 * simulate what the browser would actually send back. */
function toCookieHeader(setCookieHeader: string): string {
  return setCookieHeader.split(";")[0];
}

describe("session cookies", () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = "test-session-secret";
  });

  it("round-trips a Strava session through sessionCookieHeader/getSession", () => {
    const session = {
      refreshToken: "refresh-abc",
      accessToken: "access-xyz",
      accessTokenExpiresAt: 1234567890,
      athleteName: "Mads B",
    };
    const header = sessionCookieHeader(session);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("Path=/api");

    const req = fakeRequest(toCookieHeader(header));
    expect(getSession(req)).toEqual(session);
  });

  it("returns null when there's no session cookie", () => {
    expect(getSession(fakeRequest(undefined))).toBeNull();
  });

  it("round-trips a settings blob through settingsCookieHeader/getSettings", () => {
    const settings = { bodyMassKg: 70, vo2MaxMlPerKgPerMin: 50, fatOxPoints: [] };
    const header = settingsCookieHeader(settings);
    const req = fakeRequest(toCookieHeader(header));
    expect(getSettings(req)).toEqual(settings);
  });

  it("clearedCookieHeaders expires both cookies", () => {
    const headers = clearedCookieHeaders();
    expect(headers).toHaveLength(2);
    for (const h of headers) {
      expect(h).toContain("Max-Age=0");
    }
  });
});

describe("OAuth state (CSRF protection)", () => {
  const reqWithCookie = fakeRequest;

  it("issues a high-entropy nonce and a cookie carrying it", () => {
    const { state, cookie } = createOAuthState();
    expect(state.length).toBeGreaterThanOrEqual(32);
    expect(cookie).toContain(`gr_oauth_state=${state}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
  });

  it("issues a different nonce every time", () => {
    expect(createOAuthState().state).not.toBe(createOAuthState().state);
  });

  it("uses SameSite=Lax, which still rides the cross-site callback navigation", () => {
    // Lax sends cookies on cross-site TOP-LEVEL GET navigations, which is
    // exactly what Strava's callback redirect is -- so None would be
    // needlessly permissive here.
    expect(createOAuthState().cookie).toMatch(/SameSite=Lax/i);
  });

  it("scopes the nonce to /api/strava, not the whole site", () => {
    expect(createOAuthState().cookie).toContain("Path=/api/strava");
  });

  it("accepts a callback whose state matches the issued nonce", () => {
    const { state } = createOAuthState();
    expect(verifyOAuthState(reqWithCookie(`gr_oauth_state=${state}`), state)).toBe(true);
  });

  it("rejects the forged-callback attack: attacker's code, no matching nonce", () => {
    const { state } = createOAuthState();
    expect(verifyOAuthState(reqWithCookie(`gr_oauth_state=${state}`), "attacker-supplied-state")).toBe(false);
  });

  it("rejects a callback with no state cookie at all", () => {
    expect(verifyOAuthState(reqWithCookie(undefined), "anything")).toBe(false);
  });

  it("rejects a callback with no state query parameter", () => {
    const { state } = createOAuthState();
    expect(verifyOAuthState(reqWithCookie(`gr_oauth_state=${state}`), null)).toBe(false);
  });

  it("rejects a state that merely prefixes the real nonce", () => {
    const { state } = createOAuthState();
    expect(verifyOAuthState(reqWithCookie(`gr_oauth_state=${state}`), state.slice(0, -1))).toBe(false);
  });

  it("expires the nonce so it is good for exactly one callback", () => {
    expect(clearedOAuthStateCookie()).toMatch(/Max-Age=0/i);
  });
});
