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

/** Accepts a bare numeric ID or a full Strava URL like
 * strava.com/activities/1234567890(/overview). Returns null if neither
 * pattern matches. */
function extractActivityId(input: string): string | null {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  const match = trimmed.match(/strava\.com\/activities\/(\d+)/);
  return match ? match[1] : null;
}

export function StravaImport({ onImport }: StravaImportProps) {
  const { connected, athleteName, loading } = useStravaSession();
  const [activities, setActivities] = useState<StravaActivitySummary[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [listLoading, setListLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nameFilter, setNameFilter] = useState("");
  const [linkInput, setLinkInput] = useState("");
  const [linkImporting, setLinkImporting] = useState(false);
  const [importingId, setImportingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadActivities = useCallback(async (pageToLoad: number, append: boolean) => {
    if (append) setLoadingMore(true);
    else setListLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/strava/activities?page=${pageToLoad}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to load activities.");
      setActivities((prev) => (append ? [...(prev ?? []), ...body.runs] : body.runs));
      setHasMore(body.hasMore);
      setPage(pageToLoad);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load activities.");
    } finally {
      if (append) setLoadingMore(false);
      else setListLoading(false);
    }
  }, []);

  const importById = useCallback(
    async (id: string, fallbackName: string) => {
      setError(null);
      try {
        const res = await fetch(`/api/strava/activity?id=${encodeURIComponent(id)}`);
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "Failed to import this activity.");
        const points: GpxPoint[] = (body.points as WireGpxPoint[]).map((p) => ({
          ...p,
          time: p.time ? new Date(p.time) : null,
        }));
        onImport(points, body.name ?? fallbackName);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to import this activity.");
      }
    },
    [onImport],
  );

  const importFromList = useCallback(
    async (activity: StravaActivitySummary) => {
      setImportingId(String(activity.id));
      await importById(String(activity.id), activity.name);
      setImportingId(null);
    },
    [importById],
  );

  const importByLink = useCallback(async () => {
    const id = extractActivityId(linkInput);
    if (!id) {
      setError("Couldn't find an activity ID in that -- paste a link like strava.com/activities/1234567890, or just the number.");
      return;
    }
    setLinkImporting(true);
    await importById(id, `Strava activity ${id}`);
    setLinkImporting(false);
  }, [linkInput, importById]);

  if (loading) return null;

  if (!connected) {
    return (
      <a className="strava-import__connect" href="/api/strava/login">
        Connect Strava
      </a>
    );
  }

  const visibleActivities = activities?.filter((a) => a.name.toLowerCase().includes(nameFilter.toLowerCase())) ?? null;

  return (
    <div className="strava-import">
      <div className="strava-import__header">
        <span>Connected to Strava as {athleteName}</span>
        <a href="/api/strava/logout">Disconnect</a>
      </div>

      <div className="strava-import__link-row">
        <input
          type="text"
          placeholder="Or paste a Strava activity link or ID"
          value={linkInput}
          onChange={(e) => setLinkInput(e.target.value)}
        />
        <button type="button" className="fatox-add" onClick={() => void importByLink()} disabled={!linkInput.trim() || linkImporting}>
          {linkImporting ? "Importing…" : "Import"}
        </button>
      </div>

      {!activities && (
        <button type="button" className="fatox-add" onClick={() => loadActivities(1, false)} disabled={listLoading}>
          {listLoading ? "Loading…" : "Show recent runs"}
        </button>
      )}

      {error && <p className="gpx-upload__error">{error}</p>}

      {activities && (
        <>
          <input
            type="text"
            placeholder="Filter loaded runs by name"
            value={nameFilter}
            onChange={(e) => setNameFilter(e.target.value)}
          />
          <div className="fatox-rows">
            {visibleActivities!.length === 0 && (
              <p className="placeholder">
                {activities.length === 0 ? "No recent runs found on Strava." : "No loaded runs match that filter."}
              </p>
            )}
            {visibleActivities!.map((activity) => (
              <div key={activity.id} className="run-library-row">
                <span className="run-library-row__label">
                  {activity.name} &middot; {activity.distanceKm.toFixed(1)} km &middot;{" "}
                  {(activity.movingTimeS / 3600).toFixed(1)} h &middot; {new Date(activity.date).toLocaleDateString()}
                </span>
                <button
                  type="button"
                  className="fatox-add"
                  onClick={() => void importFromList(activity)}
                  disabled={importingId === String(activity.id)}
                >
                  {importingId === String(activity.id) ? "Importing…" : "Import"}
                </button>
              </div>
            ))}
          </div>
          {hasMore && (
            <button type="button" className="fatox-add" onClick={() => loadActivities(page + 1, true)} disabled={loadingMore}>
              {loadingMore ? "Loading…" : "Load more (further back in time)"}
            </button>
          )}
        </>
      )}
    </div>
  );
}
