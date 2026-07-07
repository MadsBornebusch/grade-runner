import { useCallback, useEffect, useState } from "react";

export interface StravaSessionState {
  connected: boolean;
  athleteName: string | null;
  loading: boolean;
  refresh: () => void;
}

/** Backs both the import UI and App.tsx's settings-sync effect. Fails
 * silently (treated as disconnected) when /api doesn't exist at all, e.g.
 * the static Docker/nginx build, which has no serverless runtime. */
export function useStravaSession(): StravaSessionState {
  const [connected, setConnected] = useState(false);
  const [athleteName, setAthleteName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);
    fetch("/api/strava/session")
      .then((res) => (res.ok ? res.json() : { connected: false }))
      .then((data: { connected: boolean; athleteName?: string }) => {
        setConnected(data.connected);
        setAthleteName(data.athleteName ?? null);
      })
      .catch(() => {
        setConnected(false);
        setAthleteName(null);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { connected, athleteName, loading, refresh };
}
