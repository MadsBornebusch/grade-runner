// Converts Strava's activity-streams response (parallel arrays, JSON) into
// the same GpxPoint[] shape src/gpx/pipeline.ts's parseGpx produces from an
// uploaded file -- so every downstream consumer (runPipeline, the run
// library) needs zero changes to accept a Strava-sourced run.

import type { GpxPoint } from "../../src/gpx/pipeline.ts";

export interface StravaStreams {
  time?: { data: number[] };
  latlng?: { data: [number, number][] };
  altitude?: { data: number[] };
  heartrate?: { data: number[] };
  watts?: { data: number[] };
}

/** Returns [] if the activity has no GPS stream (e.g. a manual/treadmill
 * entry) -- callers should surface that as "no GPS data" rather than an
 * empty-but-valid run. */
export function buildPointsFromStreams(startDateIso: string, streams: StravaStreams): GpxPoint[] {
  const latlng = streams.latlng?.data ?? [];
  if (latlng.length === 0) return [];

  const time = streams.time?.data;
  const altitude = streams.altitude?.data;
  const heartrate = streams.heartrate?.data;
  const watts = streams.watts?.data;
  const startMs = new Date(startDateIso).getTime();

  return latlng.map(([lat, lon], i) => ({
    lat,
    lon,
    ele: altitude?.[i] ?? null,
    time: time?.[i] !== undefined ? new Date(startMs + time[i] * 1000) : null,
    hr: heartrate?.[i] ?? null,
    power: watts?.[i] ?? null,
  }));
}
