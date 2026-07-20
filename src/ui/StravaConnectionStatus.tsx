import { useStravaSession } from "./useStravaSession";

/**
 * Connect/disconnect link + status line -- shared by StravaImport's own
 * activity browser (Course tab) and SettingsModal's backfill/fit flow, so
 * neither has to own "log in with Strava" as its own concern.
 */
export function StravaConnectionStatus() {
  const { connected, athleteName, loading } = useStravaSession();

  if (loading) return null;

  if (!connected) {
    return (
      <a className="strava-import__connect" href="/api/strava/login">
        Connect Strava
      </a>
    );
  }

  return (
    <div className="strava-import__header">
      <span>Connected to Strava as {athleteName}</span>
      <a href="/api/strava/logout">Disconnect</a>
    </div>
  );
}
