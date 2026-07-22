import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { readJsonBody } from "./http.ts";

/** A real IncomingMessage is an async-iterable stream of Buffer chunks --
 * simulate that directly rather than pulling in an http server for this. */
function fakeStreamRequest(chunks: string[]): IncomingMessage {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) yield Buffer.from(chunk);
    },
  } as unknown as IncomingMessage;
}

describe("readJsonBody", () => {
  it("prefers req.body when already pre-parsed (vercel dev's local runtime does this, draining the raw stream first)", async () => {
    const req = { body: { hello: "world" } } as unknown as IncomingMessage;
    expect(await readJsonBody(req)).toEqual({ hello: "world" });
  });

  it("falls back to reading the raw async-iterable stream when req.body is absent (real production Vercel)", async () => {
    const req = fakeStreamRequest(['{"hello"', ':"world"}']);
    expect(await readJsonBody(req)).toEqual({ hello: "world" });
  });

  it("returns undefined for an empty raw stream", async () => {
    const req = fakeStreamRequest([]);
    expect(await readJsonBody(req)).toBeUndefined();
  });

  it("returns req.body's own undefined-ness correctly -- an explicit null pre-parsed body is NOT treated as absent", async () => {
    // Only undefined (the property genuinely missing) should fall through
    // to the stream read -- a real, meaningful `null` JSON body shouldn't
    // be silently discarded in favor of re-reading an already-drained stream.
    const req = { body: null } as unknown as IncomingMessage;
    expect(await readJsonBody(req)).toBeNull();
  });
});
