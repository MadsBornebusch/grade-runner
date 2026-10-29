import { useStravaSession } from "./useStravaSession";

/** Connect button, or who's connected with a way out. */
export function StravaConnectionStatus() {
  const { connected, athleteName, loading, offline } = useStravaSession();

  if (loading) return null;

  if (offline) return <p className="help strava-status__line">You're offline. New runs come in from Strava once you're back online.</p>;

  if (!connected) {
    return (
      <div className="card strava-status">
        <p className="help">Connect Strava so your runs, races and fitness come in on their own.</p>
        <a className="button-primary" href="/api/strava/login">
          Connect Strava
        </a>
      </div>
    );
  }

  return (
    <p className="help strava-status__line">
      Connected to Strava as {athleteName}.
      <a className="link-button" href="/api/strava/logout">
        Disconnect
      </a>
    </p>
  );
}
