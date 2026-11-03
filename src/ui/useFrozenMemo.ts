import { useRef } from "react";

/**
 * useMemo that holds its last value while `frozen` (another tab is
 * showing, so nothing would show a fresh build), and keeps it when the tab
 * shows again with the same deps: a new reference there would re-run every
 * memo downstream of it for nothing. `whileFrozen` is the value before the
 * first build, if the tab starts hidden.
 */
export function useFrozenMemo<T>(build: () => T, deps: readonly unknown[], frozen: boolean, whileFrozen: T): T {
  const last = useRef<{ deps: readonly unknown[]; value: T } | null>(null);
  const prev = last.current;
  if (frozen) return prev ? prev.value : whileFrozen;
  if (prev && prev.deps.length === deps.length && prev.deps.every((d, i) => Object.is(d, deps[i]))) return prev.value;
  const value = build();
  last.current = { deps, value };
  return value;
}
