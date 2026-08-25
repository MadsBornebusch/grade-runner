import { useEffect, useMemo } from "react";
import { CircleMarker, MapContainer, Polyline, TileLayer, useMap, useMapEvent } from "react-leaflet";
import type { ChartPoint } from "./chartData";
import { formatDuration, formatPace } from "./format";
import "leaflet/dist/leaflet.css";

export interface RoutePoint {
  distanceKm: number;
  lat: number;
  lon: number;
}

interface RouteMapProps {
  routePoints: RoutePoint[];
  /** Same points the charts below are built from (Planning's chartPoints or
   * Analysis's analysisChartPoints) -- lets the highlighted map point show
   * its own split-style stats (pace, elevation, elapsed time, HR) rather
   * than just its location. Indexed by distanceKm, independent of
   * routePoints' own indexing (routePoints has one more entry -- the
   * course's start -- than a segment-derived ChartPoint[] does). */
  splitPoints: ChartPoint[];
  /** Shared with the charts below via App.tsx -- clicking the route here
   * sets it, and each chart renders a ReferenceLine at the same distance. */
  highlightedDistanceKm: number | null;
  onHighlight: (distanceKm: number | null) => void;
  /** Points saved for aid-station planning (App.tsx state) -- rendered as
   * their own markers on the map and fed to SplitTable.tsx to split
   * between them instead of at fixed km intervals. */
  savedPointsKm: number[];
  onSavePoint: (distanceKm: number) => void;
  onRemoveSavedPoint: (distanceKm: number) => void;
  onClearSavedPoints: () => void;
}

/** MapContainer needs an initial center/zoom before any data is known --
 * this fits the view to the route's own bounds right after mount instead,
 * same "render then adjust" split every react-leaflet fit-to-data pattern
 * uses (there's no prop for "fit to these bounds" on MapContainer itself). */
function FitBounds({ positions }: { positions: [number, number][] }) {
  const map = useMap();
  useEffect(() => {
    if (positions.length > 0) map.fitBounds(positions, { padding: [16, 16] });
  }, [map, positions]);
  return null;
}

/** Plain linear scan over routePoints -- called once per click, and even an
 * 80km course at the default 25m segment length is only ~3000 points, so
 * this is instant. Not worth a spatial index for a handful of clicks. */
function nearestPointIndex(points: RoutePoint[], lat: number, lon: number): number {
  let bestIndex = 0;
  let bestDistSq = Infinity;
  for (let i = 0; i < points.length; i++) {
    const dLat = points[i].lat - lat;
    const dLon = points[i].lon - lon;
    const distSq = dLat * dLat + dLon * dLon;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestIndex = i;
    }
  }
  return bestIndex;
}

/** Listens for a click ANYWHERE on the map, not just on the rendered
 * polyline itself -- a thin route line (a few px wide, and often only a
 * fraction of the map's visible area once fit to bounds) is a genuinely
 * hard target to hit exactly, especially on a touch screen. Snapping the
 * nearest routePoint to wherever the user actually clicked is both more
 * forgiving and matches "click the course" as an intent, not a literal
 * pixel-perfect line hit. */
function MapClickHandler({ routePoints, onHighlight }: { routePoints: RoutePoint[]; onHighlight: (distanceKm: number) => void }) {
  useMapEvent("click", (e) => {
    const idx = nearestPointIndex(routePoints, e.latlng.lat, e.latlng.lng);
    onHighlight(routePoints[idx].distanceKm);
  });
  return null;
}

/** Nearest of any distanceKm-tagged point array to a given distanceKm --
 * shared by the map marker (over RoutePoint[]) and the split-stats panel
 * (over ChartPoint[]), which are independently indexed (see splitPoints'
 * own doc) but both monotonic in distanceKm. A linear scan is simpler than
 * a binary search and, same reasoning as nearestPointIndex, cheap enough
 * at this point count. */
function pointAtDistance<T extends { distanceKm: number }>(points: T[], distanceKm: number): T | null {
  if (points.length === 0) return null;
  let best = points[0];
  let bestDiff = Math.abs(best.distanceKm - distanceKm);
  for (const p of points) {
    const diff = Math.abs(p.distanceKm - distanceKm);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = p;
    }
  }
  return best;
}

/** Split-style stats for one clicked point -- same fields SplitTable.tsx
 * reports per km range, just for this single point instead of a range
 * between two of them. HR prefers a real recording over a calibration
 * estimate, same convention as chartData.ts's summarizeChartPoints. */
