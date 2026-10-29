// Registers the service worker and offers a new version once it's
// downloaded. Rendered from main.tsx, outside App, so nothing under test
// imports the virtual module.
import { useEffect } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";

/** An installed app resumed from the background never navigates (routing
 * is by hash), so updates are also looked for when it's shown again and
 * every hour it stays open. */
const CHECK_EVERY_MS = 60 * 60 * 1000;

export function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      if (!registration) return;
      const check = () => {
        if (navigator.onLine) registration.update().catch(() => {});
      };
      setInterval(check, CHECK_EVERY_MS);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") check();
      });
    },
  });

  // Everything entered lives in this origin's storage: ask the browser not
  // to evict it under storage pressure. Installed apps are usually granted.
  useEffect(() => {
    navigator.storage?.persist?.().catch(() => {});
  }, []);

  if (!needRefresh) return null;
  return (
    <div className="update-prompt" role="status">
      <span>A new version is ready</span>
      <button type="button" className="button-primary button-small" onClick={() => updateServiceWorker()}>
        Reload
      </button>
      <button type="button" className="button-ghost button-small" onClick={() => setNeedRefresh(false)}>
        Later
      </button>
    </div>
  );
}
