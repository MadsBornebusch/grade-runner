// The morning notification, on the device only: the app writes the coming
// week's notifications to a cache the service worker can read
// (public/notify-sw.js), and Chrome's periodic background sync wakes the
// worker about once a day to show today's. Chrome decides when, from how
// much the app is used, so the time isn't fixed; the worker holds it
// before 6 am. Needs the app installed (Chrome only grants periodic sync
// to installed apps).
import type { DayNotification } from "../ui/plan/notificationText";

export const NOTIFY_CACHE = "grade-runner-notify";
export const SCHEDULE_URL = "/__notify/schedule";
export const SYNC_TAG = "daily-session";
/** Chrome rounds this up to its own minimum (about 12 h). */
const MIN_INTERVAL_MS = 4 * 60 * 60 * 1000;

interface PeriodicSyncManager {
  register(tag: string, options?: { minInterval: number }): Promise<void>;
  unregister(tag: string): Promise<void>;
  getTags(): Promise<string[]>;
}
type SyncRegistration = ServiceWorkerRegistration & { periodicSync?: PeriodicSyncManager };

async function registration(): Promise<SyncRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  return ((await navigator.serviceWorker.getRegistration()) as SyncRegistration | undefined) ?? null;
}

export type EnableResult = "ok" | "unsupported" | "denied" | "notInstalled";

export async function enableDaily(): Promise<EnableResult> {
  if (typeof Notification === "undefined") return "unsupported";
  const reg = await registration();
  if (!reg?.periodicSync) return "unsupported";
  if ((await Notification.requestPermission()) !== "granted") return "denied";
  const sync = await navigator.permissions.query({ name: "periodic-background-sync" as PermissionName }).catch(() => null);
  if (sync?.state !== "granted") return "notInstalled";
  await reg.periodicSync.register(SYNC_TAG, { minInterval: MIN_INTERVAL_MS });
  return "ok";
}

export async function disableDaily(): Promise<void> {
  const reg = await registration();
  await reg?.periodicSync?.unregister(SYNC_TAG).catch(() => {});
  await caches.delete(NOTIFY_CACHE).catch(() => {});
}

/** Re-registers on start in case the browser dropped it (cleared data,
 * reinstall); quietly does nothing without the permissions. */
export async function ensureRegistered(): Promise<void> {
  const reg = await registration();
  if (!reg?.periodicSync || typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const tags = await reg.periodicSync.getTags().catch(() => [] as string[]);
  if (!tags.includes(SYNC_TAG)) await reg.periodicSync.register(SYNC_TAG, { minInterval: MIN_INTERVAL_MS }).catch(() => {});
}

export async function writeSchedule(days: Record<string, DayNotification>): Promise<void> {
  if (typeof caches === "undefined") return;
  const cache = await caches.open(NOTIFY_CACHE);
  await cache.put(SCHEDULE_URL, new Response(JSON.stringify({ days }), { headers: { "Content-Type": "application/json" } }));
}

/** Shows the next planned day's notification now, so the athlete can see
 * what it looks like. False when nothing is planned in the coming week. */
export async function showNext(): Promise<boolean> {
  const reg = await registration();
  const cache = await caches.open(NOTIFY_CACHE);
  const res = await cache.match(SCHEDULE_URL);
  if (!reg || !res) return false;
  const { days } = (await res.json()) as { days: Record<string, DayNotification> };
  const first = Object.keys(days).sort()[0];
  if (!first) return false;
  await reg.showNotification(days[first].title, {
    body: days[first].body,
    icon: "/pwa-192x192.png",
    badge: "/notification-badge-96.png",
    tag: SYNC_TAG,
    data: { url: "/#/today" },
  });
  return true;
}
