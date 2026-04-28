import { describe, expect, it } from "vitest";
import {
  buildApprovalActionCards,
  buildRemoteDevicePasskeySummary,
  buildSystemTimelineItems,
  summarizeHealthReasons,
} from "../../../ui/src/lib/system/view-models";
import type {
  FridaySystemApprovalRule,
  FridaySystemEvent,
  FridaySystemHealth,
  FridaySystemRemoteDevice,
} from "@friday-operator-client";

describe("system view models", () => {
  it("builds approval cards for the core risk gates", () => {
    const approvals: FridaySystemApprovalRule[] = [
      {
        id: "approval-1",
        action: "clipboard_read",
        riskLevel: "high",
        decision: "allow",
        createdAt: "2026-03-06T12:00:00.000Z",
        updatedAt: "2026-03-06T12:05:00.000Z",
      },
    ];

    const cards = buildApprovalActionCards(approvals);

    expect(cards).toHaveLength(3);
    expect(cards.find((card) => card.action === "clipboard_read")?.decision).toBe("allow");
    expect(cards.find((card) => card.action === "close_app")?.decision).toBe("prompt");
  });

  it("summarizes safe mode and degraded health clearly", () => {
    const safeMode: FridaySystemHealth = {
      status: "safe_mode",
      safeMode: true,
      desktopConnected: false,
      companionConnected: false,
      reasons: ["desktop_session_unavailable"],
      updatedAt: "2026-03-06T12:10:00.000Z",
    };

    const degraded: FridaySystemHealth = {
      status: "degraded",
      safeMode: false,
      desktopConnected: true,
      companionConnected: false,
      reasons: ["companion_disconnected", "permission_pending:screen_recording"],
      updatedAt: "2026-03-06T12:10:00.000Z",
    };

    expect(summarizeHealthReasons(safeMode)).toContain("Safe mode");
    expect(summarizeHealthReasons(degraded)).toContain("companion disconnected");
  });

  it("maps blocked and failed events into timeline entries", () => {
    const events: FridaySystemEvent[] = [
      {
        id: "event-1",
        seq: 1,
        event: "system.intent.blocked",
        emittedAt: "2026-03-06T12:00:00.000Z",
        payload: { message: "Approval required for clipboard_read" },
      },
      {
        id: "event-2",
        seq: 2,
        event: "system.intent.failed",
        emittedAt: "2026-03-06T12:01:00.000Z",
        payload: { message: "Desktop session is not connected" },
      },
    ];

    const items = buildSystemTimelineItems(events);

    expect(items[0]?.tone).toBe("danger");
    expect(items[0]?.title).toBe("Intent failed");
    expect(items[1]?.tone).toBe("warning");
    expect(items[1]?.detail).toContain("Approval required");
  });

  it("summarizes remote-device passkey state for the operator console", () => {
    const missing: FridaySystemRemoteDevice = {
      id: "device-1",
      label: "Studio Mac",
      fingerprint: "fp-1",
      platform: "browser",
      trustScope: "trusted_private_network",
      status: "active",
      registeredAt: "2026-03-06T12:00:00.000Z",
    };
    const enrolled: FridaySystemRemoteDevice = {
      ...missing,
      id: "device-2",
      credentialId: "cred-1",
      passkeyDeviceType: "multiDevice",
      passkeyBackedUp: true,
    };

    expect(buildRemoteDevicePasskeySummary(missing)).toMatchObject({
      label: "Missing",
      tone: "warning",
    });
    expect(buildRemoteDevicePasskeySummary(enrolled)).toMatchObject({
      label: "Enrolled",
      tone: "success",
      detail: "Multi-device passkey · backed up",
    });
  });
});
