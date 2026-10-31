import { useState } from "react";
import { notificationsStore } from "../storage/notifications";
import { disableDaily, enableDaily, showNext, type EnableResult } from "./dailyNotification";

const WHY_NOT: Record<Exclude<EnableResult, "ok">, string> = {
  unsupported: "This browser can't notify on its own. It works in Chrome on Android with the app installed.",
  denied: "Notifications are blocked for Grade Runner. Allow them in the site or app settings, then try again.",
  notInstalled: "Install the app first (Install app above, or Chrome's menu), then turn this on from the installed app.",
};

/** Settings › Notifications: the morning notification with the day's
 * session. */
export function NotificationSettings() {
  const { dailyEnabled } = notificationsStore.use();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const toggle = async (on: boolean) => {
    setBusy(true);
    setNote(null);
    try {
      if (on) {
        const result = await enableDaily();
        if (result === "ok") notificationsStore.set((s) => ({ ...s, dailyEnabled: true }));
        else setNote(WHY_NOT[result]);
      } else {
        await disableDaily();
        notificationsStore.set((s) => ({ ...s, dailyEnabled: false }));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h3 className="section-title">Notifications</h3>
      <div className="card">
        <label className="switch-row">
          <input type="checkbox" checked={dailyEnabled} disabled={busy} onChange={(e) => toggle(e.target.checked)} />
          <span>Notify me of the day's session</span>
        </label>
        <p className="help">
          Android decides when to wake the app: about once a day, and more reliably the more you use it. So it can come any time between 6 am and 9 pm, and some days not at all. Rest days stay quiet, and so does a day whose run the app has already synced.
        </p>
        {note && <p className="help">{note}</p>}
        {dailyEnabled && (
          <div className="sheet__actions">
            <button
              type="button"
              className="button-ghost button-small"
              onClick={async () => setNote((await showNext().catch(() => false)) ? null : "Nothing planned in the coming week.")}
            >
              Show the next one now
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
