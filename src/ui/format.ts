export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

export function formatPace(speedMs: number): string {
  if (speedMs <= 0) return "--:--";
  const secPerKm = 1000 / speedMs;
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, "0")}/km`;
}

export function formatDistanceKm(meters: number): string {
  return `${(meters / 1000).toFixed(2)} km`;
}

/** Inverse of formatDuration -- accepts "H:MM" or "H:MM:SS". Null for
 * empty/malformed input, so callers can distinguish "no target set" from
 * "user typed something invalid" if they need to. */
export function parseDurationToSeconds(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(":");
  if (parts.length !== 2 && parts.length !== 3) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  const [h, m, s] = parts.length === 2 ? [nums[0], nums[1], 0] : nums;
  return h * 3600 + m * 60 + s;
}
