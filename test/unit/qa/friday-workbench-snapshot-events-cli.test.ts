import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function makeSnapshot(overrides: Record<string, unknown> = {}) {
  const missionId = "mission_workbench_events_bridge";
  return {
    missionId,
    fridayConversationId: "conversation_workbench_events_bridge",
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
    ],
    transcriptSections: [
      {
        id: "section_workbench_events_bridge",
        title: "Mission projection",
        groupKind: "mission",
        missionId,
        truthLabel: "friday_owned",
        status: "waiting",
        events: [
          transcriptEvent("event_mobile_intake", "mobile", "ready", { surfaceThreadRef: "surface://mobile/thread", workflowRef: "workflow://mission/intake", timelineRef: "timeline://mission/page-1/event-mobile-intake" }),
          transcriptEvent("event_provider_ack", "desktop", "provider_ack", { providerRef: "provider://session", proofReceiptRef: "proof://provider/ack", surfaceThreadRef: "surface://desktop/thread", timelineRef: "timeline://mission/page-1/event-provider-ack" }, "work_provider"),
          transcriptEvent("event_channel_receipt", "telegram", "queued", { channelRef: "channel://telegram/redacted", proofReceiptRef: "proof://channel/receipt", timelineRef: "timeline://mission/page-2/event-channel-receipt" }),
          transcriptEvent("event_timeline_read", "timeline", "timeline_read", { workflowRef: "workflow://mission/timeline", timelineRef: "timeline://mission/page-2/cursor" }, "work_timeline"),
          transcriptEvent("event_memory_candidate", "timeline", "waiting", { skillRunRef: "skill://candidate/review-only", workflowRef: "workflow://memory/review", timelineRef: "timeline://mission/page-2/event-memory-candidate" }),
          transcriptEvent("event_completed_with_proof", "desktop", "completed_with_proof", { providerRef: "provider://session/receipt", proofReceiptRef: "proof://provider/receipt", surfaceThreadRef: "surface://desktop/thread", timelineRef: "timeline://mission/page-2/event-completed-with-proof" }, "work_completed"),
        ],
      },
    ],
    ...overrides,
  };
}

function transcriptEvent(
  id: string,
  surface: string,
  status: string,
  evidenceRefs: Record<string, string>,
  workItemId?: string,
) {
  return {
    id,
    missionId: "mission_workbench_events_bridge",
    workItemId,
    surface,
    status,
    truthLabel: surface === "telegram" ? "observed_only" : "friday_owned",
    summary: `${surface} ${status}`,
    proofRef: "proof://redacted",
    evidenceRefs,
    capturedAt: "2026-06-05T06:10:00Z",
  };
}

function writeEvidence(tempDir: string) {
  const files = {
    mobile: join(tempDir, "mobile.txt"),
    desktop: join(tempDir, "desktop.txt"),
    channel: join(tempDir, "channel.txt"),
    timeline: join(tempDir, "timeline.txt"),
  };
  for (const [role, path] of Object.entries(files)) {
    writeFileSync(path, `${role} evidence\n`);
  }
  return files;
}

