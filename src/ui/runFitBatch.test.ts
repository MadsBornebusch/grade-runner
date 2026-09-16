import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// The module does network + IndexedDB at import time only via these, so stub
// them before importing the unit under test.
const fetchSurfaceEdges = vi.fn();
vi.mock("./surfaceLookup", () => ({ fetchSurfaceEdges: (...a: unknown[]) => fetchSurfaceEdges(...a) }));
vi.mock("../storage/runLibrary", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  setStoredRunSurfaceEdges: vi.fn(async () => {}),
}));

const { __testing } = await import("./runFitBatch");

describe("prefetchSurfaceEdges", () => {
  beforeEach(() => {
    fetchSurfaceEdges.mockReset();
    vi.useRealTimers();
  });
  afterEach(() => vi.useRealTimers());

  const run = (id: string, cached = false) =>
    ({ run: { id, surfaceEdges: cached ? [{ surface: "paved", beginKm: 0, endKm: 1 }] : undefined } as never, points: [] as never });

  it("fetches uncached runs concurrently rather than one after another", async () => {
    let inFlight = 0;
    let peak = 0;
    fetchSurfaceEdges.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return [{ surface: "paved", beginKm: 0, endKm: 1 }];
    });
    const runs = Array.from({ length: 20 }, (_, i) => run(`r${i}`));
    await __testing.prefetchSurfaceEdges(runs, () => {});
    // The bug this fixes: sequential fetching (peak would be 1).
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(__testing.SURFACE_FETCH_CONCURRENCY);
  });

  it("never calls the network for a run whose edges are already cached", async () => {
    await __testing.prefetchSurfaceEdges([run("cached", true)], () => {});
    expect(fetchSurfaceEdges).not.toHaveBeenCalled();
  });

  it("reports progress for every run, cached or not", async () => {
    fetchSurfaceEdges.mockResolvedValue(null);
    const seen: number[] = [];
    await __testing.prefetchSurfaceEdges([run("a"), run("b", true), run("c")], (done) => seen.push(done));
    expect(seen.sort((x, y) => x - y)).toEqual([1, 2, 3]);
  });

  it("treats a failed lookup as 'no surface data' instead of failing the fit", async () => {
    fetchSurfaceEdges.mockRejectedValue(new Error("valhalla down"));
    const out = await __testing.prefetchSurfaceEdges([run("a")], () => {});
    expect(out.get("a")).toBeNull();
  });

  it("stops starting new network lookups once the time budget is spent", async () => {
    // The hang this guards: surface failures are deliberately never cached,
    // so every fit retries them. Without a budget a big library never
    // finishes a fit at all.
    fetchSurfaceEdges.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return null;
    });
    const runs = Array.from({ length: 400 }, (_, i) => run(`r${i}`));
    const started = Date.now();
    await __testing.prefetchSurfaceEdges(runs, () => {}, 60);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(fetchSurfaceEdges.mock.calls.length).toBeLessThan(400);
  });
});

describe("analyzeOptionsFor", () => {
  const formInputs = {
    bodyMassKg: 70,
    intakeGPerH: 60,
    glycogenGPerKg: 7.5,
    walkMaxMs: 2,
    altitudeAdjustment: true,
    surfaceCostMultipliers: { gravel: 1.06, path: 1.17 },
  } as never;

  it("measures against the terrain cost the solver will predict with", () => {
    // The invariant. A fit measures what the athlete produced; the solver
    // spends that measurement back. Measured on plain Minetti and spent on
    // a terrain-charged course, the duration-ceiling envelope licensed too
    // little power on unpaved races -- Ecotrail 80 predicted +6.5% and
    // Askerspurten +4.4%, both races the envelope RESTS ON and should
    // reproduce. Consistent measurement gives +1.3% and +1.5%.
    expect(__testing.analyzeOptionsFor(formInputs, {}).surfaceCostMultipliers).toEqual({
      gravel: 1.06,
      path: 1.17,
    });
  });

  it("passes undefined, not an empty object, when nothing is fitted yet", () => {
    // analysis.ts distinguishes "no surface model" from "a model that says
    // 1.0x"; an empty object would read as the latter.
    const unfitted = { ...(formInputs as object), surfaceCostMultipliers: null } as never;
    expect(__testing.analyzeOptionsFor(unfitted, {}).surfaceCostMultipliers).toBeUndefined();
  });

  it("carries the rest of the athlete's physiology through unchanged", () => {
    const opts = __testing.analyzeOptionsFor(formInputs, { vo2MaxMlPerKgPerMin: 55 });
    expect(opts.bodyMassKg).toBe(70);
    expect(opts.walkMaxMs).toBe(2);
    expect(opts.altitudeAdjustment).toBe(true);
    expect(opts.fueling).toEqual({ intakeGPerH: 60 });
    expect(opts.ceilingParams).toEqual({ vo2MaxMlPerKgPerMin: 55 });
  });
});
