import { useCallback, useState } from "react";
import type { GpxPoint } from "../gpx/pipeline";
import { fetchStravaActivity } from "./stravaClient";
import { useStravaSession } from "./useStravaSession";

interface StravaActivitySummary {
  id: number;
  name: string;
  date: string;
  distanceKm: number;
  movingTimeS: number;
}

interface StravaImportProps {
  onImport: (points: GpxPoint[], name: string, stravaId?: number) => void;
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

/** Unix seconds for the start of the day *after* a "YYYY-MM-DD" date input
 * -- Strava's `before` filter is exclusive, so this is what makes the
 * chosen day itself show up in the results, not just days strictly earlier. */
function endOfDayEpoch(dateInput: string): number {
  return Math.floor(new Date(`${dateInput}T00:00:00`).getTime() / 1000) + 24 * 60 * 60;
}

export function StravaImport({ onImport }: StravaImportProps) {
  const { connected, loading } = useStravaSession();
  const [activities, setActivities] = useState<StravaActivitySummary[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [beforeAnchor, setBeforeAnchor] = useState<number | null>(null);
  const [dateInput, setDateInput] = useState("");
  const [listLoading, setListLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nameFilter, setNameFilter] = useState("");
  const [minKm, setMinKm] = useState("");
  const [linkInput, setLinkInput] = useState("");
  const [linkImporting, setLinkImporting] = useState(false);
  const [importingId, setImportingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadActivities = useCallback(async (pageToLoad: number, append: boolean, before: number | null) => {
    if (append) setLoadingMore(true);
    else setListLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(pageToLoad) });
      if (before !== null) params.set("before", String(before));
      const res = await fetch(`/api/strava/activities?${params}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to load activities.");
      setActivities((prev) => (append ? [...(prev ?? []), ...body.runs] : body.runs));
      setHasMore(body.hasMore);
      setPage(pageToLoad);
      setBeforeAnchor(before);
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
        const { name, points } = await fetchStravaActivity(Number(id));
        onImport(points, name ?? fallbackName, Number(id));
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
      <p className="help">
        <a className="link-button" href="/api/strava/login">
          Connect Strava
        </a>{" "}
        to pick one of your runs or races.
      </p>
    );
  }

  const visibleActivities =
    activities?.filter((a) => {
      if (!a.name.toLowerCase().includes(nameFilter.toLowerCase())) return false;
      if (minKm && a.distanceKm < Number(minKm)) return false;
      return true;
    }) ?? null;

  return (
    <div className="strava-import">
      <div className="strava-import__row">
        <input
          type="text"
          className="field-input"
          placeholder="Paste a Strava activity link"
          aria-label="Strava activity link or ID"
          value={linkInput}
          onChange={(e) => setLinkInput(e.target.value)}
        />
        <button
          type="button"
          className="button-ghost button-small"
          onClick={() => void importByLink()}
          disabled={!linkInput.trim() || linkImporting}
        >
          {linkImporting ? "Importing…" : "Import"}
        </button>
      </div>

      <div className="strava-import__row">
        <button
          type="button"
          className="button-ghost button-small"
          onClick={() => {
            setDateInput("");
            void loadActivities(1, false, null);
          }}
          disabled={listLoading}
        >
          {listLoading ? "Loading…" : "Show recent runs"}
        </button>
        <label className="strava-import__date">
          <span>or up to</span>
          <input
            type="date"
            className="field-input"
            value={dateInput}
            onChange={(e) => {
              setDateInput(e.target.value);
              if (e.target.value) void loadActivities(1, false, endOfDayEpoch(e.target.value));
            }}
          />
        </label>
      </div>

      {error && <p className="help danger">{error}</p>}

      {activities && (
        <>
          <div className="strava-import__row">
            <input
              type="text"
              className="field-input"
              placeholder="Filter by name"
              aria-label="Filter by name"
              value={nameFilter}
              onChange={(e) => setNameFilter(e.target.value)}
            />
            <label className="input-unit">
              <input
                type="number"
                className="field-input strava-import__km"
                min={0}
                placeholder="min"
                aria-label="Shortest distance, km"
                value={minKm}
                onChange={(e) => setMinKm(e.target.value)}
              />
              km
            </label>
          </div>
          <div className="list strava-import__list">
            {visibleActivities!.length === 0 && (
              <p className="help">
                {activities.length === 0 ? "No runs on Strava in this range." : "None of these runs match."}
              </p>
            )}
            {visibleActivities!.map((activity) => (
              <div key={activity.id} className="list-row">
                <span className="strava-import__run">
                  <span>{activity.name}</span>
                  <span className="muted num">
                    {new Date(activity.date).toLocaleDateString()} · {activity.distanceKm.toFixed(1)} km ·{" "}
                    {(activity.movingTimeS / 3600).toFixed(1)} h
                  </span>
                </span>
                <button
                  type="button"
                  className="button-ghost button-small"
                  onClick={() => void importFromList(activity)}
                  disabled={importingId === String(activity.id)}
                >
                  {importingId === String(activity.id) ? "Importing…" : "Import"}
                </button>
              </div>
            ))}
          </div>
          {hasMore && (
            <button
              type="button"
              className="button-ghost button-small"
              onClick={() => void loadActivities(page + 1, true, beforeAnchor)}
              disabled={loadingMore}
            >
              {loadingMore ? "Loading…" : "Load older runs"}
            </button>
          )}
        </>
      )}
    </div>
  );
}
