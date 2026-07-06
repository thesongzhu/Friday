import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import fs from "node:fs";

import {
  buildClosureProviderCreateRequest,
  closeWritableStream,
  createLedger,
  describeCommandFailure,
  markInterruptedClosureLedger,
  persistLedger,
  runStep,
  stopManagedChildProcess,
} from "../../../scripts/e2e/run-friday-closure.mjs";
import { FRIDAY_CLOSURE_STATUSES } from "../../../scripts/e2e/friday-closure-lib.mjs";

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
      authMode: "api-key",
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
});
