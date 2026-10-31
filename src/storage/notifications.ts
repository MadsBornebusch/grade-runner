// Whether the morning notification is on (Settings). The schedule itself
// is written for the service worker by src/pwa/dailyNotification.ts.
import { createLocalStore } from "./localStore";

export const notificationsStore = createLocalStore<{ version: 1; dailyEnabled: boolean }>("grade-runner.notifications.v1", {
  version: 1,
  dailyEnabled: false,
});
