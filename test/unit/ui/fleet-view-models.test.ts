import { describe, expect, it } from "vitest";
import {
  buildFleetHref,
  buildFleetRecoverySteps,
  buildFleetRuntimeRecoveryCard,
  formatFleetHeartbeatAge,
  formatFleetTimestamp,
  toneForFleetHealth,
  toneForFleetPairing,
  toneForFleetTrust,
} from "../../../ui/src/lib/fleet/view-models";

describe("fleet view models", () => {
  it("formats fleet timestamps and heartbeat ages for operators", () => {
    expect(formatFleetTimestamp()).toBe("Unknown");
    expect(formatFleetHeartbeatAge()).toBe("No heartbeat");
    expect(formatFleetHeartbeatAge(250)).toBe("250 ms ago");
    expect(formatFleetHeartbeatAge(5_500)).toBe("6 s ago");
    expect(formatFleetHeartbeatAge(180_000)).toBe("3 min ago");
  });

  it("maps health, trust, and pairing status to stable tones", () => {
    expect(toneForFleetHealth("healthy")).toBe("success");
    expect(toneForFleetHealth("degraded")).toBe("warning");
    expect(toneForFleetHealth("critical")).toBe("danger");

    expect(toneForFleetTrust("trusted")).toBe("success");
    expect(toneForFleetTrust("restricted")).toBe("warning");
    expect(toneForFleetTrust("revoked")).toBe("danger");

    expect(toneForFleetPairing("online")).toBe("success");
    expect(toneForFleetPairing("degraded")).toBe("warning");
    expect(toneForFleetPairing("offline")).toBe("danger");
  });

  it("builds a click-first recovery ladder for degraded nodes", () => {
    const steps = buildFleetRecoverySteps({
      satellite: {
        satelliteId: "sat-1",
        type: "macos",
        displayName: "Build Node",
        pairingStatus: "offline",
        trustLevel: "trusted",
        trustScore: 82,
        trustBand: "medium",
        healthScore: 41,
        healthState: "degraded",
        lastSeenAt: "2026-03-08T09:30:00.000Z",
        heartbeatAgeMs: 180_000,
        queueDepth: 4,
        activeRuns: 1,
        tags: [],
        alerts: [],
      },
      capabilities: [],
      queue: {
        queued: 1,
        leased: 0,
        failed: 2,
        deadLetter: 1,
      },
      workflowLoad: {
        queuedNodes: 0,
        runningNodes: 1,
        retryingNodes: 1,
        blockedOfflineNodes: 2,
      },
      trustBreakdown: {
        identityScore: 80,
        statusScore: 75,
        hygieneScore: 70,
        incidentPenalty: 5,
        finalScore: 82,
        band: "medium",
        reasons: ["Trusted certificate present"],
      },
      healthBreakdown: {
        heartbeatScore: 20,
        resourceScore: 70,
        queueScore: 35,
        reliabilityScore: 40,
        finalScore: 41,
        state: "degraded",
      },
      runtimeRecovery: {
        state: "degraded",
        continuationMode: "already_dispatched_only",
        offlinePlanningMode: "deferred",
        summary: "Friday can continue already-dispatched work, but new offline planning stays deferred until trust and heartbeat recover.",
        reasons: ["No recent heartbeat has been recorded.", "Blocked workflow work is waiting on this node."],
        queueRecoveryState: "retrying",
        syncRecoveryState: "recovering",
        requiresOperatorIntervention: true,
        autoRetryActive: true,
        nextOperatorAction: "restore_heartbeat",
      },
      remediation: {
        status: "blocked",
        requiresApproval: true,
        actions: [
          {
            id: "restore_heartbeat",
            title: "Restore heartbeat and runtime health",
            summary: "Ask Friday to re-establish the node heartbeat before you resume work.",
            reason: "No recent heartbeat has been recorded for this node.",
            status: "blocked",
            riskClass: "safe_probe",
            requiresApproval: false,
            tone: "warning",
          },
          {
            id: "requeue_expired_leases",
            title: "Requeue expired work leases",
            summary: "Return failed fleet work to the shared queue.",
            reason: "Failed or dead-letter backlog exists for this satellite.",
            status: "ready",
            riskClass: "bounded_repair",
            requiresApproval: false,
            tone: "primary",
          },
          {
            id: "resume_blocked_work",
            title: "Resume blocked workflow work",
            summary: "Resume work once the node is trusted again.",
            reason: "Blocked work is waiting on the degraded node.",
            status: "blocked",
            riskClass: "bounded_repair",
            requiresApproval: true,
            tone: "warning",
          },
        ],
      },
    });

    expect(steps.map((step) => step.id)).toEqual([
      "restore_heartbeat",
      "requeue_expired_leases",
      "resume_blocked_work",
    ]);
    expect(steps[0]?.routeTarget).toBe("/assistant");
    expect(steps[1]?.routeTarget).toBe("/fleet");
    expect(steps[1]?.actionId).toBe("requeue_expired_leases");
    expect(steps[1]?.status).toBe("ready");
    expect(steps[2]?.requiresApproval).toBe(true);
  });

  it("builds assistant-aligned fleet detail links", () => {
    expect(buildFleetHref("sat-1", "recovery")).toBe("/fleet?satelliteId=sat-1&focus=recovery");
    expect(buildFleetHref(undefined, "queue")).toBe("/fleet?focus=queue");
  });

  it("builds runtime boundary cards for bounded continuation", () => {
    const card = buildFleetRuntimeRecoveryCard({
      satellite: {
        satelliteId: "sat-1",
        type: "linux",
        displayName: "Edge Runner",
        pairingStatus: "degraded",
        trustLevel: "trusted",
        trustScore: 88,
        trustBand: "medium",
        healthScore: 55,
        healthState: "degraded",
        lastSeenAt: "2026-03-08T09:30:00.000Z",
        heartbeatAgeMs: 120_000,
        queueDepth: 2,
        activeRuns: 1,
        tags: [],
        alerts: [],
      },
      capabilities: [],
      queue: {
        queued: 1,
        leased: 0,
        failed: 1,
        deadLetter: 0,
      },
      workflowLoad: {
        queuedNodes: 0,
        runningNodes: 1,
        retryingNodes: 1,
        blockedOfflineNodes: 1,
      },
      trustBreakdown: {
        identityScore: 90,
        statusScore: 80,
        hygieneScore: 84,
        incidentPenalty: 4,
        finalScore: 88,
        band: "medium",
        reasons: ["Trusted certificate present"],
      },
      healthBreakdown: {
        heartbeatScore: 20,
        resourceScore: 75,
        queueScore: 55,
        reliabilityScore: 60,
        finalScore: 55,
        state: "degraded",
      },
      runtimeRecovery: {
        state: "degraded",
        continuationMode: "already_dispatched_only",
        offlinePlanningMode: "deferred",
        summary: "Friday can continue already-dispatched work, but new offline planning stays deferred until the node is healthy again.",
        reasons: ["Recent heartbeat is stale."],
        queueRecoveryState: "retrying",
        syncRecoveryState: "recovering",
        requiresOperatorIntervention: true,
        autoRetryActive: true,
        nextOperatorAction: "restore_heartbeat",
      },
      remediation: {
        status: "blocked",
        requiresApproval: true,
        actions: [],
      },
    });

    expect(card?.title).toContain("degraded");
    expect(card?.nextActionLabel).toBe("Restore heartbeat and runtime health");
    expect(card?.queueRecoveryLabel).toBe("Retrying");
    expect(card?.syncRecoveryLabel).toBe("Recovering");
    expect(card?.continuationLabel).toBe("Already-dispatched work only");
    expect(card?.offlinePlanningLabel).toBe("Deferred");
    expect(card?.requiresOperatorIntervention).toBe(true);
    expect(card?.autoRetryActive).toBe(true);
  });
});
