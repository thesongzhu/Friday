type ClientStabilityEventType =
  | "route_transition_start"
  | "route_transition_complete"
  | "api_request"
  | "api_error"
  | "long_task"
  | "unhandled_error"
  | "unhandled_rejection";

interface ClientStabilityEvent {
  id: string;
  at: string;
  type: ClientStabilityEventType;
  payload: Record<string, unknown>;
}

const MAX_EVENTS = 200;
const STORAGE_KEY = "friday.client.stability.export.v1";

const eventBuffer: ClientStabilityEvent[] = [];
let installed = false;
let routeTransition: { target: string; startedAt: number } | null = null;

function nextId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `diag-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function pushEvent(type: ClientStabilityEventType, payload: Record<string, unknown>) {
  const event: ClientStabilityEvent = {
    id: nextId(),
    at: new Date().toISOString(),
    type,
    payload,
  };
  eventBuffer.push(event);
  if (eventBuffer.length > MAX_EVENTS) {
    eventBuffer.shift();
  }
  if (typeof window !== "undefined") {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(eventBuffer));
  }
}

export function recordClientApiEvent(payload: Record<string, unknown>) {
  pushEvent("api_request", payload);
}

export function recordClientApiError(payload: Record<string, unknown>) {
  pushEvent("api_error", payload);
}

export function beginClientRouteTransition(target: string) {
  routeTransition = {
    target,
    startedAt: typeof performance !== "undefined" ? performance.now() : Date.now(),
  };
  pushEvent("route_transition_start", { target });
}

export function completeClientRouteTransition(pathname: string) {
  if (!routeTransition) {
    return;
  }
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  pushEvent("route_transition_complete", {
    target: routeTransition.target,
    settledPathname: pathname,
    durationMs: Math.round(now - routeTransition.startedAt),
  });
  routeTransition = null;
}

export function recordClientRenderError(payload: Record<string, unknown>) {
  pushEvent("unhandled_error", payload);
}

export function getClientStabilityEvents(): ClientStabilityEvent[] {
  return [...eventBuffer];
}

export function installClientStabilityDiagnostics() {
  if (installed || typeof window === "undefined") {
    return;
  }
  installed = true;

  const existing = window.sessionStorage.getItem(STORAGE_KEY);
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as ClientStabilityEvent[];
      eventBuffer.splice(0, eventBuffer.length, ...parsed.slice(-MAX_EVENTS));
    } catch {
      // Ignore stale or malformed session data.
    }
  }

  window.addEventListener("error", (event) => {
    pushEvent("unhandled_error", {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    pushEvent("unhandled_rejection", {
      reason: event.reason instanceof Error ? event.reason.message : String(event.reason),
    });
  });

  if (typeof PerformanceObserver !== "undefined") {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          pushEvent("long_task", {
            name: entry.name,
            durationMs: Math.round(entry.duration),
            startTimeMs: Math.round(entry.startTime),
          });
        }
      });
      observer.observe({ entryTypes: ["longtask"] });
    } catch {
      // Long task observer is optional.
    }
  }
}
