// Suggests which stored runs are worth showing in the race-tagging list
// (RunLibraryPanel.tsx) for pacingMarginFit.ts's fit. Deliberately a
// SUGGESTION only, not a gate on what the fit will actually use -- that gate
// is the user's own explicit raceTag confirmation (StoredRun.raceTag), not
// this heuristic. A real check this session found a name heuristic alone
// misclassified a club interval session as a race and would have conflated
// a backyard-ultra loop format with a continuous one -- this exists purely
// to keep the candidate LIST short enough to review (a library can hold
// hundreds of runs), not to decide who's actually a race.

/** Strava auto-generates a "{time of day} {activity type}" title whenever
 * an athlete doesn't rename an upload -- these are almost never real races
 * (a race gets renamed to its actual name, or keeps an event-provided
 * title). Matching this pattern is a strong, cheap signal an activity is
 * NOT worth surfacing as a race candidate. */
const GENERIC_STRAVA_TITLE =
  /^(early morning|morning|lunch|afternoon|evening|late night|night) (run|trail run|hike|walk|ride|mountain bike ride|virtual run|virtual ride)$/i;

export function looksLikeGenericStravaTitle(name: string): boolean {
  return GENERIC_STRAVA_TITLE.test(name.trim());
}
