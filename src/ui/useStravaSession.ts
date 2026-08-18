import { useEffect, useSyncExternalStore } from "react";

export interface StravaSessionState {
  connected: boolean;
  athleteName: string | null;
  loading: boolean;
  refresh: () => void;
}

interface SessionSnapshot {
  connected: boolean;
  athleteName: string | null;
  loading: boolean;
}

// Module-level shared state, same pattern as autoFetchRuns.ts/backfillRuns.ts/
// runFitBatch.ts -- every consumer (App.tsx, RunLibraryPanel, StravaImport,
// StravaConnectionStatus, the last of which is itself mounted from two
// different places) reads the SAME fetch result instead of each firing its
// own independent /api/strava/session request on its own mount. Before this,
// up to 5 separate components each ran their own fetch simultaneously --
// harmless in production, but under local `vercel dev`'s slower per-request
// lambda emulation, that pile of concurrent duplicate requests queued badly
// enough that the connection status (a link or a name) could take several
// seconds to appear anywhere, even though a single direct fetch resolves
// near-instantly.
let snapshot: SessionSnapshot = { connected: false, athleteName: null, loading: true };
const listeners = new Set<() => void>();
let started = false;

function setSnapshot(next: SessionSnapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}

/** Fails silently (treated as disconnected) when /api doesn't exist at all,
 * e.g. the static Docker/nginx build, which has no serverless runtime. */
function refresh(): void {
  setSnapshot({ ...snapshot, loading: true });
  fetch("/api/strava/session")
    .then((res) => (res.ok ? res.json() : { connected: false }))
    .then((data: { connected: boolean; athleteName?: string }) => {
      setSnapshot({ connected: data.connected, athleteName: data.athleteName ?? null, loading: false });
    })
    .catch(() => {
      setSnapshot({ connected: false, athleteName: null, loading: false });
    });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): SessionSnapshot {
  return snapshot;
}

/** Backs both the import UI and App.tsx's settings-sync effect. */
export function useStravaSession(): StravaSessionState {
  const state = useSyncExternalStore(subscribe, getSnapshot);

  // Only the first-ever mounted consumer actually triggers the fetch --
  // every later mount (including a second Settings-open, or another
  // component reading this same hook) just subscribes to the existing
  // shared result instead of re-fetching.
  useEffect(() => {
    if (started) return;
    started = true;
    refresh();
  }, []);

  return { ...state, refresh };
}
