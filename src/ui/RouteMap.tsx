import { useEffect, useMemo } from "react";
import { CircleMarker, MapContainer, Polyline, TileLayer, useMap, useMapEvent } from "react-leaflet";
import "leaflet/dist/leaflet.css";

export interface RoutePoint {
  distanceKm: number;
  lat: number;
  lon: number;
}

interface RouteMapProps {
  routePoints: RoutePoint[];
  /** Shared with the charts below via App.tsx -- clicking the route here
   * sets it, and each chart renders a ReferenceLine at the same distance. */
  highlightedDistanceKm: number | null;
  onHighlight: (distanceKm: number | null) => void;
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

/** Nearest routePoint to a given distanceKm -- routePoints is monotonic in
 * distanceKm, but a linear scan is simpler than a binary search and, same
 * reasoning as nearestPointIndex, cheap enough at this point count. */
function pointAtDistance(points: RoutePoint[], distanceKm: number): RoutePoint | null {
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

export function RouteMap({ routePoints, highlightedDistanceKm, onHighlight }: RouteMapProps) {
  const positions = useMemo<[number, number][]>(() => routePoints.map((p): [number, number] => [p.lat, p.lon]), [routePoints]);
  const highlightedPoint = useMemo(
    () => (highlightedDistanceKm !== null ? pointAtDistance(routePoints, highlightedDistanceKm) : null),
    [routePoints, highlightedDistanceKm],
  );

  if (positions.length < 2) return null;

  return (
    <div className="chart">
      <div className="chart__header">
        <h3>Route map</h3>
        {highlightedDistanceKm !== null && (
          <button type="button" className="chart__reset-zoom" onClick={() => onHighlight(null)}>
            Clear highlight
          </button>
        )}
      </div>
      <p className="field-group-help">Click the map to highlight the nearest point on the route in the charts below.</p>
      <div className="route-map__canvas">
        <MapContainer center={positions[0]} zoom={13} scrollWheelZoom={true} style={{ height: "100%", width: "100%" }}>
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <FitBounds positions={positions} />
          <MapClickHandler routePoints={routePoints} onHighlight={onHighlight} />
          <Polyline positions={positions} pathOptions={{ color: "var(--accent)", weight: 4 }} />
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
