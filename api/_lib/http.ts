import type { IncomingMessage, ServerResponse } from "node:http";

export function sendJson(res: ServerResponse, status: number, body: unknown, cookies: string[] = []): void {
  if (cookies.length > 0) res.setHeader("Set-Cookie", cookies);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

export function redirect(res: ServerResponse, location: string, cookies: string[] = []): void {
  if (cookies.length > 0) res.setHeader("Set-Cookie", cookies);
  res.statusCode = 302;
  res.setHeader("Location", location);
  res.end();
}

export function getQuery(req: IncomingMessage): URLSearchParams {
  return new URL(req.url ?? "", "http://internal").searchParams;
}

/**
 * `vercel dev`'s local runtime pre-parses a JSON request body and attaches
 * it as `req.body`, draining the underlying stream in the process -- a
 * manual `for await (const chunk of req)` read (which is what real
 * production Vercel's raw IncomingMessage needs) sees nothing left and
 * silently returns undefined. Prefer `req.body` when present (covers local
 * dev), falling back to the raw stream read otherwise (covers production).
 */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const preParsed = (req as IncomingMessage & { body?: unknown }).body;
  if (preParsed !== undefined) return preParsed;

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

/** Derives the deployment's own origin from the incoming request, so the
 * OAuth redirect_uri doesn't need a hardcoded domain per environment.
 * Strava's own registered-callback-domain allowlist is the real security
 * backstop here, not this derivation. */
export function baseUrl(req: IncomingMessage): string {
  const host = (req.headers["x-forwarded-host"] as string | undefined) ?? req.headers.host ?? "localhost";
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "https";
  return `${proto}://${host}`;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

/** Wraps a handler so a thrown/rejected error becomes a JSON 500 with the
 * error's message (e.g. "SESSION_SECRET is not configured") instead of
 * Vercel's opaque generic crash page -- most failure modes here are
 * misconfiguration during setup, so a legible message matters. */
export function handleErrors(fn: Handler): Handler {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : "Internal error" });
    }
  };
}
