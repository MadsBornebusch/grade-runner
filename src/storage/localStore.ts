import { useSyncExternalStore } from "react";

// A small JSON value in localStorage with subscribers, for the plan's
// browser-only state (plan settings, the plan snapshot, check-ins, fuel
// logs). Reads merge the stored value over the defaults, so a field added
// later gets its default; any storage error falls back to the defaults
// (private windows, blocked storage) and the app keeps working in memory.

export interface LocalStore<T> {
  get(): T;
  set(update: T | ((prev: T) => T)): void;
  subscribe(listener: () => void): () => void;
  /** React hook: the current value, re-rendering on every set. */
  use(): T;
}

export function createLocalStore<T extends object>(key: string, defaults: T, normalize: (raw: T) => T = (x) => x): LocalStore<T> {
  let value: T | null = null;
  const listeners = new Set<() => void>();
  const read = (): T => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? normalize({ ...defaults, ...JSON.parse(raw) }) : defaults;
    } catch {
      return defaults;
    }
  };
  const get = () => (value ??= read());
  const set = (update: T | ((prev: T) => T)) => {
    value = typeof update === "function" ? (update as (prev: T) => T)(get()) : update;
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Kept in memory for this session.
    }
    listeners.forEach((l) => l());
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  return { get, set, subscribe, use: () => useSyncExternalStore(subscribe, get) };
}
