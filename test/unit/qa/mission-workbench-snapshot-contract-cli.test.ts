import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function makeSnapshot(
  overrides: Record<string, unknown> = {},
  missionId = "mission_cli_snapshot_contract",
) {
  const snapshot = {
    missionId,
    fridayConversationId: "conversation_cli_snapshot_contract",
    runtimeFeedStatus: "live_rust_hub_projection",
    statusLabels: ["stale", "offline", "error"],
    duplicatePreflight: {
      status: "opens_existing_mission",
      duplicateMissionId: missionId,
      duplicateWorkItemId: "work_provider",
    },
    routeDecision: {
      advisorSummary: "Rust Hub route decision projection.",
      selectedRoute: "route_decision_ref",
      controlRef: `friday://route-decision-projection/${missionId}/work_provider/1700000000000`,
      workItemId: "work_provider",
      alternatives: ["alternate_ref"],
      actionItems: [
        {
          description: "Implement Mission Spine domain types",
          targetKind: "file",
          targetRef: "rust-core/crates/friday-core/src/lib.rs",
          reversibility: "operator_gate_required",
          assignedLane: "codex",
          assignedProviderOrAgent: "codex",
          routeReason: "Rust Hub must own product truth before UI wiring",
        },
      ],
      truthLabel: "friday_owned",
    },
    providerReceiptRefs: ["proof://provider/receipt/redacted"],
    channelReceiptRefs: ["proof://channel/receipt/redacted"],
    workItems: [
      {
        id: "work_provider",
        title: "Mission-bound provider action",
        state: "provider_ack",
        owner: "friday_owned",
        proofRef: "proof://provider/ack/not-completion",
        done: false,
        blockingReason: "provider or hub execution is still in flight; cancel is the only exposed recovery action",
        recoveryKind: "in_flight",
        canRetry: false,
        canCancel: true,
      },
      {
        id: "work_timeline",
        title: "Bounded timeline read",
        state: "timeline_read",
        owner: "friday_owned",
        proofRef: "proof://timeline/page-2/cursor",
        done: false,
        blockingReason: "bounded timeline read only; no WorkItem recovery action applies",
        recoveryKind: "none",
        canRetry: false,
        canCancel: false,
      },
      {
        id: "work_completed",
        title: "Completed only after proof receipt",
        state: "completed_with_proof",
        owner: "friday_owned",
        proofRef: "proof://provider/receipt/redacted",
        done: true,
        blockingReason: "terminal or archived WorkItem; no recovery action applies",
        recoveryKind: "none",
        canRetry: false,
        canCancel: false,
      },
    ],
    timelinePages: [
      { page: 1, cursor: "cursor_1", nextCursor: "cursor_2", eventRefs: ["event_mobile_intake", "event_provider_ack"] },
      { page: 2, cursor: "cursor_2", eventRefs: ["event_channel_receipt", "event_timeline_read", "event_memory_candidate", "event_completed_with_proof"] },
    ],
    memoryCandidates: [
      {
        id: "memory_candidate_review_only",
        preview: "Review-only candidate.",
        state: "candidate_review_only",
        grantsMemoryAuthority: false,
        evidenceRef: "proof://memory/review-only",
      },
    ],
    capabilityStates: [
      {
        id: "capability_mission_advisor",
        label: "Mission advisor",
        kind: "advisor",
        truthLabel: "friday_owned",
        approvalState: "not_required",
        dispatchAllowed: false,
        summary: "Advisor state is a Rust Hub projection.",
        proofRef: "proof://advisor/route-decision/redacted",
      },
      {
        id: "skill_observed_only",
        label: "Observed skill",
        kind: "skill",
        truthLabel: "observed_only",
        approvalState: "required",
        dispatchAllowed: false,
        summary: "Observed skill availability cannot dispatch before approval.",
        proofRef: "proof://skill/observed-only/no-dispatch",
      },
    ],
    transcriptSections: [
      {
        id: "section_cli_snapshot_contract",
        title: "Mission projection",
        groupKind: "mission",
        missionId,
        truthLabel: "friday_owned",
        status: "waiting",
        events: [
          {
            id: "event_mobile_intake",
            missionId,
            workItemId: "work_provider",
            surface: "mobile",
            status: "ready",
            truthLabel: "friday_owned",
            summary: "Mobile Mission intake is attached to the same Mission.",
            proofRef: "proof://surface/mobile/intake",
            evidenceRefs: {
              surfaceThreadRef: "surface://mobile/thread/redacted",
              workflowRef: "workflow://mission/intake",
              timelineRef: "timeline://mission/page-1/event-mobile-intake",
            },
            capturedAt: "2026-06-05T06:10:00Z",
          },
          {
            id: "event_provider_ack",
            missionId,
            workItemId: "work_provider",
            surface: "desktop",
            status: "provider_ack",
            truthLabel: "friday_owned",
            summary: "Provider ack is visible and not completion.",
            proofRef: "proof://provider/ack/not-completion",
            evidenceRefs: {
              providerRef: "provider://session/redacted",
              proofReceiptRef: "proof://provider/ack/not-completion",
              surfaceThreadRef: "surface://desktop/thread/redacted",
              timelineRef: "timeline://mission/page-1/event-provider-ack",
            },
            capturedAt: "2026-06-05T06:10:01Z",
          },
          {
            id: "event_channel_receipt",
            missionId,
            surface: "telegram",
            status: "queued",
            truthLabel: "observed_only",
            summary: "Telegram receipt is redacted and evidence-only.",
            proofRef: "proof://channel/receipt/redacted",
            evidenceRefs: {
              channelRef: "channel://telegram/redacted-wrapper",
              proofReceiptRef: "proof://channel/receipt/redacted",
              timelineRef: "timeline://mission/page-2/event-channel-receipt",
            },
            capturedAt: "2026-06-05T06:10:02Z",
          },
          {
            id: "event_timeline_read",
            missionId,
            workItemId: "work_timeline",
            surface: "timeline",
            status: "timeline_read",
            truthLabel: "friday_owned",
            summary: "Timeline read is bounded and not completion.",
            proofRef: "proof://timeline/page-2/cursor",
            evidenceRefs: {
              workflowRef: "workflow://mission/bounded-timeline-read",
              timelineRef: "timeline://mission/page-2/cursor",
            },
            capturedAt: "2026-06-05T06:10:03Z",
          },
          {
            id: "event_memory_candidate",
            missionId,
            surface: "timeline",
            status: "waiting",
            truthLabel: "friday_adopted",
            summary: "Memory remains a review-only candidate.",
            proofRef: "proof://memory/review-only",
            evidenceRefs: {
              skillRunRef: "skill://candidate/review-only-no-dispatch",
              workflowRef: "workflow://memory/review-candidate",
              timelineRef: "timeline://mission/page-2/event-memory-candidate",
            },
            capturedAt: "2026-06-05T06:10:04Z",
          },
          {
            id: "event_completed_with_proof",
            missionId,
            workItemId: "work_completed",
            surface: "desktop",
            status: "completed_with_proof",
            truthLabel: "friday_owned",
            summary: "Completion is visible only with a proof receipt.",
            proofRef: "proof://provider/receipt/redacted",
            evidenceRefs: {
              providerRef: "provider://session/redacted-receipt",
              proofReceiptRef: "proof://provider/receipt/redacted",
              surfaceThreadRef: "surface://desktop/thread/redacted",
              timelineRef: "timeline://mission/page-2/event-completed-with-proof",
            },
            capturedAt: "2026-06-05T06:10:05Z",
          },
        ],
      },
    ],
  };

  return {
    ...snapshot,
    ...overrides,
  };
}

