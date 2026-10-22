import { useCallback, useSyncExternalStore } from "react";

// Hash routes (#/today, #/schedule/2026-11-02, #/race/pacing, #/runs, #/settings),
// so the browser's back button works and a refresh keeps the place. No
// router library: the hash is the whole state.

export type TabId = "today" | "schedule" | "race" | "runs" | "settings";
export const TAB_IDS: TabId[] = ["today", "schedule", "race", "runs", "settings"];

export interface HashRoute {
  tab: TabId;
  /** Path segments after the tab, e.g. ["pacing"] for #/race/pacing. */
  rest: string[];
}

export function parseHash(hash: string, defaultTab: TabId): HashRoute {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const tab = TAB_IDS.find((t) => t === parts[0]);
  return tab ? { tab, rest: parts.slice(1) } : { tab: defaultTab, rest: [] };
}

export const hashFor = (tab: TabId, ...rest: string[]) => `#/${[tab, ...rest].map(encodeURIComponent).join("/")}`;

function subscribe(listener: () => void) {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}
const getHash = () => window.location.hash;

export function useHashRoute(defaultTab: TabId): HashRoute & { navigate: (tab: TabId, ...rest: string[]) => void } {
  const hash = useSyncExternalStore(subscribe, getHash);
  const navigate = useCallback((tab: TabId, ...rest: string[]) => {
    const next = hashFor(tab, ...rest);
    if (window.location.hash !== next) window.location.hash = next;
  }, []);
  return { ...parseHash(hash, defaultTab), navigate };
}
