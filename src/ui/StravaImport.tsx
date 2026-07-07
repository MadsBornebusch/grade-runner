import { useCallback, useState } from "react";
import type { GpxPoint } from "../gpx/pipeline";
import { useStravaSession } from "./useStravaSession";

interface StravaActivitySummary {
  id: number;
  name: string;
  date: string;
  distanceKm: number;
  movingTimeS: number;
}

/** Same fields as GpxPoint, but as it comes over the wire -- `time` is an
 * ISO string (JSON has no Date type), parsed back to a Date before this
 * reaches any caller. */
interface WireGpxPoint {
  lat: number;
  lon: number;
  ele: number | null;
  time: string | null;
  hr: number | null;
  power: number | null;
}

interface StravaImportProps {
  onImport: (points: GpxPoint[], name: string) => void;
}

export function StravaImport({ onImport }: StravaImportProps) {
  const { connected, athleteName, loading } = useStravaSession();
  const [activities, setActivities] = useState<StravaActivitySummary[] | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [importingId, setImportingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadActivities = useCallback(async () => {
    setListLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/strava/activities");
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to load activities.");
      setActivities(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load activities.");
    } finally {
      setListLoading(false);
    }
  }, []);

  const importActivity = useCallback(
    async (activity: StravaActivitySummary) => {
      setImportingId(activity.id);
      setError(null);
      try {
        const res = await fetch(`/api/strava/activity?id=${activity.id}`);
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "Failed to import this activity.");
        const points: GpxPoint[] = (body.points as WireGpxPoint[]).map((p) => ({
          ...p,
          time: p.time ? new Date(p.time) : null,
        }));
        onImport(points, activity.name);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to import this activity.");
      } finally {
        setImportingId(null);
      }
    },
    [onImport],
  );

  if (loading) return null;

  if (!connected) {
    return (
      <a className="strava-import__connect" href="/api/strava/login">
        Connect Strava
      </a>
    );
  }

  return (
    <div className="strava-import">
      <div className="strava-import__header">
        <span>Connected to Strava as {athleteName}</span>
        <a href="/api/strava/logout">Disconnect</a>
      </div>
      {!activities && (
        <button type="button" className="fatox-add" onClick={loadActivities} disabled={listLoading}>
          {listLoading ? "Loading…" : "Show recent runs"}
        </button>
      )}
      {error && <p className="gpx-upload__error">{error}</p>}
      {activities && (
        <div className="fatox-rows">
          {activities.length === 0 && <p className="placeholder">No recent runs found on Strava.</p>}
          {activities.map((activity) => (
            <div key={activity.id} className="run-library-row">
              <span className="run-library-row__label">
                {activity.name} &middot; {activity.distanceKm.toFixed(1)} km &middot;{" "}
                {(activity.movingTimeS / 3600).toFixed(1)} h &middot; {new Date(activity.date).toLocaleDateString()}
              </span>
              <button
                type="button"
                className="fatox-add"
                onClick={() => importActivity(activity)}
                disabled={importingId === activity.id}
              >
                {importingId === activity.id ? "Importing…" : "Import"}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
