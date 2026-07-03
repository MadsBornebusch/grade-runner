import { useEffect, useRef, useState } from "react";

/**
 * Measures an element's width via ResizeObserver and returns it alongside a
 * ref to attach. Used instead of Recharts' ResponsiveContainer, which can
 * grab a stale (often 0, or mid-transition) width on first paint inside a
 * CSS grid/flex layout and never re-measure correctly afterward.
 */
export function useContainerWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [ref, width] as const;
}
