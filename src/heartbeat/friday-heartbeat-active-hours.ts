import type { FridayHeartbeatActiveHours } from "./friday-heartbeat.types.js";

export function isFridayHeartbeatWithinActiveHours(
  nowIso: string,
  activeHours?: FridayHeartbeatActiveHours,
): boolean {
  if (!activeHours || !activeHours.enabled) {
    return true;
  }

  const startHour = normalizeHour(activeHours.startHour);
  const endHour = normalizeHour(activeHours.endHour);
  if (startHour === endHour) {
    return true;
  }

  const currentHour = getHour(nowIso, activeHours.timezone);

  if (startHour < endHour) {
    return currentHour >= startHour && currentHour < endHour;
  }

  // Overnight window, e.g. 22 -> 6
  return currentHour >= startHour || currentHour < endHour;
}

function normalizeHour(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const floored = Math.floor(value);
  const wrapped = ((floored % 24) + 24) % 24;
  return wrapped;
}

function getHour(nowIso: string, timezone?: string): number {
  const date = new Date(nowIso);
  if (!timezone) {
    return date.getHours();
  }

  try {
    const formatted = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: timezone,
    }).format(date);
    const parsed = Number(formatted);
    if (!Number.isNaN(parsed)) {
      return parsed % 24;
    }
  } catch {
    // Invalid timezone fallback to local hour.
  }
  return date.getHours();
}

