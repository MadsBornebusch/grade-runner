import type { IncomingMessage } from "node:http";
import { beforeEach, describe, expect, it } from "vitest";
import { clearedCookieHeaders, getSession, getSettings, sessionCookieHeader, settingsCookieHeader } from "./session.ts";

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