function SelectedPointStats({ point }: { point: ChartPoint }) {
  const hrBpm = point.recordedHeartRateBpm ?? point.estimatedHeartRateBpm;
  const hrIsEstimated = point.recordedHeartRateBpm === undefined && point.estimatedHeartRateBpm !== null;
  return (
    <p className="field-group-note route-map__point-stats">
      <strong>{point.distanceKm.toFixed(2)} km</strong> · {formatDuration(point.cumulativeTimeS)} elapsed ·{" "}
      {point.speedMs > 0 ? formatPace(point.speedMs) : "stopped"} · {point.elevationM.toFixed(0)}m elevation ·{" "}
      {(point.gradient * 100).toFixed(1)}% grade · {point.mode}
      {hrBpm !== null && hrBpm !== undefined && (
        <>
          {" "}
          · {hrIsEstimated ? "~" : ""}
          {Math.round(hrBpm)}bpm{hrIsEstimated ? " (est.)" : ""}
        </>
      )}
    </p>
  );
}

export function RouteMap({
  routePoints,
  splitPoints,
  highlightedDistanceKm,
  onHighlight,
  savedPointsKm,
  onSavePoint,
  onRemoveSavedPoint,
  onClearSavedPoints,
}: RouteMapProps) {
  const positions = useMemo<[number, number][]>(() => routePoints.map((p): [number, number] => [p.lat, p.lon]), [routePoints]);
  const highlightedPoint = useMemo(
    () => (highlightedDistanceKm !== null ? pointAtDistance(routePoints, highlightedDistanceKm) : null),
    [routePoints, highlightedDistanceKm],
  );
  const highlightedSplitPoint = useMemo(
    () => (highlightedDistanceKm !== null ? pointAtDistance(splitPoints, highlightedDistanceKm) : null),
    [splitPoints, highlightedDistanceKm],
  );
  const savedMapPoints = useMemo(
    () => savedPointsKm.map((km) => ({ km, point: pointAtDistance(routePoints, km) })).filter((p) => p.point !== null),
    [routePoints, savedPointsKm],
  );
  // Already saved (within a point's worth of resolution) -- disables the
  // Save button instead of silently adding a near-duplicate boundary a
  // click away from the one already there.
  const alreadySaved =
    highlightedDistanceKm !== null && savedPointsKm.some((km) => Math.abs(km - highlightedDistanceKm) < 0.001);

  if (positions.length < 2) return null;

  return (
    <div className="chart">
      <div className="chart__header">
        <h3>Route map</h3>
        <div className="route-map__header-actions">
          {highlightedDistanceKm !== null && (
            <>
              <button type="button" className="chart__reset-zoom" onClick={() => onSavePoint(highlightedDistanceKm)} disabled={alreadySaved}>
                {alreadySaved ? "Point saved" : "Save point"}
              </button>
              <button type="button" className="chart__reset-zoom" onClick={() => onHighlight(null)}>
                Clear highlight
              </button>
            </>
          )}
        </div>
      </div>
      <p className="field-group-help">
        Click the map to highlight the nearest point on the route in the charts below. Save points to plan legs between them
        (aid stations) in the split table.
      </p>
      {highlightedSplitPoint && <SelectedPointStats point={highlightedSplitPoint} />}
      {savedPointsKm.length > 0 && (
        <div className="route-map__saved-points">
          {[...savedPointsKm]
            .sort((a, b) => a - b)
            .map((km) => (
              <span key={km} className="route-map__saved-point-chip">
                {km.toFixed(2)} km
                <button type="button" onClick={() => onRemoveSavedPoint(km)} aria-label={`Remove saved point at ${km.toFixed(2)} km`}>
                  ×
                </button>
              </span>
            ))}
          <button type="button" className="chart__reset-zoom" onClick={onClearSavedPoints}>
            Clear saved points
          </button>
        </div>
      )}
      <div className="route-map__canvas">
        <MapContainer center={positions[0]} zoom={13} scrollWheelZoom={true} style={{ height: "100%", width: "100%" }}>
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <FitBounds positions={positions} />
          <MapClickHandler routePoints={routePoints} onHighlight={onHighlight} />
          <Polyline positions={positions} pathOptions={{ color: "var(--accent)", weight: 4 }} />
          {savedMapPoints.map(({ km, point }) => (
            <CircleMarker
              key={km}
              center={[point!.lat, point!.lon]}
              radius={6}
              pathOptions={{ color: "#2d6a4f", fillColor: "#2d6a4f", fillOpacity: 1, weight: 2 }}
            />
          ))}
          {highlightedPoint && (
            <CircleMarker
              center={[highlightedPoint.lat, highlightedPoint.lon]}
              radius={8}
              pathOptions={{ color: "#e05252", fillColor: "#e05252", fillOpacity: 1, weight: 2 }}
            />
          )}
        </MapContainer>
      </div>
    </div>
  );
}