function runBridge(tempDir: string, snapshot: Record<string, unknown>, extraArgs: string[] = []) {
  const snapshotPath = join(tempDir, "snapshot.json");
  const out = join(tempDir, "workbench-derived-events.jsonl");
  const files = writeEvidence(tempDir);
  writeFileSync(snapshotPath, JSON.stringify({ snapshot }, null, 2));
  const stdout = execFileSync(process.execPath, [
    "scripts/ops/friday-workbench-snapshot-events.mjs",
    "--mission-id=mission_workbench_events_bridge",
    `--file=${snapshotPath}`,
    `--mobile=${files.mobile}`,
    `--desktop=${files.desktop}`,
    `--channel=${files.channel}`,
    `--timeline=${files.timeline}`,
    `--out=${out}`,
    ...extraArgs,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  return { result: JSON.parse(stdout), out };
}

describe("friday-workbench-snapshot-events CLI", () => {
  it("bridges a preflight-passing workbench snapshot into diagnostic events only", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-workbench-events-"));
    try {
      const { result, out } = runBridge(tempDir, makeSnapshot(), ["--require-ready"]);
      const rows = readFileSync(out, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const keys = rows.map((row) => `${row.surface}:${row.event}`);

      expect(result).toMatchObject({
        truth: "workbench_snapshot_events_bridge_diagnostic_not_proof",
        status: "ready",
        preflightReady: true,
      });
      expect(keys).toContain("desktop:mission_resolve_or_create_visible");
      expect(keys).toContain("desktop:mission_workbench_visible");
      expect(keys).toContain("desktop:transcript_browser_visible");
      expect(keys).toContain("channel:same_mission_projection_visible");
      expect(keys).toContain("timeline:bounded_page_2_visible");
      expect(keys).not.toContain("*:pressure_20_50_consecutive_asks_visible");
      expect(new Set(rows.map((row) => row.truth_label))).toEqual(new Set([
        "derived_from_preflighted_workbench_snapshot_not_final_proof",
      ]));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fails closed and writes no events when the snapshot contract is not ready", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-workbench-events-blocked-"));
    try {
      const invalid = makeSnapshot({ runtimeFeedStatus: "prep_contract_fallback" });
      const { result, out } = runBridge(tempDir, invalid);

      expect(result.status).toBe("blocked");
      expect(result.blockers.map((blocker: { code: string }) => blocker.code)).toContain("snapshot_preflight_not_ready");
      expect(() => readFileSync(out, "utf8")).toThrow();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("can derive non-channel diagnostic rows when channel evidence is deferred", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-workbench-events-channel-deferred-"));
    try {
      const snapshotPath = join(tempDir, "snapshot.json");
      const out = join(tempDir, "workbench-derived-events.jsonl");
      const files = writeEvidence(tempDir);
      writeFileSync(snapshotPath, JSON.stringify({ snapshot: makeSnapshot() }, null, 2));

      const stdout = execFileSync(process.execPath, [
        "scripts/ops/friday-workbench-snapshot-events.mjs",
        "--mission-id=mission_workbench_events_bridge",
        `--file=${snapshotPath}`,
        `--mobile=${files.mobile}`,
        `--desktop=${files.desktop}`,
        `--timeline=${files.timeline}`,
        `--out=${out}`,
        "--defer-channel-proof",
        "--require-ready",
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      const result = JSON.parse(stdout) as {
        status?: string;
        deferredInputs?: Array<{ role?: string; countsTowardUiDeviceProof?: boolean }>;
      };
      const rows = readFileSync(out, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const keys = rows.map((row) => `${row.surface}:${row.event}`);

      expect(result.status).toBe("ready");
      expect(result.deferredInputs).toContainEqual(expect.objectContaining({
        role: "channel",
        countsTowardUiDeviceProof: false,
      }));
      expect(keys).toContain("desktop:mission_resolve_or_create_visible");
      expect(keys).toContain("timeline:bounded_page_2_visible");
      expect(keys).not.toContain("channel:same_mission_projection_visible");
      expect(keys).not.toContain("*:same_mission_mobile_desktop_channel_visible");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fails closed in strict mode for a partial non-channel snapshot", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-workbench-events-diagnostic-timeline-"));
    try {
      const missionId = "mission_workbench_events_bridge";
      const snapshotPath = join(tempDir, "snapshot.json");
      const out = join(tempDir, "workbench-derived-events.jsonl");
      const files = writeEvidence(tempDir);
      const partial = makeSnapshot({
        providerReceiptRefs: [],
        channelReceiptRefs: [],
        memoryCandidates: [],
        workItems: [
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
        ],
        timelinePages: [
          { page: 1, cursor: "cursor_1", nextCursor: "cursor_2", eventRefs: ["event_mobile_intake", "event_desktop_projection"] },
          { page: 2, cursor: "cursor_2", eventRefs: ["event_timeline_read"] },
        ],
        transcriptSections: [
          {
            id: "section_workbench_events_bridge",
            title: "Mission projection",
            groupKind: "mission",
            missionId,
            truthLabel: "friday_owned",
            status: "waiting",
            events: [
              transcriptEvent("event_mobile_intake", "mobile", "ready", { surfaceThreadRef: "surface://mobile/thread", workflowRef: "workflow://mission/intake", timelineRef: "timeline://mission/page-1/event-mobile-intake" }),
              transcriptEvent("event_desktop_projection", "desktop", "waiting", { surfaceThreadRef: "surface://desktop/thread", timelineRef: "timeline://mission/page-1/event-desktop-projection" }),
              transcriptEvent("event_timeline_read", "timeline", "timeline_read", { workflowRef: "workflow://mission/timeline", timelineRef: "timeline://mission/page-2/cursor" }, "work_timeline"),
            ],
          },
        ],
      });
      writeFileSync(snapshotPath, JSON.stringify({ snapshot: partial }, null, 2));

      const result = spawnSync(process.execPath, [
        "scripts/ops/friday-workbench-snapshot-events.mjs",
        "--mission-id=mission_workbench_events_bridge",
        `--file=${snapshotPath}`,
        `--mobile=${files.mobile}`,
        `--desktop=${files.desktop}`,
        `--timeline=${files.timeline}`,
        `--out=${out}`,
        "--defer-channel-proof",
        "--require-ready",
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      const stdout = result.stdout.toString();
      const parsed = JSON.parse(stdout) as { status?: string; preflightReady?: boolean; diagnosticTimelineReady?: boolean };

      expect(result.status).toBe(2);
      expect(parsed.status).toBe("blocked");
      expect(parsed.preflightReady).toBe(false);
      expect(parsed.diagnosticTimelineReady).toBe(true);
      expect(() => readFileSync(out, "utf8")).toThrow();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
