import type {
  FridaySystemApprovalRule,
  FridaySystemEvent,
  FridaySystemHealth,
  FridaySystemIntentAction,
  FridaySystemRemoteDevice,
} from "@/lib/api/system-types";

const APPROVAL_ACTIONS: Array<{
  action: FridaySystemIntentAction;
  label: string;
  summary: string;
}> = [
  {
    action: "clipboard_read",
    label: "Clipboard Read",
    summary: "Allows Friday to inspect clipboard contents.",
  },
  {
    action: "close_app",
    label: "Close App",
    summary: "Allows Friday to close applications from the operator console.",
  },
  {
    action: "notification_act",
    label: "Notification Actions",
    summary: "Allows Friday to open, dismiss, or mark notifications as read through the companion.",
  },
];

export interface ApprovalActionCard {
  action: FridaySystemIntentAction;
  label: string;
  summary: string;
  decision: "allow" | "deny" | "prompt" | "missing";
  ruleId?: string;
  updatedAt?: string;
}

export interface TimelineItem {
  id: string;
  title: string;
  tone: "neutral" | "success" | "warning" | "danger";
  timestamp: string;
  detail?: string;
}

export interface RemoteDevicePasskeySummary {
  label: string;
  tone: "neutral" | "success" | "warning";
  detail: string;
}

export function buildApprovalActionCards(
  approvals: FridaySystemApprovalRule[],
): ApprovalActionCard[] {
  return APPROVAL_ACTIONS.map((item) => {
    const rule = approvals.find((approval) => approval.action === item.action);
    return {
      action: item.action,
      label: item.label,
      summary: item.summary,
      decision: rule?.decision ?? "missing",
      ruleId: rule?.id,
      updatedAt: rule?.updatedAt,
    };
  });
}

export function summarizeHealthReasons(health: FridaySystemHealth): string {
  if (health.safeMode) {
    return "Safe mode is active. Input automation is paused until the operator recovers the UI.";
  }
  if (health.reasons.length === 0) {
    return "All local system surfaces required by the current session are connected.";
  }
  return health.reasons
    .map((reason) => reason.replace(/_/g, " ").replace(/:/g, " - "))
    .join(", ");
}

export function buildSystemTimelineItems(events: FridaySystemEvent[]): TimelineItem[] {
  return events.slice(-12).reverse().map((event) => {
    if (event.event === "system.intent.failed") {
      return {
        id: event.id,
        title: "Intent failed",
        tone: "danger",
        timestamp: event.emittedAt,
        detail: typeof event.payload.message === "string" ? event.payload.message : undefined,
      };
    }

    if (event.event === "system.intent.blocked") {
      return {
        id: event.id,
        title: "Intent blocked",
        tone: "warning",
        timestamp: event.emittedAt,
        detail: typeof event.payload.message === "string"
          ? event.payload.message
          : typeof event.payload.reason === "string"
            ? event.payload.reason
            : undefined,
      };
    }

    if (event.event === "system.health.updated") {
      const status = typeof (event.payload.health as Record<string, unknown> | undefined)?.status === "string"
        ? String((event.payload.health as Record<string, unknown>).status)
        : "unknown";
      return {
        id: event.id,
        title: `Health changed to ${status}`,
        tone: status === "healthy" ? "success" : status === "safe_mode" ? "warning" : "neutral",
        timestamp: event.emittedAt,
      };
    }

    if (event.event === "system.companion.connected" || event.event === "system.companion.disconnected") {
      return {
        id: event.id,
        title: event.event === "system.companion.connected" ? "Companion connected" : "Companion disconnected",
        tone: event.event === "system.companion.connected" ? "success" : "warning",
        timestamp: event.emittedAt,
      };
    }

    if (event.event === "system.companion.heartbeat_stale") {
      return {
        id: event.id,
        title: "Companion heartbeat stale",
        tone: "warning",
        timestamp: event.emittedAt,
      };
    }

    if (event.event === "system.companion.permissions_changed") {
      return {
        id: event.id,
        title: "Companion permissions changed",
        tone: "neutral",
        timestamp: event.emittedAt,
      };
    }

    return {
      id: event.id,
      title: event.event.replace(/^system\./, "").replace(/\./g, " "),
      tone: "neutral",
      timestamp: event.emittedAt,
      detail: typeof event.payload.action === "string" ? String(event.payload.action) : undefined,
    };
  });
}

export function buildRemoteDevicePasskeySummary(
  device: FridaySystemRemoteDevice,
): RemoteDevicePasskeySummary {
  if (!device.credentialId) {
    return {
      label: "Missing",
      tone: "warning",
      detail: "No passkey is enrolled for this trusted device yet.",
    };
  }

  const profile = device.passkeyDeviceType === "multiDevice"
    ? "Multi-device passkey"
    : device.passkeyDeviceType === "singleDevice"
      ? "Single-device passkey"
      : "Passkey enrolled";
  const backup = device.passkeyBackedUp === true
    ? "backed up"
    : device.passkeyBackedUp === false
      ? "not backed up"
      : "backup state unknown";

  return {
    label: "Enrolled",
    tone: "success",
    detail: `${profile} · ${backup}`,
  };
}
