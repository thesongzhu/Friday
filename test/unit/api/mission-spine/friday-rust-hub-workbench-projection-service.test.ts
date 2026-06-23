import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createFridayRustHubWorkbenchProjectionService } from "../../../../src/api/mission-spine/friday-rust-hub-workbench-projection-service.js";

describe("friday-rust-hub-workbench-projection-service", () => {
  let scratch: string | undefined;

  afterEach(() => {
    if (scratch) {
      rmSync(scratch, { recursive: true, force: true });
      scratch = undefined;
    }
  });

  function setup(
    mockSource: string | ((paths: { argsPath: string }) => string),
  ): { binPath: string; dbPath: string; argsPath: string } {
    scratch = mkdtempSync(join(tmpdir(), "friday-workbench-projection-"));
    const argsPath = join(scratch, "args.json");
    const binPath = join(scratch, "workbench_projection_mock.mjs");
    const source = typeof mockSource === "function" ? mockSource({ argsPath }) : mockSource;
    writeFileSync(binPath, `#!/usr/bin/env node\n${source}`);
    chmodSync(binPath, 0o755);
    const dbPath = join(scratch, "rust-hub.sqlite");
    writeFileSync(dbPath, "mock");
    return { binPath, dbPath, argsPath };
  }

  function snapshotJSON(missionId = "mission-workbench-test"): string {
    return JSON.stringify({
      missionId,
      fridayConversationId: "fconv-workbench-test",
      runtimeFeedStatus: "live_rust_hub_projection",
      statusLabels: ["stale"],
      duplicatePreflight: {
        status: "none",
        duplicateMissionId: "",
        duplicateWorkItemId: "",
      },
      routeDecision: {
        advisorSummary: "Codex first.",
        selectedRoute: "proof://route-decision/1",
        alternatives: [],
        truthLabel: "friday_owned",
      },
      providerReceiptRefs: ["proof://provider/1"],
      channelReceiptRefs: [],
      workItems: [
        {
          id: "work-provider",
          title: "Provider ack is not done",
          state: "provider_ack",
          owner: "linked_only",
          proofRef: "proof://provider/1",
          done: false,
        },
      ],
      timelinePages: [],
      memoryCandidates: [],
      runOutcomeLearningCandidates: [],
      capabilityStates: [],
      transcriptSections: [],
    });
  }

  it("spawns the adapter with db and mission id args and returns the root snapshot", async () => {
    const { binPath, dbPath, argsPath } = setup(({ argsPath }) => `
      const { writeFileSync } = await import("node:fs");
      writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));
      process.stdout.write(${JSON.stringify(snapshotJSON("mission-explicit"))});
    `);
    const service = createFridayRustHubWorkbenchProjectionService({
      adapterBin: binPath,
      dbPath,
      stateDir: scratch!,
      repoRoot: scratch!,
    });

    const snapshot = await service.getSnapshot({ missionId: "mission-explicit" });

    expect(snapshot.missionId).toBe("mission-explicit");
    expect(snapshot.workItems.at(0)?.state).toBe("provider_ack");
    expect(JSON.parse(readFileSync(argsPath, "utf8"))).toEqual([
      "--db",
      dbPath,
      "--mission-id",
      "mission-explicit",
    ]);
  });

  it("unwraps a nested snapshot payload", async () => {
    const { binPath, dbPath } = setup(`
      process.stdout.write(JSON.stringify({ snapshot: ${snapshotJSON("mission-nested")} }));
    `);
    const service = createFridayRustHubWorkbenchProjectionService({
      adapterBin: binPath,
      dbPath,
      stateDir: scratch!,
      repoRoot: scratch!,
    });

    const snapshot = await service.getSnapshot({});

    expect(snapshot.missionId).toBe("mission-nested");
    expect(snapshot.runtimeFeedStatus).toBe("live_rust_hub_projection");
  });

  it("fails closed before spawning when the hub DB is missing", async () => {
    const { binPath, dbPath, argsPath } = setup(({ argsPath }) => `
      const { writeFileSync } = await import("node:fs");
      writeFileSync(${JSON.stringify(argsPath)}, "spawned");
      process.stdout.write(${JSON.stringify(snapshotJSON())});
    `);
    rmSync(dbPath, { force: true });
    const service = createFridayRustHubWorkbenchProjectionService({
      adapterBin: binPath,
      dbPath,
      stateDir: scratch!,
      repoRoot: scratch!,
    });

    await expect(service.getSnapshot({})).rejects.toMatchObject({
      code: "MISSION_SPINE_WORKBENCH_UNAVAILABLE",
      httpStatus: 503,
    });
    expect(existsSync(argsPath)).toBe(false);
  });

  it("fails closed on adapter child failure", async () => {
    const { binPath, dbPath } = setup(`
      process.stderr.write("workbench adapter unavailable");
      process.exit(2);
    `);
    const service = createFridayRustHubWorkbenchProjectionService({
      adapterBin: binPath,
      dbPath,
      stateDir: scratch!,
      repoRoot: scratch!,
    });

    await expect(service.getSnapshot({})).rejects.toMatchObject({
      code: "MISSION_SPINE_WORKBENCH_UNAVAILABLE",
      httpStatus: 503,
    });
  });

  it("fails closed on malformed or non-object adapter output", async () => {
    const badJson = setup(`process.stdout.write("not-json {");`);
    const badJsonService = createFridayRustHubWorkbenchProjectionService({
      adapterBin: badJson.binPath,
      dbPath: badJson.dbPath,
      stateDir: scratch!,
      repoRoot: scratch!,
    });
    await expect(badJsonService.getSnapshot({})).rejects.toMatchObject({
      code: "MISSION_SPINE_WORKBENCH_UNAVAILABLE",
      httpStatus: 503,
    });

    rmSync(scratch!, { recursive: true, force: true });
    scratch = undefined;
    const nonObject = setup(`process.stdout.write("null");`);
    const nonObjectService = createFridayRustHubWorkbenchProjectionService({
      adapterBin: nonObject.binPath,
      dbPath: nonObject.dbPath,
      stateDir: scratch!,
      repoRoot: scratch!,
    });
    await expect(nonObjectService.getSnapshot({})).rejects.toMatchObject({
      code: "MISSION_SPINE_WORKBENCH_UNAVAILABLE",
      httpStatus: 503,
    });
  });
});
