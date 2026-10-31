// Imported into the generated service worker (vite.config.ts,
// workbox.importScripts). Shows the day's session when Chrome's periodic
// background sync wakes the worker; the app writes the week's
// notifications to the cache (src/pwa/dailyNotification.ts).
const NOTIFY_CACHE = "grade-runner-notify";
const SCHEDULE_URL = "/__notify/schedule";
const LAST_URL = "/__notify/last";
const SYNC_TAG = "daily-session";
/** Not before 6 am, and not once the evening is here. */
const FIRST_HOUR = 6;
const LAST_HOUR = 21;

const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

async function notifyToday() {
  const now = new Date();
  if (now.getHours() < FIRST_HOUR || now.getHours() >= LAST_HOUR) return;
  const cache = await caches.open(NOTIFY_CACHE);
  const today = localDate(now);
  const last = await cache.match(LAST_URL);
  if (last && (await last.text()) === today) return;
  const res = await cache.match(SCHEDULE_URL);
  if (!res) return;
  const { days } = await res.json();
  const n = days[today];
  if (!n) return;
  await self.registration.showNotification(n.title, {
    body: n.body,
    icon: "/pwa-192x192.png",
    badge: "/notification-badge-96.png",
    tag: SYNC_TAG,
    data: { url: "/#/today" },
  });
  await cache.put(LAST_URL, new Response(today));
}

self.addEventListener("periodicsync", (event) => {
  if (event.tag === SYNC_TAG) event.waitUntil(notifyToday());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url ?? "/#/today", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows[0];
      if (open) return open.focus().then(() => open.navigate(url)).catch(() => {});
      return self.clients.openWindow(url);
    }),
  );
});
