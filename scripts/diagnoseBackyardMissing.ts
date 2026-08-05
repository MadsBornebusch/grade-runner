// Why does "Ås Backyard ultra" (13.7h, 2025-09-20) never clear ANY of
// suggestRunsForFit's three buckets even at candidateCount=60/bucket
// (confirmed by decoupledCapSweep.ts)? Its durationS is defined (49346s)
// and it's well within the >=1hr durability floor, so it should be in the
// "longEnough" pool -- this instruments the durability bucket's own
// internal steps (longEnough count, pool size, descent-per-km value and
// neighbors, evenlySpacedPicks selection) to find exactly where it drops
// out.
//
// Usage: npx tsx scripts/diagnoseBackyardMissing.ts [--since=2025-01-01]
import { dedupeStoredRuns } from "../src/model/dedupeRuns.ts";
import { DURABILITY_MIN_DURATION_S } from "../src/model/suggestRuns.ts";
import type { StoredRun } from "../src/storage/runLibrary.ts";
import { arg, backfill } from "./stravaScriptHelpers.ts";

const BASE_URL = arg("base", "http://localhost:3000");
const SINCE_DATE = new Date(arg("since", "2025-01-01"));
const CANDIDATE_COUNT = 60;
const DURABILITY_POOL_MULTIPLIER = 3;

function descentPerKmProxy(run: StoredRun): number {
  if (!run.elevationGainM || !run.distanceKm) return 0;
  return run.elevationGainM / run.distanceKm;
}

function evenlySpacedPicks<T>(items: T[], count: number): T[] {
  if (items.length === 0 || count <= 0) return [];
  if (items.length <= count) return items;
  if (count === 1) return [items[items.length - 1]];
  const picks: T[] = [];
  for (let i = 0; i < count; i++) {
    const item = items[Math.round((i * (items.length - 1)) / (count - 1))];
    if (!picks.includes(item)) picks.push(item);
  }
  return picks;
}

async function main() {
  const runs = await backfill(BASE_URL, "", SINCE_DATE, { offline: true });
  const { kept } = dedupeStoredRuns(runs);
  const unfetched = kept.filter((r) => r.points === null && r.durationS !== undefined);
  console.log(`unfetched candidates total: ${unfetched.length}`);

  const longEnough = unfetched.filter((r) => (r.durationS ?? 0) >= DURABILITY_MIN_DURATION_S);
  console.log(`longEnough (>=1hr): ${longEnough.length}`);

  const byDurationDesc = [...longEnough].sort((a, b) => (b.durationS ?? 0) - (a.durationS ?? 0));
  const backyardDurRank = byDurationDesc.findIndex((r) => r.name.includes("Backyard"));
  console.log(`Ås Backyard's rank by raw duration among longEnough: ${backyardDurRank + 1} of ${byDurationDesc.length}`);

  const poolSize = CANDIDATE_COUNT * DURABILITY_POOL_MULTIPLIER;
  const pool = byDurationDesc.slice(0, poolSize);
  console.log(`pool size (top ${poolSize} by duration): ${pool.length}`);
  const backyardInPool = pool.some((r) => r.name.includes("Backyard"));
  console.log(`Ås Backyard in pool: ${backyardInPool}`);

  if (backyardInPool) {
    const rest = pool.slice(1); // pool[0] always kept separately
    const byDescent = [...rest].sort((a, b) => descentPerKmProxy(a) - descentPerKmProxy(b));
    const backyardDescentRank = byDescent.findIndex((r) => r.name.includes("Backyard"));
    console.log(`Ås Backyard's rank by descent/km among pool.slice(1) (n=${byDescent.length}): ${backyardDescentRank + 1}`);
    console.log(`  its descentPerKm: ${descentPerKmProxy(byDescent[backyardDescentRank]).toFixed(1)} m/km`);
    console.log(`  neighbors: [${byDescent.slice(Math.max(0, backyardDescentRank - 2), backyardDescentRank + 3).map((r) => `${r.name}=${descentPerKmProxy(r).toFixed(1)}`).join(", ")}]`);

    const picks = evenlySpacedPicks(byDescent, CANDIDATE_COUNT - 1);
    console.log(`evenlySpacedPicks(count=${CANDIDATE_COUNT - 1}) selected ${picks.length} of ${byDescent.length} -- Ås Backyard included: ${picks.some((r) => r.name.includes("Backyard"))}`);
  }

  // durationSpread bucket check
  const byDurDesc2 = [...unfetched].sort((a, b) => (b.durationS ?? 0) - (a.durationS ?? 0));
  const longest = byDurDesc2[0];
  console.log(`\ndurationSpread longest: ${longest?.name} (${((longest?.durationS ?? 0) / 3600).toFixed(2)}h)`);
  const ratio = (longest?.durationS ?? 0) / (unfetched.find((r) => r.name.includes("Backyard"))?.durationS ?? Infinity);
  console.log(`ratio of longest/Backyard: ${ratio.toFixed(2)} (needs >= 2 to qualify as a "shorter" duration-spread candidate)`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