function runSnapshotContract(
  filePath: string,
  extraArgs: string[] = [],
  missionId = "mission_cli_snapshot_contract",
) {
  const stdout = execFileSync(process.execPath, [
    "scripts/qa/check-mission-workbench-snapshot-contract.mjs",
    `--file=${filePath}`,
    `--mission-id=${missionId}`,
    ...extraArgs,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  return JSON.parse(stdout) as {
    proof: string;
    proof_source: string;
    readyForLiveCaptureInput: boolean;
    failures: Array<{ code: string; detail: string }>;
    summary: {
      transcriptSurfaces?: string[];
      transcriptEvidenceFacets?: string[];
    } | null;
  };
}

describe("check-mission-workbench-snapshot-contract CLI", () => {
  it("accepts a strong same-Mission live snapshot without producing final proof", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-workbench-contract-"));
    try {
      const filePath = join(tempDir, "snapshot.json");
      writeFileSync(filePath, JSON.stringify({ snapshot: makeSnapshot() }, null, 2));

      const result = runSnapshotContract(filePath);

      expect(result).toMatchObject({
        proof: "mission_workbench_snapshot_contract_preflight",
        proof_source: "live_snapshot_contract_check_only_not_ui_device_proof",
        readyForLiveCaptureInput: true,
        failures: [],
      });
      expect(result.summary?.transcriptSurfaces).toEqual(["desktop", "mobile", "telegram", "timeline"]);
      expect(result.summary?.transcriptEvidenceFacets).toEqual([
        "channelRef",
        "proofReceiptRef",
        "providerRef",
        "skillRunRef",
        "surfaceThreadRef",
        "timelineRef",
        "workflowRef",
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts real Rust producer hyphen mission ids without downgrading the contract", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-workbench-contract-hyphen-"));
    try {
      const missionId = "mission-autodisp-1781492033";
      const filePath = join(tempDir, "snapshot.json");
      writeFileSync(filePath, JSON.stringify({ snapshot: makeSnapshot({}, missionId) }, null, 2));

      const result = runSnapshotContract(filePath, [], missionId);

      expect(result.readyForLiveCaptureInput).toBe(true);
      expect(result.failures).toEqual([]);
      expect(result.summary?.transcriptSurfaces).toEqual(["desktop", "mobile", "telegram", "timeline"]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fails closed for invalid live snapshot enums in expect-not-ready mode", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-workbench-contract-invalid-"));
    try {
      const invalidSnapshot = makeSnapshot({
        workItems: makeSnapshot().workItems.map((item, index) => (
          index === 0
            ? { ...item, state: "provider_done_ack", owner: "provider_owned" }
            : item
        )),
        transcriptSections: makeSnapshot().transcriptSections.map((section) => ({
          ...section,
          truthLabel: "provider_owned",
          status: "provider_done_ack",
          events: section.events.map((event, index) => (
            index === 0
              ? { ...event, surface: "slack_raw", status: "provider_done_ack", truthLabel: "provider_owned" }
              : event
          )),
        })),
      });
      const filePath = join(tempDir, "invalid-snapshot.json");
      writeFileSync(filePath, JSON.stringify({ snapshot: invalidSnapshot }, null, 2));

      const result = runSnapshotContract(filePath, ["--expect-not-ready"]);
      const failureCodes = result.failures.map((failure) => failure.code);

      expect(result.readyForLiveCaptureInput).toBe(false);
      expect(failureCodes).toContain("work_item_truth_label_invalid");
      expect(failureCodes).toContain("work_item_state_invalid");
      expect(failureCodes).toContain("transcript_section_truth_label_invalid");
      expect(failureCodes).toContain("transcript_section_status_invalid");
      expect(failureCodes).toContain("transcript_event_surface_invalid");
      expect(failureCodes).toContain("transcript_event_status_invalid");
      expect(failureCodes).toContain("transcript_event_truth_label_invalid");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fails closed when bounded timeline refs and transcript events diverge", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-workbench-contract-timeline-link-"));
    try {
      const invalidSnapshot = makeSnapshot({
        timelinePages: [
          { page: 1, cursor: "cursor_1", nextCursor: "cursor_2", eventRefs: ["event_mobile_intake", "event_missing_from_transcript"] },
          { page: 2, cursor: "cursor_2", eventRefs: ["event_channel_receipt"] },
        ],
      });
      const filePath = join(tempDir, "timeline-link-invalid-snapshot.json");
      writeFileSync(filePath, JSON.stringify({ snapshot: invalidSnapshot }, null, 2));

      const result = runSnapshotContract(filePath, ["--expect-not-ready"]);
      const failureCodes = result.failures.map((failure) => failure.code);

      expect(result.readyForLiveCaptureInput).toBe(false);
      expect(failureCodes).toContain("timeline_event_ref_missing_from_transcript");
      expect(failureCodes).toContain("transcript_event_missing_from_timeline");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
