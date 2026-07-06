import { useState } from "react";

interface DomainPoint {
  distanceKm: number;
}

/**
 * Drives a Brush-based zoom: the Brush reports a start/end index into a
 * reference data array, which we convert to an explicit km domain. Using a
 * domain (rather than relying on Brush's own index-slicing of the chart's
 * top-level `data`) also works for charts whose Lines each pass their own
 * `data` override (see CourseDebugChart), since an axis domain applies to
 * every series sharing that axis regardless of how each got its data.
 */
export function useDomainZoom(referenceData: DomainPoint[]) {
  const [range, setRange] = useState<{ startIndex: number; endIndex: number } | null>(null);
  const lastIndex = Math.max(referenceData.length - 1, 0);
  const startIndex = range ? Math.min(range.startIndex, lastIndex) : 0;
  const endIndex = range ? Math.min(range.endIndex, lastIndex) : lastIndex;
  const isZoomed = range !== null && (startIndex > 0 || endIndex < lastIndex);
  const domain: [number, number] | undefined = isZoomed
    ? [referenceData[startIndex]?.distanceKm ?? 0, referenceData[endIndex]?.distanceKm ?? 0]
    : undefined;

  return {
    startIndex,
    endIndex,
    isZoomed,
    domain,
    onBrushChange: (next: { startIndex?: number; endIndex?: number }) => {
      if (next.startIndex == null || next.endIndex == null) return;
      setRange({ startIndex: next.startIndex, endIndex: next.endIndex });
    },
    reset: () => setRange(null),
  };
}
