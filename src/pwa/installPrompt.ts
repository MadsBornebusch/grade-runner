// Chrome's install offer (Android and desktop). The event can fire before
// React mounts, so it's caught here at module load (main.tsx imports this
// first) and kept for the Settings row to use. Safari has no such event:
// there it's Share › Add to Home Screen.
import { useSyncExternalStore } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    notify();
  });
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Whether the browser will show its install dialog, and a call that shows
 * it. Null once installed, or where the browser doesn't offer it. */
export function useInstallPrompt(): (() => Promise<void>) | null {
  const event = useSyncExternalStore(subscribe, () => deferred, () => null);
  if (!event) return null;
  return async () => {
    await event.prompt();
    await event.userChoice;
    deferred = null;
    notify();
  };
}
