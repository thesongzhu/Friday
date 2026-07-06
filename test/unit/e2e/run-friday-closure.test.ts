import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import fs from "node:fs";

import {
  buildDependentClosureBlockerDetails,
  buildClosureProviderCreateRequest,
  assertClosureProviderValidationReady,
  closeWritableStream,
  createLedger,
  describeCommandFailure,
  markInterruptedClosureLedger,
  persistLedger,
  runStep,
  stopManagedChildProcess,
  writeClosureRustProvidersDetectBridgeBin,
  writeClosureRustWorkflowCatalogBridgeBin,
  writeClosureRustWorkflowRunBridgeBins,
} from "../../../scripts/e2e/run-friday-closure.mjs";
import {
  buildClosureScratchEnv,
  FRIDAY_CLOSURE_STATUSES,
} from "../../../scripts/e2e/friday-closure-lib.mjs";

describe("run-friday-closure helpers", () => {
  it("keeps closure provider env refs out of scratch secret storage", () => {
    const request = buildClosureProviderCreateRequest({
      kind: "openai",
      name: "Closure OpenAI",
      baseUrl: "https://api.openai.com",
      api: "openai-responses",
      envVar: "OPENAI_API_KEY",
      supportedModels: ["gpt-4o-mini", "gpt-4o"],
      defaultModel: "gpt-4o-mini",
    });

    expect(request).toMatchObject({
      kind: "openai",
      name: "Closure OpenAI",
      baseUrl: "https://api.openai.com",
      authMode: "bearer-token",
      api: "openai-responses",
      apiKey: "$OPENAI_API_KEY",
      supportedModels: ["gpt-4o-mini", "gpt-4o"],
      defaultModel: "gpt-4o-mini",
      enabled: true,
      validateOnSave: false,
      preserveEnvRef: true,
    });
    expect(JSON.stringify(request)).not.toContain("sk-");
  });

  it("uses provider-catalog auth modes for closure HTTP providers", () => {
    expect(buildClosureProviderCreateRequest({
      kind: "deepseek",
      name: "Closure DeepSeek",
      baseUrl: "https://api.deepseek.com",
      api: "openai-completions",
      envVar: "DEEPSEEK_API_KEY",
      supportedModels: ["deepseek-chat"],
      defaultModel: "deepseek-chat",
    }).authMode).toBe("bearer-token");

    expect(buildClosureProviderCreateRequest({
      kind: "anthropic",
      name: "Closure Anthropic",
      baseUrl: "https://api.anthropic.com",
      api: "anthropic-messages",
      envVar: "ANTHROPIC_API_KEY",
      supportedModels: ["claude-sonnet-4-6"],
      defaultModel: "claude-sonnet-4-6",
    }).authMode).toBe("api-key");
  });

  it("closeWritableStream flushes and closes a write stream", async () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-closure-stream-"));
    const filePath = join(dir, "stream.log");
    const stream = fs.createWriteStream(filePath, { flags: "w" });
    stream.write("hello");
    stream.write(" world");

    await closeWritableStream(stream, 2_000);

    expect(readFileSync(filePath, "utf8")).toBe("hello world");
    expect(stream.writableEnded || stream.closed || stream.destroyed).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });

  it("stopManagedChildProcess escalates to SIGKILL when a child ignores SIGTERM", async () => {
    const child = spawn(process.execPath, [
      "-e",
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
    ], {
      stdio: "ignore",
    });

    await stopManagedChildProcess(child, { graceMs: 150, forceKillMs: 150 });

    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it("writes a closure-local Rust workflow catalog bridge wrapper", () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-closure-rust-bin-"));
    const binPath = join(dir, "bin", "hub_workflow_catalog");

    writeClosureRustWorkflowCatalogBridgeBin(binPath);

    const script = readFileSync(binPath, "utf8");
    expect(script).toContain("cargo run -q -p friday-hub --bin hub_workflow_catalog");
    expect(script).toContain('exec cargo run -q -p friday-hub --bin hub_workflow_catalog -- "$@"');
    expect(fs.statSync(binPath).mode & 0o111).not.toBe(0);

    rmSync(dir, { recursive: true, force: true });
  });

  it("writes closure-local Rust workflow run bridge wrappers", () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-closure-rust-run-bin-"));
    const runBinPath = join(dir, "bin", "hub_workflow_run");
    const readbackBinPath = join(dir, "bin", "hub_workflow_run_readback");

    writeClosureRustWorkflowRunBridgeBins(runBinPath, readbackBinPath);

    const runScript = readFileSync(runBinPath, "utf8");
    const readbackScript = readFileSync(readbackBinPath, "utf8");
    expect(runScript).toContain('exec cargo run -q -p friday-hub --bin hub_workflow_run -- "$@"');
    expect(readbackScript).toContain('exec cargo run -q -p friday-hub --bin hub_workflow_run_readback -- "$@"');
    expect(fs.statSync(runBinPath).mode & 0o111).not.toBe(0);
    expect(fs.statSync(readbackBinPath).mode & 0o111).not.toBe(0);

    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a closure-local Rust providers-detect bridge wrapper", () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-closure-provider-detect-bin-"));
    const binPath = join(dir, "bin", "hub_providers_detect");

    writeClosureRustProvidersDetectBridgeBin(binPath);

    const script = readFileSync(binPath, "utf8");
    expect(script).toContain("cargo run -q -p friday-hub --bin hub_providers_detect");
    expect(script).toContain('exec cargo run -q -p friday-hub --bin hub_providers_detect -- "$@"');
    expect(fs.statSync(binPath).mode & 0o111).not.toBe(0);

    rmSync(dir, { recursive: true, force: true });
  });

  it("routes closure CLI skill runs through the governed Rust runner instead of the retired TS sink", () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-closure-skill-run-env-"));
    const paths = {
      state: join(dir, "state"),
      skills: join(dir, "skills"),
      artifacts: join(dir, "artifacts"),
    };

    const env = buildClosureScratchEnv({}, paths);

    expect(env.FRIDAY_ROUTE_SKILL_RUNS_VIA_RUST).toBe("1");
    expect(env.FRIDAY_D21_SKILL_RUN_LOCAL_BIN).toBe(join(paths.state, "bin", "hub_skill_run_local"));
    expect(env.FRIDAY_D21_SKILL_RUN_LOCAL_DB_PATH).toBe(join(paths.state, "friday.db"));
    expect(env.FRIDAY_D21_OPERATOR_VK_PATH).toBe(join(paths.state, "operator.vk"));
    expect(env.FRIDAY_D21_SKILL_RUN_APPROVAL_JSON).toBe(join(paths.state, "skill-run-approval.json"));
    expect(env.FRIDAY_D21_SKILL_RUN_MISSION_ID).toBe("mission-closure-cli-skill-run");
    expect(env.FRIDAY_D21_SKILL_RUN_WORK_ITEM_ID).toBe("work-closure-cli-skill-run");
    expect(env.FRIDAY_D21_SKILL_RUN_OPERATOR_PRINCIPAL_ID).toBe("operator");
    expect(env.FRIDAY_D21_APPROVED_FIRST_RUN_SKILL_IDS).toBe("output-current-date-time");

    rmSync(dir, { recursive: true, force: true });
  });

  it("records Rust capability-doctor proof-only validation as a retired provider probe gap", () => {
    expect(() => assertClosureProviderValidationReady({
      ok: true,
      data: {
        truthLabel: "rust_capability_doctor",
        proofOnly: true,
        keyValidationProbed: false,
        keyValidation: null,
      },
    })).toThrow(/TS_RUNTIME_PROVIDER_PROBE_RETIRED/);
  });

  it("runStep persists an in-progress active step before completion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-closure-ledger-"));
    const paths = {
      runId: "test-run",
      root: dir,
      state: join(dir, "state"),
      skills: join(dir, "skills"),
      artifacts: join(dir, "artifacts"),
      logs: join(dir, "logs"),
      exports: join(dir, "exports"),
      responses: join(dir, "responses"),
      transcripts: join(dir, "transcripts"),
    };
    for (const value of Object.values(paths)) {
      if (typeof value === "string") {
        fs.mkdirSync(value, { recursive: true });
      }
    }

    const ledger = createLedger(paths);
    persistLedger(ledger);

    let runningSnapshot = null;
    await runStep(ledger, {
      id: "local.backstop.release-verify",
      stage: "local.backstop",
      description: "Run npm run release:verify as a closure backstop",
    }, async () => {
      runningSnapshot = JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8"));
      return { status: FRIDAY_CLOSURE_STATUSES.PASS };
    });

    expect(runningSnapshot?.activeStep?.id).toBe("local.backstop.release-verify");
    expect(runningSnapshot?.entries?.at(-1)?.status).toBe(FRIDAY_CLOSURE_STATUSES.RUNNING);

    const finalSnapshot = JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8"));
    expect(finalSnapshot.activeStep).toBeNull();
    expect(finalSnapshot.entries.at(-1)?.status).toBe(FRIDAY_CLOSURE_STATUSES.PASS);
    expect(finalSnapshot.entries.at(-1)?.completedAt).toBeTruthy();

    rmSync(dir, { recursive: true, force: true });
  });

  it("marks a stale running ledger entry as interrupted", () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-closure-stale-ledger-"));
    const paths = {
      runId: "stale-run",
      root: dir,
      state: join(dir, "state"),
      skills: join(dir, "skills"),
      artifacts: join(dir, "artifacts"),
      logs: join(dir, "logs"),
      exports: join(dir, "exports"),
      responses: join(dir, "responses"),
      transcripts: join(dir, "transcripts"),
    };
    for (const value of Object.values(paths)) {
      if (typeof value === "string") {
        fs.mkdirSync(value, { recursive: true });
      }
    }

    const ledger = createLedger(paths);
    ledger.activeStep = {
      id: "local.preflight.install",
      stage: "local.preflight",
      description: "Install workspace dependencies with npm ci",
      startedAt: new Date("2026-04-02T05:51:07.490Z").toISOString(),
    };
    ledger.entries.push({
      id: "local.preflight.install",
      stage: "local.preflight",
      description: "Install workspace dependencies with npm ci",
      startedAt: new Date("2026-04-02T05:51:07.490Z").toISOString(),
      completedAt: null,
      durationMs: 0,
      status: FRIDAY_CLOSURE_STATUSES.RUNNING,
      evidence: {},
      details: {},
    });
    persistLedger(ledger);

    markInterruptedClosureLedger({
      pid: 424242,
      ledgerPath: join(dir, "ledger.json"),
    });

    const snapshot = JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8"));
    expect(snapshot.activeStep).toBeNull();
    expect(snapshot.completedAt).toBeTruthy();
    expect(snapshot.entries.at(-1)?.status).toBe(FRIDAY_CLOSURE_STATUSES.FAIL);
    expect(snapshot.entries.at(-1)?.details?.interrupted).toBe(true);
    expect(snapshot.verdict).toBe("NO-GO");

    rmSync(dir, { recursive: true, force: true });
  });

  it("records retired CLI command failures as gaps without leaking command output or making them pass", async () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-closure-cli-gap-"));
    const paths = {
      runId: "cli-gap-run",
      root: dir,
      state: join(dir, "state"),
      skills: join(dir, "skills"),
      artifacts: join(dir, "artifacts"),
      logs: join(dir, "logs"),
      exports: join(dir, "exports"),
      responses: join(dir, "responses"),
      transcripts: join(dir, "transcripts"),
    };
    for (const value of Object.values(paths)) {
      if (typeof value === "string") {
        fs.mkdirSync(value, { recursive: true });
      }
    }

    const failureMessage = describeCommandFailure({
      description: "friday run output-current-date-time",
      code: 1,
      output: [
        "Fatal error: FridayDomainError: Skill run execution is fail-closed",
        "code: 'TS_RUNTIME_SKILL_RUNS_RETIRED'",
        "super-secret-output-that-must-not-enter-ledger",
      ].join("\n"),
    });
    expect(failureMessage).toContain("TS_RUNTIME_SKILL_RUNS_RETIRED");
    expect(failureMessage).not.toContain("super-secret-output-that-must-not-enter-ledger");

    const ledger = createLedger(paths);
    persistLedger(ledger);
    await runStep(ledger, {
      id: "local.cli.convert-import-pack-run",
      stage: "local.cli",
      description: "Exercise friday convert/import/pack/run through the compiled CLI",
    }, async () => {
      throw new Error(failureMessage);
    });

    const snapshot = JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8"));
    const entry = snapshot.entries.at(-1);
    expect(entry.status).toBe(FRIDAY_CLOSURE_STATUSES.FAIL);
    expect(entry.details.recordedGap).toMatchObject({
      status: "recorded-gap",
      reason: "ts_runtime_retired_fail_closed",
      code: "TS_RUNTIME_SKILL_RUNS_RETIRED",
      notPass: true,
    });
    expect(entry.details.recordedGap.manifestSurfaceIds).toContain("skills_run");
    expect(snapshot.verdict).toBe("NO-GO");

    rmSync(dir, { recursive: true, force: true });
  });

  it("records unavailable provider entitlement failures as gaps without making them pass", async () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-closure-provider-gap-"));
    const paths = {
      runId: "provider-gap-run",
      root: dir,
      state: join(dir, "state"),
      skills: join(dir, "skills"),
      artifacts: join(dir, "artifacts"),
      logs: join(dir, "logs"),
      exports: join(dir, "exports"),
      responses: join(dir, "responses"),
      transcripts: join(dir, "transcripts"),
    };
    for (const value of Object.values(paths)) {
      if (typeof value === "string") {
        fs.mkdirSync(value, { recursive: true });
      }
    }

    const ledger = createLedger(paths);
    persistLedger(ledger);
    await runStep(ledger, {
      id: "local.uix.templates",
      stage: "local.uix",
      description: "List and execute every assistant template plus the guided wizard",
    }, async () => {
      throw new Error(
        "Template generate-skill failed: "
        + JSON.stringify({
          ok: false,
          error: {
            code: "PROVIDER_NO_CANDIDATES",
            message: "No enabled providers available for routing: defaultProviderId validation failed: Authentication failed",
            retryable: false,
          },
        }),
      );
    });

    const snapshot = JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8"));
    const entry = snapshot.entries.at(-1);
    expect(entry.status).toBe(FRIDAY_CLOSURE_STATUSES.FAIL);
    expect(entry.details.recordedGap).toMatchObject({
      status: "recorded-gap",
      reason: "provider_entitlement_unavailable_fail_closed",
      code: "PROVIDER_NO_CANDIDATES",
      acceptanceGroupId: "provider_entitlement_matrix",
      notPass: true,
    });
    expect(snapshot.verdict).toBe("NO-GO");

    rmSync(dir, { recursive: true, force: true });
  });

  it("records deploy-export blockers as dependent gaps when workflow generation is already recorded", () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-closure-dependent-gap-"));
    const paths = {
      runId: "dependent-gap-run",
      root: dir,
      state: join(dir, "state"),
      skills: join(dir, "skills"),
      artifacts: join(dir, "artifacts"),
      logs: join(dir, "logs"),
      exports: join(dir, "exports"),
      responses: join(dir, "responses"),
      transcripts: join(dir, "transcripts"),
    };
    for (const value of Object.values(paths)) {
      if (typeof value === "string") {
        fs.mkdirSync(value, { recursive: true });
      }
    }

    const ledger = createLedger(paths);
    ledger.entries.push({
      id: "local.workflows.generator",
      stage: "local.workflows",
      description: "Generate, approve, and run a workflow through Friday's public workflow generator API",
      startedAt: new Date("2026-07-06T09:00:00.000Z").toISOString(),
      completedAt: new Date("2026-07-06T09:00:01.000Z").toISOString(),
      durationMs: 1000,
      status: FRIDAY_CLOSURE_STATUSES.FAIL,
      evidence: {},
      details: {
        recordedGap: {
          status: "recorded-gap",
          reason: "ts_runtime_retired_fail_closed",
          code: "TS_RUNTIME_WORKFLOW_GENERATOR_RETIRED",
          manifestSurfaceIds: ["workflows_generator_sessions_create"],
          notPass: true,
        },
      },
    });

    const details = buildDependentClosureBlockerDetails(
      ledger,
      "local.workflows.generator",
      "No generated workflow session is available for deploy/export template execution",
    );

    expect(details).toMatchObject({
      reason: "No generated workflow session is available for deploy/export template execution",
      upstreamEntryId: "local.workflows.generator",
      recordedGap: {
        status: "recorded-gap",
        reason: "dependent_recorded_gap_fail_closed",
        code: "DEPENDENT_ON_TS_RUNTIME_WORKFLOW_GENERATOR_RETIRED",
        upstreamCode: "TS_RUNTIME_WORKFLOW_GENERATOR_RETIRED",
        notPass: true,
      },
    });
    expect(details.recordedGap.manifestSurfaceIds).toContain("workflows_generator_sessions_create");

    rmSync(dir, { recursive: true, force: true });
  });
});
