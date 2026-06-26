import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const missionId = "mission_cli_ui_device_readiness";

function writeEvidenceDir(tempDir: string) {
  const files = {
    mobile: join(tempDir, "mobile.json"),
    desktop: join(tempDir, "desktop.json"),
    channel: join(tempDir, "channel.json"),
    timeline: join(tempDir, "timeline.json"),
    manifest: join(tempDir, "observations-manifest.json"),
    out: join(tempDir, "assembled-proof.json"),
  };

  writeFileSync(join(tempDir, "mission-id.txt"), `${missionId}\n`);
  for (const [role, filePath] of Object.entries({
    mobile: files.mobile,
    desktop: files.desktop,
    channel: files.channel,
    timeline: files.timeline,
  })) {
    writeFileSync(filePath, JSON.stringify({ role, mission_id: missionId, capture: "redacted live-capture-shaped qa input" }));
  }
  writeFileSync(files.manifest, JSON.stringify(makeManifest(files), null, 2));
  return files;
}

function writePartialEvidenceDir(tempDir: string) {
  const files = {
    mobile: join(tempDir, "mobile.json"),
    desktop: join(tempDir, "desktop.json"),
    channel: join(tempDir, "channel.json"),
    timeline: join(tempDir, "timeline.json"),
    events: join(tempDir, "same-run-events.jsonl"),
  };

  writeFileSync(join(tempDir, "mission-id.txt"), `${missionId}\n`);
  for (const [role, filePath] of Object.entries({
    mobile: files.mobile,
    desktop: files.desktop,
    channel: files.channel,
    timeline: files.timeline,
  })) {
    writeFileSync(filePath, JSON.stringify({ role, mission_id: missionId, capture: "redacted partial qa input" }));
  }
  const rows = [
    observation("mobile", "mission_intake_submitted", files.mobile),
    observation("mobile", "mission_intake_ready", files.mobile),
    observation("mobile", "mission_bound_provider_action_visible", files.mobile),
    observation("mobile", "proof_receipt_visible_before_done", files.mobile),
    observation("desktop", "same_mission_projection_visible", files.desktop),
  ];
  writeFileSync(files.events, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  return files;
}

function writeDesignActionContract(tempDir: string) {
  const contract = join(tempDir, "ACTION-CONTRACT.md");
  writeFileSync(contract, `# Friday Action Contract — mobile + desktop

**This is a wiring contract for the later Rust/native agent, NOT runtime proof.** Every row is design-proof; wired_registry ≠ runtime PASS.

| Surface | Screen [state] | action_id | Label | capability_id | reg | reg_status | truth_status | result/target | Rust/Hub owner · gate · test expectation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mobile | fridayChat | act | Send to Friday | ask_friday_chat_compose_send | ✓ | wired | wired_registry | result:submitted | Runtime test must prove gate enforcement. |
| desktop | fridayChat | check | Approve | security_approval_bound_principal_gate_cat10_netnew | ✓ | wired | wired_registry | result:confirmed | Runtime test must prove gate enforcement. |
`);
  return contract;
}

function writeDesignActionRuntimeBundleDir(tempDir: string) {
  const bundleDir = join(tempDir, "action-runtime-bundle");
  const mobileRuntime = join(bundleDir, "mobile-action-runtime-evidence.json");
  const desktopRuntime = join(bundleDir, "desktop-action-runtime-evidence.json");
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(mobileRuntime, JSON.stringify({
    actions: [{
      surface: "mobile",
      screen: "fridayChat",
      action_id: "act",
      capability_id: "ask_friday_chat_compose_send",
      status: "pass",
      evidence_ref: "proof://mobile/send",
    }],
  }, null, 2));
  writeFileSync(desktopRuntime, JSON.stringify({
    actions: [{
      surface: "desktop",
      screen: "fridayChat",
      action_id: "check",
      capability_id: "security_approval_bound_principal_gate_cat10_netnew",
      status: "pass",
      evidence_ref: "proof://desktop/approve",
    }],
  }, null, 2));
  writeFileSync(join(bundleDir, "action-runtime-evidence-bundle-index.json"), JSON.stringify({
    truth: "action_runtime_evidence_bundle_partial_not_live_hub_not_endbar",
    status: "ready",
    runtime_evidence_paths: [mobileRuntime, desktopRuntime],
  }, null, 2));
  return { bundleDir, mobileRuntime, desktopRuntime };
}

function writeSupportingProofs(tempDir: string) {
  const files = {
    backend: join(tempDir, "backend-live-proof.json"),
    channel: join(tempDir, "channel-live-proof.json"),
    objective: join(tempDir, "objective-coverage.json"),
  };
  writeFileSync(files.backend, JSON.stringify({
    proof: "mission_spine_backend_api_live_pressure",
    status: "passed",
    remaining_requirement: "real mobile/desktop/channel UI/device consumption evidence must still pass scripts/mission-spine-ui-device-proof-gate.sh",
  }, null, 2));
  writeFileSync(files.channel, JSON.stringify({
    proof: "mission_spine_channel_live_proof",
    status: "passed",
    remaining_requirement: "real mobile/desktop/channel UI/device consumption evidence must still pass scripts/mission-spine-ui-device-proof-gate.sh",
  }, null, 2));
  writeFileSync(files.objective, JSON.stringify({
    proof: "mission_spine_objective_coverage",
    status: "passed",
    remaining_requirement: "real mobile/desktop/channel UI or device consumption evidence must still pass scripts/mission-spine-ui-device-proof-gate.sh",
    requirements: [
      {
        requirement: "real mobile/desktop/channel UI or device consumption",
        required_gate: "scripts/mission-spine-ui-device-proof-gate.sh",
      },
    ],
  }, null, 2));
  return files;
}

function writeRedactedChannelProof(tempDir: string) {
  const proof = join(tempDir, "channel-live-proof.json");
  writeFileSync(proof, JSON.stringify({
    proof: "mission_spine_channel_live_proof",
    status: "passed",
    generated_at_utc: "2026-06-05T06:10:00Z",
    telegram_live: {
      status: "passed",
      proof: "telegram_inbound_through_rust_channels_pipeline",
      bot_identity_verified: true,
      channel_binding_created: true,
      sender_allowlisted: true,
      forged_bearer_rejected: true,
      non_allowlisted_sender_rejected: true,
    },
    secret_policy: {
      artifact_contains_redacted_text_only: true,
    },
    remaining_requirement: "real mobile/desktop/channel UI/device consumption evidence must still pass scripts/mission-spine-ui-device-proof-gate.sh",
  }, null, 2));
  return proof;
}

function writeWorkbenchSnapshotEvidenceDir(tempDir: string) {
  const files = {
    mobile: join(tempDir, "mobile.json"),
    desktop: join(tempDir, "desktop.json"),
    channel: join(tempDir, "channel.json"),
    timeline: join(tempDir, "timeline.json"),
    snapshot: join(tempDir, "workbench-snapshot.json"),
  };

  writeFileSync(join(tempDir, "mission-id.txt"), `${missionId}\n`);
  for (const [role, filePath] of Object.entries({
    mobile: files.mobile,
    desktop: files.desktop,
    channel: files.channel,
    timeline: files.timeline,
  })) {
    writeFileSync(filePath, JSON.stringify({ role, mission_id: missionId, capture: "redacted snapshot-derived qa input" }));
  }
  writeFileSync(files.snapshot, JSON.stringify({ snapshot: makeWorkbenchSnapshot() }, null, 2));
  return files;
}

function writeDesktopLiveCaptureDir(tempDir: string) {
  const files = {
    proof: join(tempDir, "macos-live-write-read-proof.json"),
    events: join(tempDir, "macos-live-write-read-events.jsonl"),
    index: join(tempDir, "capture-index.json"),
  };

  writeFileSync(files.proof, JSON.stringify({
    truth_label: "macos_desktop_live_write_read_roundtrip_proof_not_ui_device_proof",
    status: "pass",
    mission_id: missionId,
    work_item_id: "work_desktop_live_capture",
    surface_kind: "desktop",
    write: { status: "ready", created_or_ready: true },
    read_projection: { contains_written_work_item: true },
  }, null, 2));
  writeFileSync(files.events, `${[
    observation("desktop", "mission_intake_submitted", files.proof),
    observation("desktop", "mission_intake_ready", files.proof),
    observation("desktop", "same_mission_projection_visible", files.proof),
  ].map((row) => JSON.stringify(row)).join("\n")}\n`);
  writeFileSync(files.index, JSON.stringify({
    truth_label: "macos_live_write_read_capture_index_not_ui_device_proof",
    status: "ready",
    mission_id: missionId,
    desktop: {
      proof: files.proof,
      events: files.events,
      event_count: 3,
    },
    caveat: "Desktop same-run capture only; still requires mobile/channel/timeline evidence before strict UI/device proof.",
  }, null, 2));
  return files;
}

function writeLiveWriteReadBundleDir(tempDir: string) {
  const files = {
    mobile: join(tempDir, "mobile", "ios-live-write-read-proof.json"),
    desktop: join(tempDir, "desktop", "macos-live-write-read-proof.json"),
    mobileEvents: join(tempDir, "mobile", "ios-live-write-read-events.jsonl"),
    desktopEvents: join(tempDir, "desktop", "macos-live-write-read-events.jsonl"),
    combinedEvents: join(tempDir, "bundle", "mobile-desktop-live-write-read-events.jsonl"),
    index: join(tempDir, "bundle", "live-write-read-bundle-index.json"),
  };

  mkdirSync(join(tempDir, "mobile"), { recursive: true });
  mkdirSync(join(tempDir, "desktop"), { recursive: true });
  mkdirSync(join(tempDir, "bundle"), { recursive: true });
  writeFileSync(files.mobile, JSON.stringify({ role: "mobile", mission_id: missionId, status: "pass" }));
  writeFileSync(files.desktop, JSON.stringify({ role: "desktop", mission_id: missionId, status: "pass" }));
  writeFileSync(files.mobileEvents, `${JSON.stringify(observation("mobile", "mission_intake_ready", files.mobile))}\n`);
  writeFileSync(files.desktopEvents, `${JSON.stringify(observation("desktop", "same_mission_projection_visible", files.desktop))}\n`);
  writeFileSync(files.combinedEvents, `${[
    observation("mobile", "mission_intake_ready", files.mobile),
    observation("desktop", "same_mission_projection_visible", files.desktop),
  ].map((row) => JSON.stringify(row)).join("\n")}\n`);
  writeFileSync(files.index, JSON.stringify({
    truth: "ui_device_live_write_read_bundle_not_full_proof",
    status: "partial_bundle_ready",
    missionId,
    captures: {
      mobile: { proof: files.mobile, events: files.mobileEvents },
      desktop: { proof: files.desktop, events: files.desktopEvents },
    },
    combinedEvents: files.combinedEvents,
  }, null, 2));
  return files;
}

function writeIndexedChannelTimelineEvidenceDir(tempDir: string) {
  const files = {
    mobile: join(tempDir, "mobile.json"),
    desktop: join(tempDir, "desktop.json"),
    channel: join(tempDir, "channel", "channel.json"),
    timeline: join(tempDir, "timeline", "timeline.json"),
    events: join(tempDir, "same-run-events.jsonl"),
    index: join(tempDir, "capture-index.json"),
  };

  mkdirSync(join(tempDir, "channel"), { recursive: true });
  mkdirSync(join(tempDir, "timeline"), { recursive: true });
  writeFileSync(join(tempDir, "mission-id.txt"), `${missionId}\n`);
  writeFileSync(files.mobile, JSON.stringify({ role: "mobile", mission_id: missionId, capture: "redacted mobile qa input" }));
  writeFileSync(files.desktop, JSON.stringify({ role: "desktop", mission_id: missionId, capture: "redacted desktop qa input" }));
  writeFileSync(files.channel, JSON.stringify({ role: "channel", mission_id: missionId, capture: "redacted channel qa input" }));
  writeFileSync(files.timeline, JSON.stringify({ role: "timeline", mission_id: missionId, capture: "redacted timeline qa input" }));
  writeFileSync(files.events, `${[
    observation("mobile", "mission_intake_ready", files.mobile),
    observation("desktop", "same_mission_projection_visible", files.desktop),
    observation("channel", "same_mission_projection_visible", files.channel),
    observation("timeline", "bounded_page_1_visible", files.timeline),
  ].map((row) => JSON.stringify(row)).join("\n")}\n`);
  writeFileSync(files.index, JSON.stringify({
    truth: "ui_device_capture_index_not_full_proof",
    status: "partial_bundle_ready",
    mission_id: missionId,
    captures: {
      channel: { proof: files.channel },
      timeline: { proof: files.timeline },
    },
    combinedEvents: files.events,
  }, null, 2));
  return files;
}

function observation(surface: string, event: string, evidenceRef: string) {
  return { surface, event, mission_id: missionId, evidence_ref: evidenceRef };
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
    missionId,
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

function makeWorkbenchSnapshot() {
  return {
    missionId,
    fridayConversationId: "conversation_cli_ui_device_readiness",
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
        id: "section_cli_ui_device_readiness",
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
  };
}

function makeManifest(files: ReturnType<typeof writeEvidenceDir>) {
  return {
    checks: Object.fromEntries([
      "same_mission_id_mobile_desktop",
      "same_mission_id_channel",
      "duplicate_blocked_opens_existing",
      "mission_bound_provider_action_visible",
      "proof_receipt_visible_before_done",
      "provider_ack_not_done",
      "pressure_20_50_consecutive_asks",
      "invalid_key_error_visible",
      "quota_error_visible",
      "network_error_visible",
      "channel_replay_blocked",
      "reconnect_stale_verified",
      "memory_candidate_not_confirmed",
      "no_secret_leak",
      "no_hidden_fallback",
    ].map((check) => [check, true])),
    stress: {
      mission_bound_ask_count: 20,
      consecutive: true,
      duplicate_surface_count: 2,
      provider_ack_not_done: true,
      invalid_key_error_visible: true,
      quota_error_visible: true,
      network_error_visible: true,
      long_timeline_pagination_visible: true,
      long_timeline_page_count: 2,
      reconnect_stale_verified: true,
      channel_replay_blocked: true,
      no_secret_leak: true,
      no_hidden_fallback: true,
      evidence_ref: files.timeline,
    },
    timeline: {
      bounded: true,
      page_count: 2,
      cursor_verified: true,
    },
    mission_workbench: {
      visible: true,
      same_mission_projection_visible: true,
      provider_ack_not_done_visible: true,
      memory_candidate_review_only_visible: true,
      evidence_ref: files.desktop,
    },
    transcript_browser: {
      visible: true,
      collapsed_by_default: true,
      redacted: true,
      bounded_timeline_linked: true,
      evidence_ref: files.desktop,
      search_facets: ["mission", "work_item", "surface", "provider", "skill", "channel", "status", "proof_receipt", "time"],
      evidence_facets: ["providerRef", "skillRunRef", "channelRef", "workflowRef", "surfaceThreadRef", "timelineRef", "proofReceiptRef"],
    },
    status_labels: ["stale", "offline", "error"],
    memory_candidates: [
      { id: "memory_candidate_review_only", confirmed: false, grants_memory_authority: false },
    ],
    event_order: [
      "mission_intake_submitted",
      "mission_resolve_or_create",
      "duplicate_preflight",
      "mission_bound_provider_action",
      "real_provider_execution",
      "proof_receipt",
      "timeline_page_1",
      "timeline_page_2",
      "same_mission_mobile_desktop_channel",
      "memory_candidate_review_only",
      "stale_offline_error_labels_verified",
    ],
    observations: [
      observation("mobile", "mission_intake_submitted", files.mobile),
      observation("mobile", "mission_intake_ready", files.mobile),
      observation("desktop", "mission_resolve_or_create_visible", files.desktop),
      observation("desktop", "duplicate_preflight_visible", files.desktop),
      observation("mobile", "mission_bound_provider_action_visible", files.mobile),
      observation("desktop", "real_provider_execution_visible", files.desktop),
      observation("mobile", "proof_receipt_visible_before_done", files.mobile),
      observation("desktop", "same_mission_projection_visible", files.desktop),
      observation("desktop", "mission_workbench_visible", files.desktop),
      observation("desktop", "transcript_browser_visible", files.desktop),
      observation("desktop", "duplicate_blocked_opens_existing", files.desktop),
      observation("channel", "same_mission_projection_visible", files.channel),
      observation("channel", "same_mission_mobile_desktop_channel_visible", files.channel),
      observation("timeline", "bounded_page_1_visible", files.timeline),
      observation("timeline", "bounded_page_2_visible", files.timeline),
      observation("timeline", "memory_candidate_review_only", files.timeline),
      observation("desktop", "provider_ack_not_done_visible", files.desktop),
      observation("desktop", "pressure_20_50_consecutive_asks_visible", files.desktop),
      observation("desktop", "invalid_key_error_visible", files.desktop),
      observation("desktop", "quota_error_visible", files.desktop),
      observation("desktop", "network_error_visible", files.desktop),
      observation("channel", "channel_replay_blocked_visible", files.channel),
      observation("desktop", "reconnect_stale_verified", files.desktop),
      observation("desktop", "real_provider_execution_receipt_visible", files.desktop),
      observation("desktop", "stale_label_visible", files.desktop),
      observation("desktop", "offline_label_visible", files.desktop),
      observation("desktop", "error_label_visible", files.desktop),
      observation("desktop", "no_hidden_fallback_verified", files.desktop),
    ],
  };
}

describe("friday-ui-device-proof-readiness", () => {
  it("does not require final proof mode to be not-ready", () => {
    const source = readFileSync("scripts/ops/friday-ui-device-proof-readiness.sh", "utf8");
    expect(source).toContain("EXPECT_NOT_READY_ARGS=(--expect-not-ready)");
    expect(source).toContain('if [ "${MODE}" = "require-proof" ]; then');
    expect(source).toContain("EXPECT_NOT_READY_ARGS=()");
    expect(source).toContain('check-mission-workbench-live-readiness.mjs" "${EXPECT_NOT_READY_ARGS[@]}"');
    expect(source).toContain('check-mission-workbench-snapshot-contract.mjs"');
    expect(source).not.toContain("check-mission-workbench-live-readiness.mjs\" --expect-not-ready");
  });

  it("discovers a complete evidence dir and delegates to the strict assembler", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-device-readiness-"));
    try {
      const files = writeEvidenceDir(tempDir);
      const stdout = execFileSync("bash", [
        "scripts/ops/friday-ui-device-proof-readiness.sh",
        "--evidence-dir",
        tempDir,
      ], {
        cwd: process.cwd(),
        env: { ...process.env, OUT: files.out },
        encoding: "utf8",
      });

      expect(stdout).toContain('"truth":"assembled_real_ui_device_proof"');
      const proof = JSON.parse(readFileSync(files.out, "utf8")) as {
        proof?: string;
        mission_id?: string;
        surfaces?: { mobile?: { evidence_ref?: string } };
      };
      expect(proof.proof).toBe("mission_spine_ui_device_consumption");
      expect(proof.mission_id).toBe(missionId);
      expect(proof.surfaces?.mobile?.evidence_ref).toBe(files.mobile);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reports blocked instead of assembling when the evidence dir is incomplete", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-device-readiness-missing-"));
    try {
      writeFileSync(join(tempDir, "mission-id.txt"), `${missionId}\n`);
      writeFileSync(join(tempDir, "mobile.json"), JSON.stringify({ role: "mobile", mission_id: missionId }));

      const stdout = execFileSync("bash", [
        "scripts/ops/friday-ui-device-proof-readiness.sh",
        "--evidence-dir",
        tempDir,
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      const result = JSON.parse(stdout.slice(stdout.indexOf("{"))) as {
        truth?: string;
        status?: string;
        blockers?: string[];
      };

      expect(result.truth).toBe("report_only_not_ui_device_proof");
      expect(result.status).toBe("blocked");
      expect(result.blockers).toContain("ui_device_proof_evidence:missing_required_real_evidence_env");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("discovers desktop live write-read capture artifacts without hand-written evidence aliases", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-device-readiness-desktop-live-"));
    try {
      const files = writeDesktopLiveCaptureDir(tempDir);

      const stdout = execFileSync("bash", [
        "scripts/ops/friday-ui-device-proof-readiness.sh",
        "--evidence-dir",
        tempDir,
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      const result = JSON.parse(stdout.slice(stdout.indexOf("{"))) as {
        truth?: string;
        status?: string;
        notes?: string[];
        blockers?: string[];
      };

      expect(result.truth).toBe("report_only_not_ui_device_proof");
      expect(result.status).toBe("blocked");
      expect(result.notes).toContain(`resolved_MISSION_ID:${missionId}`);
      expect(result.notes).toContain(`resolved_DESKTOP_EVIDENCE:${files.proof}`);
      expect(result.notes).toContain(`resolved_SAME_RUN_EVENTS:${files.events}`);
      expect(result.blockers).toContain("ui_device_proof_evidence:missing_required_real_evidence_env");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("discovers live write-read bundle missionId and prefers combined same-run events", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-device-readiness-bundle-"));
    try {
      const files = writeLiveWriteReadBundleDir(tempDir);

      const stdout = execFileSync("bash", [
        "scripts/ops/friday-ui-device-proof-readiness.sh",
        "--evidence-dir",
        tempDir,
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      const result = JSON.parse(stdout.slice(stdout.indexOf("{"))) as {
        truth?: string;
        status?: string;
        notes?: string[];
        blockers?: string[];
      };

      expect(result.truth).toBe("report_only_not_ui_device_proof");
      expect(result.status).toBe("blocked");
      expect(result.notes).toContain(`resolved_MISSION_ID:${missionId}`);
      expect(result.notes).toContain(`resolved_MOBILE_EVIDENCE:${files.mobile}`);
      expect(result.notes).toContain(`resolved_DESKTOP_EVIDENCE:${files.desktop}`);
      expect(result.notes).toContain(`resolved_SAME_RUN_EVENTS:${files.combinedEvents}`);
      expect(result.blockers).toContain("ui_device_proof_evidence:missing_required_real_evidence_env");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("discovers live write-read bundle files when the bundle directory is passed directly", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-device-readiness-direct-bundle-"));
    try {
      const files = writeLiveWriteReadBundleDir(tempDir);
      const bundleDir = join(tempDir, "bundle");

      const stdout = execFileSync("bash", [
        "scripts/ops/friday-ui-device-proof-readiness.sh",
        "--evidence-dir",
        bundleDir,
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      const result = JSON.parse(stdout.slice(stdout.indexOf("{"))) as {
        truth?: string;
        status?: string;
        notes?: string[];
        blockers?: string[];
      };

      expect(result.truth).toBe("report_only_not_ui_device_proof");
      expect(result.status).toBe("blocked");
      expect(result.notes).toContain(`resolved_MISSION_ID:${missionId}`);
      expect(result.notes).toContain(`resolved_MOBILE_EVIDENCE:${files.mobile}`);
      expect(result.notes).toContain(`resolved_DESKTOP_EVIDENCE:${files.desktop}`);
      expect(result.notes).toContain(`resolved_SAME_RUN_EVENTS:${files.combinedEvents}`);
      expect(result.blockers).toContain("ui_device_proof_evidence:missing_required_real_evidence_env");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("writes a gap report from discovered same-run events without treating it as proof", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-device-readiness-gap-"));
    try {
      writePartialEvidenceDir(tempDir);

      const stdout = execFileSync("bash", [
        "scripts/ops/friday-ui-device-proof-readiness.sh",
        "--evidence-dir",
        tempDir,
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      const result = JSON.parse(stdout.slice(stdout.indexOf("{"))) as {
        truth?: string;
        status?: string;
        notes?: string[];
        blockers?: string[];
      };

      expect(result.truth).toBe("report_only_not_ui_device_proof");
      expect(result.status).toBe("blocked");
      expect(result.blockers).toContain("ui_device_proof_evidence:missing_required_real_evidence_env");
      expect(result.notes?.some((note) => note.includes("ui_device_gap_report:gaps_present"))).toBe(true);

      const gapReport = JSON.parse(readFileSync(join(tempDir, "gap-report.json"), "utf8")) as {
        truth?: string;
        status?: string;
        gaps?: { missingObservations?: Array<{ surface?: string; event?: string }> };
      };
      expect(gapReport.truth).toBe("ui_device_proof_gap_report_not_proof");
      expect(gapReport.status).toBe("gaps_present");
      expect(gapReport.gaps?.missingObservations).toContainEqual({
        surface: "channel",
        event: "same_mission_projection_visible",
        preferredCapture: "channel",
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("discovers indexed channel and timeline evidence without satisfying UI proof", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-device-readiness-indexed-roles-"));
    try {
      const files = writeIndexedChannelTimelineEvidenceDir(tempDir);

      const stdout = execFileSync("bash", [
        "scripts/ops/friday-ui-device-proof-readiness.sh",
        "--evidence-dir",
        tempDir,
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      const result = JSON.parse(stdout.slice(stdout.indexOf("{"))) as {
        truth?: string;
        status?: string;
        notes?: string[];
        blockers?: string[];
      };

      expect(result.truth).toBe("report_only_not_ui_device_proof");
      expect(result.status).toBe("blocked");
      expect(result.notes).toContain(`resolved_CHANNEL_EVIDENCE:${files.channel}`);
      expect(result.notes).toContain(`resolved_TIMELINE_EVIDENCE:${files.timeline}`);
      expect(result.notes).toContain(`resolved_SAME_RUN_EVENTS:${files.events}`);
      expect(result.notes?.some((note) => note.includes("ui_device_gap_report:gaps_present"))).toBe(true);
      expect(result.blockers).toContain("ui_device_proof_evidence:missing_required_real_evidence_env");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("discovers design action runtime evidence bundle indexes without downgrading UI proof truth", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-device-readiness-action-bundle-"));
    try {
      writePartialEvidenceDir(tempDir);
      const contract = writeDesignActionContract(tempDir);
      const bundle = writeDesignActionRuntimeBundleDir(tempDir);

      const stdout = execFileSync("bash", [
        "scripts/ops/friday-ui-device-proof-readiness.sh",
        "--evidence-dir",
        tempDir,
        "--design-action-contract",
        contract,
        "--design-action-runtime-evidence-dir",
        bundle.bundleDir,
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      const result = JSON.parse(stdout.slice(stdout.indexOf("{"))) as {
        truth?: string;
        status?: string;
        notes?: string[];
        blockers?: string[];
      };

      expect(result.truth).toBe("report_only_not_ui_device_proof");
      expect(result.status).toBe("blocked");
      expect(result.blockers).toContain("ui_device_proof_evidence:missing_required_real_evidence_env");
      expect(result.notes?.some((note) => note.includes("design_action_runtime_gap:runtime_actions_covered"))).toBe(true);

      const actionReport = JSON.parse(readFileSync(join(tempDir, "design-action-runtime-gap.json"), "utf8")) as {
        status?: string;
        runtimeEvidenceInputs?: string[];
        counts?: {
          missingRuntimeEvidence?: number;
          missingUniqueRuntimeEvidence?: number;
        };
      };
      expect(actionReport.status).toBe("runtime_actions_covered");
      expect(actionReport.runtimeEvidenceInputs).toEqual(expect.arrayContaining([
        bundle.mobileRuntime,
        bundle.desktopRuntime,
      ]));
      expect(actionReport.counts?.missingRuntimeEvidence).toBe(0);
      expect(actionReport.counts?.missingUniqueRuntimeEvidence).toBe(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("passes supporting proofs into the gap report without satisfying UI device proof", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-device-readiness-supporting-"));
    try {
      writePartialEvidenceDir(tempDir);
      const proofs = writeSupportingProofs(tempDir);

      const stdout = execFileSync("bash", [
        "scripts/ops/friday-ui-device-proof-readiness.sh",
        "--evidence-dir",
        tempDir,
        "--backend-live-proof",
        proofs.backend,
        "--channel-live-proof",
        proofs.channel,
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      const result = JSON.parse(stdout.slice(stdout.indexOf("{"))) as {
        truth?: string;
        status?: string;
        notes?: string[];
        blockers?: string[];
      };

      expect(result.truth).toBe("report_only_not_ui_device_proof");
      expect(result.status).toBe("blocked");
      expect(result.notes).toContain(`resolved_BACKEND_LIVE_PROOF:${proofs.backend}`);
      expect(result.notes).toContain(`resolved_CHANNEL_LIVE_PROOF:${proofs.channel}`);
      expect(result.blockers).toContain("ui_device_proof_evidence:missing_required_real_evidence_env");

      const gapReport = JSON.parse(readFileSync(join(tempDir, "gap-report.json"), "utf8")) as {
        status?: string;
        supportingProofs?: Array<{ role?: string; status?: string; countsTowardUiDeviceProof?: boolean }>;
      };
      expect(gapReport.status).toBe("gaps_present");
      expect(gapReport.supportingProofs).toContainEqual(expect.objectContaining({
        role: "backendLiveProof",
        status: "usable_precondition_not_ui_device_evidence",
        countsTowardUiDeviceProof: false,
      }));
      expect(gapReport.supportingProofs).toContainEqual(expect.objectContaining({
        role: "channelLiveProof",
        status: "usable_precondition_not_ui_device_evidence",
        countsTowardUiDeviceProof: false,
      }));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("auto-discovers supporting proof artifacts from the evidence dir without counting them as UI proof", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-device-readiness-supporting-auto-"));
    try {
      writePartialEvidenceDir(tempDir);
      const proofs = writeSupportingProofs(tempDir);

      const stdout = execFileSync("bash", [
        "scripts/ops/friday-ui-device-proof-readiness.sh",
        "--evidence-dir",
        tempDir,
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      const result = JSON.parse(stdout.slice(stdout.indexOf("{"))) as {
        truth?: string;
        status?: string;
        notes?: string[];
        blockers?: string[];
      };

      expect(result.truth).toBe("report_only_not_ui_device_proof");
      expect(result.status).toBe("blocked");
      expect(result.notes).toContain(`resolved_BACKEND_LIVE_PROOF:${proofs.backend}`);
      expect(result.notes).toContain(`resolved_CHANNEL_LIVE_PROOF:${proofs.channel}`);
      expect(result.notes).toContain(`resolved_OBJECTIVE_COVERAGE:${proofs.objective}`);
      expect(result.blockers).toContain("ui_device_proof_evidence:missing_required_real_evidence_env");

      const gapReport = JSON.parse(readFileSync(join(tempDir, "gap-report.json"), "utf8")) as {
        status?: string;
        supportingProofs?: Array<{ role?: string; status?: string; countsTowardUiDeviceProof?: boolean }>;
      };
      expect(gapReport.status).toBe("gaps_present");
      expect(gapReport.supportingProofs).toContainEqual(expect.objectContaining({
        role: "backendLiveProof",
        status: "usable_precondition_not_ui_device_evidence",
        countsTowardUiDeviceProof: false,
      }));
      expect(gapReport.supportingProofs).toContainEqual(expect.objectContaining({
        role: "channelLiveProof",
        status: "usable_precondition_not_ui_device_evidence",
        countsTowardUiDeviceProof: false,
      }));
      expect(gapReport.supportingProofs).toContainEqual(expect.objectContaining({
        role: "objectiveCoverage",
        status: "usable_precondition_not_ui_device_evidence",
        countsTowardUiDeviceProof: false,
      }));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("bridges redacted channel proof into same-run events without treating it as UI proof", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-device-readiness-channel-bridge-"));
    try {
      const files = writePartialEvidenceDir(tempDir);
      const channelProof = writeRedactedChannelProof(tempDir);

      const stdout = execFileSync("bash", [
        "scripts/ops/friday-ui-device-proof-readiness.sh",
        "--evidence-dir",
        tempDir,
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      const result = JSON.parse(stdout.slice(stdout.indexOf("{"))) as {
        truth?: string;
        status?: string;
        notes?: string[];
        blockers?: string[];
      };

      expect(result.truth).toBe("report_only_not_ui_device_proof");
      expect(result.status).toBe("blocked");
      expect(result.notes).toContain(`resolved_CHANNEL_LIVE_PROOF:${channelProof}`);
      expect(result.notes?.some((note) => note.includes("channel_proof_events_bridge:ready"))).toBe(true);
      expect(result.notes?.some((note) => note.includes("channel_proof_events_merge:ready"))).toBe(true);
      expect(result.notes?.some((note) => note.includes("resolved_SAME_RUN_EVENTS") && note.includes("same-run-events.with-channel.jsonl"))).toBe(true);
      expect(result.blockers).toContain("ui_device_proof_evidence:missing_required_real_evidence_env");

      const rows = readFileSync(join(tempDir, "same-run-events.with-channel.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { surface?: string; event?: string; evidence_ref?: string });
      expect(rows).toContainEqual(expect.objectContaining({
        surface: "channel",
        event: "same_mission_projection_visible",
        evidence_ref: files.channel,
      }));
      expect(rows).toContainEqual(expect.objectContaining({
        surface: "channel",
        event: "channel_replay_blocked_visible",
        evidence_ref: files.channel,
      }));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("derives diagnostic events from a preflighted workbench snapshot without assembling proof", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-device-readiness-workbench-"));
    try {
      writeWorkbenchSnapshotEvidenceDir(tempDir);

      const stdout = execFileSync("bash", [
        "scripts/ops/friday-ui-device-proof-readiness.sh",
        "--evidence-dir",
        tempDir,
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      const result = JSON.parse(stdout.slice(stdout.indexOf("{"))) as {
        truth?: string;
        status?: string;
        notes?: string[];
        blockers?: string[];
      };

      expect(result.truth).toBe("report_only_not_ui_device_proof");
      expect(result.status).toBe("blocked");
      expect(result.blockers).toContain("ui_device_proof_evidence:missing_required_real_evidence_env");
      expect(result.notes?.some((note) => note.includes("workbench_snapshot_events_bridge:ready"))).toBe(true);
      expect(result.notes?.some((note) => note.includes("ui_device_gap_report:gaps_present"))).toBe(true);

      const rows = readFileSync(join(tempDir, "workbench-derived-events.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { surface?: string; event?: string });
      expect(rows).toContainEqual(expect.objectContaining({
        surface: "desktop",
        event: "mission_workbench_visible",
      }));
      expect(rows).not.toContainEqual(expect.objectContaining({
        event: "pressure_20_50_consecutive_asks_visible",
      }));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("merges workbench-derived events with discovered same-run events instead of replacing them", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-device-readiness-merge-"));
    try {
      writePartialEvidenceDir(tempDir);
      writeFileSync(join(tempDir, "workbench-snapshot.json"), JSON.stringify({ snapshot: makeWorkbenchSnapshot() }, null, 2));

      const stdout = execFileSync("bash", [
        "scripts/ops/friday-ui-device-proof-readiness.sh",
        "--evidence-dir",
        tempDir,
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      const result = JSON.parse(stdout.slice(stdout.indexOf("{"))) as {
        notes?: string[];
      };

      expect(result.notes?.some((note) => note.includes("workbench_snapshot_events_bridge:ready"))).toBe(true);
      expect(result.notes?.some((note) => note.includes("workbench_snapshot_events_merge:ready"))).toBe(true);
      expect(result.notes?.some((note) => note.includes("resolved_SAME_RUN_EVENTS") && note.includes("same-run-events.merged.jsonl"))).toBe(true);

      const rows = readFileSync(join(tempDir, "same-run-events.merged.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { event?: string });
      expect(rows).toContainEqual(expect.objectContaining({ event: "proof_receipt_visible_before_done" }));
      expect(rows).toContainEqual(expect.objectContaining({ event: "mission_workbench_visible" }));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("can derive a workbench snapshot from an explicit read-only Rust DB path", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-ui-device-readiness-workbench-db-"));
    try {
      writePartialEvidenceDir(tempDir);
      const fakeBin = join(tempDir, "bin");
      const fakeDb = join(tempDir, "rust-hub.sqlite");
      const fakeCargo = join(fakeBin, "cargo");
      mkdirSync(fakeBin);
      writeFileSync(fakeDb, "not-empty");
      writeFileSync(fakeCargo, `#!/usr/bin/env bash
set -euo pipefail
cat <<'JSON'
${JSON.stringify({ snapshot: makeWorkbenchSnapshot() }, null, 2)}
JSON
`);
      chmodSync(fakeCargo, 0o755);

      const stdout = execFileSync("bash", [
        "scripts/ops/friday-ui-device-proof-readiness.sh",
        "--evidence-dir",
        tempDir,
        "--workbench-db",
        fakeDb,
      ], {
        cwd: process.cwd(),
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
        encoding: "utf8",
      });
      const result = JSON.parse(stdout.slice(stdout.indexOf("{"))) as {
        notes?: string[];
        blockers?: string[];
      };

      expect(result.notes).toContain(`workbench_snapshot_cli:ready:${join(tempDir, "workbench-snapshot.json")}`);
      expect(result.notes?.some((note) => note.includes("workbench_snapshot_events_merge:ready"))).toBe(true);
      expect(result.blockers).toContain("ui_device_proof_evidence:missing_required_real_evidence_env");

      const rows = readFileSync(join(tempDir, "same-run-events.merged.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { event?: string });
      expect(rows).toContainEqual(expect.objectContaining({ event: "mission_workbench_visible" }));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
