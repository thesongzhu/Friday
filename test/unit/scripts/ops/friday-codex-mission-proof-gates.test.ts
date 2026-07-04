import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const d8AuditScript = resolve(
  repoRoot,
  "scripts/diagnostics/friday-observe-wrapper-d8-audit.sh",
);
const proofScript = resolve(
  repoRoot,
  "scripts/ops/friday-codex-mission-proof-of-life.sh",
);
const routedProofScript = resolve(
  repoRoot,
  "scripts/ops/friday-proof-of-life.sh",
);
const routedProofKeychainWrapper = resolve(
  repoRoot,
  "scripts/ops/friday-proof-of-life-keychain.sh",
);
const proofMacosWrapper = resolve(
  repoRoot,
  "scripts/ops/friday-codex-mission-proof-of-life-macos-prompt.sh",
);
const proofKeychainWrapper = resolve(
  repoRoot,
  "scripts/ops/friday-codex-mission-proof-of-life-keychain.sh",
);
const organicSpawnScript = resolve(
  repoRoot,
  "scripts/ops/friday-codex-organic-spawn.sh",
);
const organicSpawnKeychainWrapper = resolve(
  repoRoot,
  "scripts/ops/friday-codex-organic-spawn-keychain.sh",
);
const proofProvisionPassphraseScript = resolve(
  repoRoot,
  "scripts/ops/friday-codex-mission-proof-provision-passphrase.sh",
);
const soakScript = resolve(
  repoRoot,
  "scripts/ops/friday-codex-mission-d8-soak.sh",
);
const soakMacosWrapper = resolve(
  repoRoot,
  "scripts/ops/friday-codex-mission-d8-soak-macos-prompt.sh",
);
const soakKeychainWrapper = resolve(
  repoRoot,
  "scripts/ops/friday-codex-mission-d8-soak-keychain.sh",
);

const tempRoots: string[] = [];
const healthServers: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  await Promise.all(
    healthServers.splice(0).map(
      (server) =>
        new Promise<void>((resolveClose) => {
          if (server.exitCode !== null || server.killed) {
            resolveClose();
            return;
          }
          server.once("exit", () => resolveClose());
          server.kill("SIGTERM");
        }),
    ),
  );
  for (const tempRoot of tempRoots.splice(0)) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

function makeTempRoot(): string {
  const tempRoot = mkdtempSync(join(tmpdir(), "friday-codex-proof-gates-"));
  tempRoots.push(tempRoot);
  return tempRoot;
}

async function startHealthServer(): Promise<string> {
  const server = spawn(
    process.execPath,
    [
      "-e",
      `
        const http = require("node:http");
        const server = http.createServer((request, response) => {
          if (request.url === "/v1/health") {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ ok: true, data: { status: "ok" } }));
            return;
          }
          response.writeHead(404);
          response.end();
        });
        server.listen(0, "127.0.0.1", () => {
          console.log(server.address().port);
        });
        process.on("SIGTERM", () => server.close(() => process.exit(0)));
      `,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  healthServers.push(server);
  const port = await new Promise<string>((resolvePort, rejectPort) => {
    let stdout = "";
    let stderr = "";
    server.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const line = stdout
        .split(/\r?\n/)
        .find((value) => /^[0-9]+$/.test(value.trim()));
      if (line) {
        resolvePort(line.trim());
      }
    });
    server.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    server.once("exit", (code) => {
      rejectPort(
        new Error(
          `health server exited before binding: code=${code} stderr=${stderr}`,
        ),
      );
    });
  });
  return `http://127.0.0.1:${port}`;
}

function createD8FixtureDb(
  dbPath: string,
  proofReceipt: string,
  options: {
    addOlderIncompleteSession?: boolean;
    addUnlinkedEvent?: boolean;
    addUnreferencedLedger?: boolean;
    addUnprovedRunInSameSession?: boolean;
    addDuplicateRunSession?: boolean;
    addSecondDistinctRunSession?: boolean;
    addExtraMatchingWorkItemForFirstRun?: boolean;
    addUnrelatedCompletedWorkItem?: boolean;
    addUnqualifiedLinkedSession?: boolean;
    eventObservedAt?: number;
    lastProviderSeenAt?: number;
    ledgerCreatedAt?: number;
    processKind?: string;
    processMatchedClaimId?: string | null;
    processObservedAt?: number;
    processPortBindings?: string[];
    provider?: "codex" | "claude";
    ledgerProviderKind?: string;
    omitSurfaceThread?: boolean;
    surfaceDeliveryRoute?: string;
    surfaceKind?: string;
    surfaceThreadCreatedAt?: number;
    surfaceThreadMissionId?: string | null;
    workspaceClaimKind?: string;
    workspaceClaimWorkItemId?: string;
    workItemUpdatedAt?: number;
    workItemProofReceipts?: string[];
    workItemProvider?: string;
  } = {},
): void {
  const provider = options.provider ?? "codex";
  const syncMode =
    provider === "claude" ? "friday_local_mirror" : "provider_app_server_local";
  const ledgerProviderKind =
    options.ledgerProviderKind ??
    (provider === "claude" ? "anthropic" : "codex");
  const processKind =
    options.processKind ??
    (provider === "claude" ? "claude" : "codex_app_server");
  const processMatchedClaimId =
    options.processMatchedClaimId === undefined
      ? "claim-1"
      : options.processMatchedClaimId;
  const processObservedAt = options.processObservedAt ?? 1000;
  const sessionId = `${provider}-observe-run-1`;
  const processPortBindings =
    options.processPortBindings ??
    (provider === "codex"
      ? ["stdio://codex-app-server", `friday://provider-session/${sessionId}`]
      : ["stdio://claude"]);
  const missionId = "mission-1";
  const conversationId = "fconv-proof-1";
  const surfaceThreadMissionId =
    options.surfaceThreadMissionId === undefined
      ? missionId
      : options.surfaceThreadMissionId;
  const surfaceThreadCreatedAt = options.surfaceThreadCreatedAt ?? 1000;
  const surfaceDeliveryRoute =
    options.surfaceDeliveryRoute ?? "ops://codex-mission-proof-of-life";
  const surfaceKind = options.surfaceKind ?? "mobile";
  const workspaceClaimKind = options.workspaceClaimKind ?? "process";
  const workspaceClaimWorkItemId = options.workspaceClaimWorkItemId ?? "work-1";
  const workItemProvider = options.workItemProvider ?? provider;
  const workItemUpdatedAt = options.workItemUpdatedAt ?? 1000;
  const eventObservedAt = options.eventObservedAt ?? 1000;
  const lastProviderSeenAt = options.lastProviderSeenAt ?? 1000;
  const ledgerCreatedAt = options.ledgerCreatedAt ?? 1000;
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE provider_session_link (
      friday_session_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      sync_mode TEXT NOT NULL,
      last_provider_seen_at INTEGER
    );
    CREATE TABLE provider_session_event (
      friday_session_id TEXT NOT NULL,
      provider_event_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      token_ledger_ref TEXT
    );
    CREATE TABLE token_ledger (
      ledger_id TEXT PRIMARY KEY,
      provider_kind TEXT NOT NULL,
      fallback INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      run_id TEXT
    );
    CREATE TABLE mission (
      mission_id TEXT NOT NULL,
      friday_conversation_id TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE surface_thread (
      surface_thread_id TEXT NOT NULL,
      friday_conversation_id TEXT NOT NULL,
      mission_id TEXT,
      surface_kind TEXT NOT NULL,
      delivery_route TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE work_item (
      work_item_id TEXT NOT NULL,
      mission_id TEXT NOT NULL,
      lane TEXT NOT NULL,
      target_provider_or_agent TEXT,
      status TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      proof_receipts TEXT NOT NULL
    );
    CREATE TABLE workspace_claim (
      claim_id TEXT NOT NULL,
      work_item_id TEXT,
      claim_kind TEXT NOT NULL
    );
    CREATE TABLE process_observation (
      process_kind TEXT NOT NULL,
      ownership_status TEXT NOT NULL,
      observed_at_ms INTEGER NOT NULL,
      matched_claim_id TEXT,
      port_bindings TEXT NOT NULL
    );
  `);
  db.prepare(
    `INSERT INTO provider_session_link
      (friday_session_id, provider, sync_mode, last_provider_seen_at)
      VALUES (?, ?, ?, ?)`,
  ).run(sessionId, provider, syncMode, lastProviderSeenAt);
  db.prepare(
    `INSERT INTO provider_session_event
      (friday_session_id, provider_event_id, provider, observed_at, token_ledger_ref)
      VALUES (?, 'event-1', ?, ?, 'ledger-1')`,
  ).run(sessionId, provider, eventObservedAt);
  db.prepare(
    `INSERT INTO token_ledger
      (ledger_id, provider_kind, fallback, total_tokens, created_at, run_id)
      VALUES ('ledger-1', ?, 0, 12, ?, 'run-1')`,
  ).run(ledgerProviderKind, ledgerCreatedAt);
  db.prepare(
    `INSERT INTO mission
      (mission_id, friday_conversation_id, created_at_ms)
      VALUES (?, ?, 1000)`,
  ).run(missionId, conversationId);
  if (options.omitSurfaceThread !== true) {
    db.prepare(
      `INSERT INTO surface_thread
        (surface_thread_id, friday_conversation_id, mission_id, surface_kind, delivery_route, created_at_ms)
        VALUES ('surface-1', ?, ?, ?, ?, ?)`,
    ).run(
      conversationId,
      surfaceThreadMissionId,
      surfaceKind,
      surfaceDeliveryRoute,
      surfaceThreadCreatedAt,
    );
  }
  db.prepare(
    `INSERT INTO work_item
      (work_item_id, mission_id, lane, target_provider_or_agent, status, updated_at_ms, proof_receipts)
      VALUES ('work-1', ?, ?, ?, 'completed_with_proof', ?, ?)`,
  ).run(
    missionId,
    workItemProvider,
    workItemProvider,
    workItemUpdatedAt,
    JSON.stringify([proofReceipt]),
  );
  if (options.workItemProofReceipts !== undefined) {
    db.prepare(
      `UPDATE work_item SET proof_receipts = ? WHERE work_item_id = 'work-1'`,
    ).run(JSON.stringify(options.workItemProofReceipts));
  }
  db.prepare(
    `INSERT INTO workspace_claim
      (claim_id, work_item_id, claim_kind)
      VALUES ('claim-1', ?, ?)`,
  ).run(workspaceClaimWorkItemId, workspaceClaimKind);
  db.prepare(
    `INSERT INTO process_observation
      (process_kind, ownership_status, observed_at_ms, matched_claim_id, port_bindings)
      VALUES (?, 'friday_owned_claimed', ?, ?, ?)`,
  ).run(
    processKind,
    processObservedAt,
    processMatchedClaimId,
    JSON.stringify(processPortBindings),
  );
  if (options.addOlderIncompleteSession === true) {
    db.prepare(
      `INSERT INTO provider_session_link
        (friday_session_id, provider, sync_mode, last_provider_seen_at)
        VALUES ('codex-observe-run-bad', 'codex', 'provider_app_server_local', 900)`,
    ).run();
  }
  if (options.addUnlinkedEvent === true) {
    db.prepare(
      `INSERT INTO provider_session_event
        (friday_session_id, provider_event_id, provider, observed_at, token_ledger_ref)
        VALUES ('codex-observe-run-1', 'event-unlinked', 'codex', 1001, NULL)`,
    ).run();
  }
  if (options.addUnreferencedLedger === true) {
    db.prepare(
      `INSERT INTO token_ledger
        (ledger_id, provider_kind, fallback, total_tokens, created_at, run_id)
        VALUES ('ledger-unreferenced', 'codex', 0, 5, 1001, 'run-unreferenced')`,
    ).run();
  }
  if (options.addUnprovedRunInSameSession === true) {
    db.prepare(
      `INSERT INTO provider_session_event
        (friday_session_id, provider_event_id, provider, observed_at, token_ledger_ref)
        VALUES (?, 'event-unproved-run', ?, 1001, 'ledger-unproved-run')`,
    ).run(sessionId, provider);
    db.prepare(
      `INSERT INTO token_ledger
        (ledger_id, provider_kind, fallback, total_tokens, created_at, run_id)
        VALUES ('ledger-unproved-run', ?, 0, 8, 1001, 'run-unproved')`,
    ).run(ledgerProviderKind);
  }
  if (options.addDuplicateRunSession === true) {
    db.prepare(
      `INSERT INTO provider_session_link
        (friday_session_id, provider, sync_mode, last_provider_seen_at)
        VALUES ('codex-observe-run-duplicate', 'codex', 'provider_app_server_local', 1002)`,
    ).run();
    db.prepare(
      `INSERT INTO provider_session_event
        (friday_session_id, provider_event_id, provider, observed_at, token_ledger_ref)
        VALUES ('codex-observe-run-duplicate', 'event-duplicate', 'codex', 1002, 'ledger-duplicate')`,
    ).run();
    db.prepare(
      `INSERT INTO token_ledger
        (ledger_id, provider_kind, fallback, total_tokens, created_at, run_id)
        VALUES ('ledger-duplicate', 'codex', 0, 9, 1002, 'run-1')`,
    ).run();
  }
  if (options.addSecondDistinctRunSession === true) {
    db.prepare(
      `INSERT INTO provider_session_link
        (friday_session_id, provider, sync_mode, last_provider_seen_at)
        VALUES ('codex-observe-run-2', 'codex', 'provider_app_server_local', 1002)`,
    ).run();
    db.prepare(
      `INSERT INTO provider_session_event
        (friday_session_id, provider_event_id, provider, observed_at, token_ledger_ref)
        VALUES ('codex-observe-run-2', 'event-2', 'codex', 1002, 'ledger-2')`,
    ).run();
    db.prepare(
      `INSERT INTO token_ledger
        (ledger_id, provider_kind, fallback, total_tokens, created_at, run_id)
        VALUES ('ledger-2', 'codex', 0, 9, 1002, 'run-2')`,
    ).run();
  }
  if (options.addUnrelatedCompletedWorkItem === true) {
    db.prepare(
      `INSERT INTO work_item
        (work_item_id, mission_id, lane, target_provider_or_agent, status, updated_at_ms, proof_receipts)
        VALUES ('work-unrelated', ?, 'codex', 'codex', 'completed_with_proof', 1002, ?)`,
    ).run(missionId, JSON.stringify(["friday://agent-run/unrelated-run"]));
  }
  if (options.addExtraMatchingWorkItemForFirstRun === true) {
    db.prepare(
      `INSERT INTO work_item
        (work_item_id, mission_id, lane, target_provider_or_agent, status, updated_at_ms, proof_receipts)
        VALUES ('work-extra-run-1', ?, 'codex', 'codex', 'completed_with_proof', 1002, ?)`,
    ).run(missionId, JSON.stringify(["friday://agent-run/run-1"]));
  }
  if (options.addUnqualifiedLinkedSession === true) {
    db.prepare(
      `INSERT INTO provider_session_link
        (friday_session_id, provider, sync_mode, last_provider_seen_at)
        VALUES ('codex-link-only-run', 'codex', 'provider_native_link_only', 1002)`,
    ).run();
    db.prepare(
      `INSERT INTO provider_session_event
        (friday_session_id, provider_event_id, provider, observed_at, token_ledger_ref)
        VALUES ('codex-link-only-run', 'event-link-only', 'codex', 1002, 'ledger-link-only')`,
    ).run();
    db.prepare(
      `INSERT INTO token_ledger
        (ledger_id, provider_kind, fallback, total_tokens, created_at, run_id)
        VALUES ('ledger-link-only', 'codex', 0, 7, 1002, 'run-link-only')`,
    ).run();
  }
  db.close();
}

async function runD8Audit(
  dbPath: string,
  requiredSessions = "1",
  extraEnv: Record<string, string> = {},
) {
  const healthUrl = await startHealthServer();
  const rustWsPort = new URL(healthUrl).port;
  return spawnSync("bash", [d8AuditScript], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      FRIDAY_HUB_AGENT_RUN_DB_PATH: dbPath,
      FRIDAY_TS_HUB_URL: healthUrl,
      FRIDAY_D8_AUDIT_RUST_WS_HOST: "127.0.0.1",
      FRIDAY_D8_AUDIT_RUST_WS_PORT: rustWsPort,
      FRIDAY_D8_AUDIT_REQUIRED_SESSIONS: requiredSessions,
      FRIDAY_D8_AUDIT_SINCE_MS: "1",
      FRIDAY_D8_AUDIT_LOG_LINES: "1",
      FRIDAY_TS_STDOUT_LOG: join(makeTempRoot(), "missing-ts-stdout.log"),
      FRIDAY_TS_STDERR_LOG: join(makeTempRoot(), "missing-ts-stderr.log"),
      FRIDAY_RUST_STDOUT_LOG: join(makeTempRoot(), "missing-rust-stdout.log"),
      FRIDAY_RUST_STDERR_LOG: join(makeTempRoot(), "missing-rust-stderr.log"),
      ...extraEnv,
    },
  });
}

describe("Codex mission proof gates", () => {
  it("exposes an organic Codex launcher that requires operator task text", () => {
    const proofSource = readFileSync(proofScript, "utf8");
    const organicSource = readFileSync(organicSpawnScript, "utf8");
    const organicKeychainSource = readFileSync(
      organicSpawnKeychainWrapper,
      "utf8",
    );

    expect(proofSource).toContain(
      'readonly RUN_KIND="${FRIDAY_CODEX_MISSION_PROOF_RUN_KIND:-proof}"',
    );
    expect(proofSource).toContain(
      'readonly MISSION_INTENT="${FRIDAY_CODEX_MISSION_PROOF_INTENT:-What is the proof token? Answer exactly FRIDAY_CODEX_PROOF_OK.}"',
    );
    expect(proofSource).toContain(
      'readonly BODY_REF_PREFIX="friday://body/ops/codex-mission-proof-of-life"',
    );
    expect(proofSource).toContain(
      'readonly BODY_REF="${FRIDAY_CODEX_MISSION_PROOF_BODY_REF:-${BODY_REF_PREFIX}/${WORK_ITEM_ID}}"',
    );
    expect(proofSource).not.toContain(
      'readonly BODY_REF="${FRIDAY_CODEX_MISSION_PROOF_BODY_REF:-friday://body/ops/codex-mission-proof-of-life}"',
    );
    expect(proofSource).toContain("FRIDAY_CODEX_MISSION_PROOF_RUN_KIND must be proof or organic");
    expect(proofSource).toContain(
      "ops://codex-mission-proof-of-life|ops://codex-organic-spawn",
    );
    expect(proofSource).toContain('surface.surface_kind = \'${SURFACE_KIND}\'');
    expect(proofSource).toContain('surface.delivery_route = \'${DELIVERY_ROUTE}\'');
    expect(proofSource).toContain(
      "operator-triggered organic Codex spawn through Friday",
    );

    expect(organicSource).toContain("FRIDAY_CODEX_ORGANIC_TASK");
    expect(organicSource).toContain("Usage: $0 '<operator task for Codex>'");
    expect(organicSource).not.toContain("FRIDAY_OG9_OPERATOR_ORIGIN_ACK");
    expect(organicSource).not.toContain("operator-physical-hand-starts-og9-organic-run");
    expect(organicSource).toContain("FRIDAY_CODEX_ORGANIC_ATTESTATION");
    expect(organicSource).toContain("FRIDAY_CODEX_ORGANIC_ATTESTATION_VERIFY_KEY");
    expect(organicSource).toContain("friday-operator-organic-attestation-verify.mjs");
    expect(organicSource).toContain("FRIDAY_CODEX_MISSION_PROOF_ORGANIC_PROVENANCE");
    expect(organicSource).toContain(
      'export FRIDAY_CODEX_MISSION_PROOF_RUN_KIND="organic"',
    );
    expect(organicSource).toContain(
      'export FRIDAY_CODEX_MISSION_PROOF_DELIVERY_ROUTE="ops://codex-organic-spawn"',
    );
    expect(organicSource).toContain(
      'export FRIDAY_CODEX_MISSION_PROOF_INTENT="${TASK_TEXT}"',
    );
    expect(organicSource).not.toContain("Answer exactly FRIDAY_CODEX_PROOF_OK");

    expect(organicKeychainSource).toContain(
      'readonly ORGANIC_SCRIPT="${SCRIPT_DIR}/friday-codex-organic-spawn.sh"',
    );
    expect(organicKeychainSource).toContain(
      'FRIDAY_CODEX_MISSION_PROOF_PASSPHRASE_STDIN=1 "${ORGANIC_SCRIPT}" "$@"',
    );
    expect(organicKeychainSource).not.toContain("FRIDAY_OG9_OPERATOR_ORIGIN_ACK=");
    expect(organicKeychainSource).toContain(
      'security find-generic-password -a "${KEYCHAIN_ACCOUNT}" -s "${KEYCHAIN_SERVICE}" -w >/dev/null 2>&1',
    );
    expect(organicKeychainSource).toContain("trap 'unset PASSPHRASE' EXIT");
  });

  it("refuses Codex organic launch without a verified operator signature attestation", () => {
    const result = spawnSync(organicSpawnScript, ["operator task"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        FRIDAY_OG9_OPERATOR_ORIGIN_ACK: "operator-physical-hand-starts-og9-organic-run",
        FRIDAY_CODEX_ORGANIC_ATTESTATION: "",
        FRIDAY_CODEX_ORGANIC_ATTESTATION_VERIFY_KEY: "",
      },
    });

    expect(result.status).toBe(4);
    expect(result.stderr).toContain(
      "strict Codex organic launch requires FRIDAY_CODEX_ORGANIC_ATTESTATION",
    );
    expect(result.stderr).toContain("operator signature attestation");
  });

  it("uses one keychain lookup before streaming the passphrase to proof", () => {
    const tempRoot = makeTempRoot();
    const binDir = join(tempRoot, "bin");
    const fakeSecurityCount = join(tempRoot, "security-count");
    const wrapperPath = join(
      tempRoot,
      "friday-codex-mission-proof-of-life-keychain.sh",
    );
    const fakeProofPath = join(
      tempRoot,
      "friday-codex-mission-proof-of-life.sh",
    );
    const fakeSecurityPath = join(binDir, "security");

    mkdirSync(binDir, { recursive: true });
    writeFileSync(wrapperPath, readFileSync(proofKeychainWrapper, "utf8"));
    chmodSync(wrapperPath, 0o700);
    writeFileSync(
      fakeProofPath,
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${FRIDAY_CODEX_MISSION_PROOF_PREFLIGHT_ONLY:-0}" = "1" ]; then
  echo "preflight-ok"
  exit 0
fi
if [ "\${FRIDAY_CODEX_MISSION_PROOF_PASSPHRASE_STDIN:-0}" != "1" ]; then
  echo "missing stdin mode" >&2
  exit 12
fi
IFS= read -r passphrase
printf 'proof-passphrase=%s\\n' "\${passphrase}"
`,
    );
    chmodSync(fakeProofPath, 0o700);
    writeFileSync(
      fakeSecurityPath,
      `#!/usr/bin/env bash
set -euo pipefail
count_file="\${FRIDAY_FAKE_SECURITY_COUNT}"
count=0
if [ -f "\${count_file}" ]; then
  count="$(cat "\${count_file}")"
fi
count="$((count + 1))"
printf '%s\\n' "\${count}" >"\${count_file}"
printf 'keychain-passphrase\\n'
`,
    );
    chmodSync(fakeSecurityPath, 0o700);

    const result = spawnSync("bash", [wrapperPath], {
      cwd: tempRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        FRIDAY_FAKE_SECURITY_COUNT: fakeSecurityCount,
        HOME: tempRoot,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("preflight-ok");
    expect(result.stdout).toContain("proof-passphrase=keychain-passphrase");
    expect(readFileSync(fakeSecurityCount, "utf8").trim()).toBe("1");
  });

  it("D8 audit passes only when a linked session has matching completed WorkItem proof", async () => {
    const tempRoot = makeTempRoot();
    const dbPath = join(tempRoot, "d8-pass.sqlite");
    createD8FixtureDb(dbPath, "friday://agent-run/run-1");

    const result = await runD8Audit(dbPath);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("last_1_completed_proof_sessions=1");
    expect(result.stdout).toContain(
      "last_1_claim_bound_process_proved_sessions=1",
    );
    expect(result.stdout).toContain("last_1_surface_bound_proof_sessions=1");
    expect(result.stdout).toContain("surface_unbound_proof_session_runs=0");
    expect(result.stdout).toContain("PASS - D8 evidence is present");
  });

  it("D8 audit accepts provider events ledger-linked milliseconds after WorkItem completion", async () => {
    const tempRoot = makeTempRoot();
    const dbPath = join(tempRoot, "d8-event-after-workitem.sqlite");
    createD8FixtureDb(dbPath, "friday://agent-run/run-1", {
      eventObservedAt: 1016,
      lastProviderSeenAt: 1016,
      ledgerCreatedAt: 1000,
      workItemUpdatedAt: 1000,
    });

    const result = await runD8Audit(dbPath);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("last_1_completed_proof_sessions=1");
    expect(result.stdout).toContain(
      "last_1_claim_bound_process_proved_sessions=1",
    );
    expect(result.stdout).toContain("unproved_linked_session_runs=0");
    expect(result.stdout).toContain("PASS - D8 evidence is present");
  });

  it("D8 audit rejects completed WorkItem proof without a bound Mission SurfaceThread", async () => {
    const tempRoot = makeTempRoot();
    const dbPath = join(tempRoot, "d8-proof-without-surface-thread.sqlite");
    createD8FixtureDb(dbPath, "friday://agent-run/run-1", {
      omitSurfaceThread: true,
    });

    const result = await runD8Audit(dbPath);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("last_1_completed_proof_sessions=1");
    expect(result.stdout).toContain("last_1_surface_bound_proof_sessions=0");
    expect(result.stdout).toContain("surface_unbound_proof_session_runs=1");
    expect(result.stdout).toContain(
      "last 1 linked provider sessions do not all have surface-bound WorkItem proofs",
    );
    expect(result.stdout).toContain(
      "ledger-linked Codex/Claude session runs have proof without a bound Mission SurfaceThread",
    );
  });

  it("D8 audit can print recent scoped session details without changing fail-closed behavior", async () => {
    const tempRoot = makeTempRoot();
    const dbPath = join(tempRoot, "d8-detail-without-surface-thread.sqlite");
    createD8FixtureDb(dbPath, "friday://agent-run/run-1", {
      omitSurfaceThread: true,
    });

    const result = await runD8Audit(dbPath, "1", {
      FRIDAY_D8_AUDIT_DETAIL_LIMIT: "1",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Recent scoped session details (diagnostic only; PASS criteria unchanged):");
    expect(result.stdout).toContain("provider=codex");
    expect(result.stdout).toContain("completed_proof_runs=1");
    expect(result.stdout).toContain("surface_bound_runs=0");
    expect(result.stdout).toContain("claim_bound_process=1");
  });

  it("D8 audit rejects completed WorkItem proof bound to a non-mobile SurfaceThread", async () => {
    const tempRoot = makeTempRoot();
    const dbPath = join(
      tempRoot,
      "d8-proof-with-non-mobile-surface-thread.sqlite",
    );
    createD8FixtureDb(dbPath, "friday://agent-run/run-1", {
      surfaceKind: "desktop",
    });

    const result = await runD8Audit(dbPath);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("last_1_completed_proof_sessions=1");
    expect(result.stdout).toContain("last_1_surface_bound_proof_sessions=0");
    expect(result.stdout).toContain("surface_unbound_proof_session_runs=1");
    expect(result.stdout).toContain(
      "last 1 linked provider sessions do not all have surface-bound WorkItem proofs",
    );
  });

  it("D8 audit rejects linked sessions whose completed WorkItem proof belongs to another run", async () => {
    const tempRoot = makeTempRoot();
    const dbPath = join(tempRoot, "d8-fail.sqlite");
    createD8FixtureDb(dbPath, "friday://agent-run/other-run");

    const result = await runD8Audit(dbPath);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("last_1_completed_proof_sessions=0");
    expect(result.stdout).toContain(
      "last 1 linked provider sessions do not all have matching completed WorkItem proof receipts",
    );
  });

  it("D8 audit rejects completed WorkItem proof from a different provider lane", async () => {
    const tempRoot = makeTempRoot();
    const dbPath = join(tempRoot, "d8-provider-mismatch-workitem.sqlite");
    createD8FixtureDb(dbPath, "friday://agent-run/run-1", {
      workItemProvider: "claude",
    });

    const result = await runD8Audit(dbPath);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("last_1_completed_proof_sessions=0");
    expect(result.stdout).toContain(
      "last 1 linked provider sessions do not all have matching completed WorkItem proof receipts",
    );
  });

  it("D8 audit rejects completed WorkItem proof recorded before ledger creation", async () => {
    const tempRoot = makeTempRoot();
    const dbPath = join(tempRoot, "d8-proof-before-evidence.sqlite");
    createD8FixtureDb(dbPath, "friday://agent-run/run-1", {
      workItemUpdatedAt: 900,
    });

    const result = await runD8Audit(dbPath);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("last_1_completed_proof_sessions=0");
    expect(result.stdout).toContain(
      "last 1 linked provider sessions do not all have matching completed WorkItem proof receipts",
    );
  });

  it("D8 audit rejects qualified sessions without a matching provider process observation", async () => {
    const tempRoot = makeTempRoot();
    const dbPath = join(tempRoot, "d8-process-provider-mismatch.sqlite");
    createD8FixtureDb(dbPath, "friday://agent-run/run-1", {
      processKind: "codex_app_server",
      provider: "claude",
    });

    const result = await runD8Audit(dbPath);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("claude_session_links=1");
    expect(result.stdout).toContain("claimed_claude_process_observations=0");
    expect(result.stdout).toContain(
      "qualified Claude sessions found without claimed Claude process observation",
    );
  });

  it("D8 audit rejects provider process observations recorded after session evidence", async () => {
    const tempRoot = makeTempRoot();
    const dbPath = join(tempRoot, "d8-process-after-session.sqlite");
    createD8FixtureDb(dbPath, "friday://agent-run/run-1", {
      processObservedAt: 1001,
    });

    const result = await runD8Audit(dbPath);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("claimed_codex_process_observations=1");
    expect(result.stdout).toContain("last_1_process_proved_sessions=0");
    expect(result.stdout).toContain(
      "last 1 provider sessions do not all have timely provider process observations",
    );
  });

  it("D8 audit rejects Codex process observations bound to another provider session", async () => {
    const tempRoot = makeTempRoot();
    const dbPath = join(tempRoot, "d8-process-wrong-provider-session.sqlite");
    createD8FixtureDb(dbPath, "friday://agent-run/run-1", {
      processPortBindings: [
        "stdio://codex-app-server",
        "friday://provider-session/codex-observe-other-run",
      ],
    });

    const result = await runD8Audit(dbPath);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("claimed_codex_process_observations=1");
    expect(result.stdout).toContain("last_1_process_proved_sessions=0");
    expect(result.stdout).toContain(
      "last_1_claim_bound_process_proved_sessions=0",
    );
    expect(result.stdout).toContain(
      "last 1 provider sessions do not all have timely provider process observations",
    );
  });

  it("D8 audit rejects provider process proof bound to the wrong WorkspaceClaim WorkItem", async () => {
    const tempRoot = makeTempRoot();
    const dbPath = join(tempRoot, "d8-process-claim-wrong-workitem.sqlite");
    createD8FixtureDb(dbPath, "friday://agent-run/run-1", {
      workspaceClaimWorkItemId: "work-other",
    });

    const result = await runD8Audit(dbPath);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("last_1_process_proved_sessions=1");
    expect(result.stdout).toContain(
      "last_1_claim_bound_process_proved_sessions=0",
    );
    expect(result.stdout).toContain(
      "last 1 provider sessions do not all have claim-bound provider process observations",
    );
  });

  it("D8 audit rejects provider events that were never ledger-linked", async () => {
    const tempRoot = makeTempRoot();
    const dbPath = join(tempRoot, "d8-unlinked-event.sqlite");
    createD8FixtureDb(dbPath, "friday://agent-run/run-1", {
      addUnlinkedEvent: true,
    });

    const result = await runD8Audit(dbPath);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("unlinked_events=1");
    expect(result.stdout).toContain(
      "Codex/Claude provider events without token_ledger_ref found",
    );
  });

  it("D8 audit rejects provider events linked to another provider family's ledger row", async () => {
    const tempRoot = makeTempRoot();
    const dbPath = join(tempRoot, "d8-provider-mismatch-ledger.sqlite");
    createD8FixtureDb(dbPath, "friday://agent-run/run-1", {
      ledgerProviderKind: "anthropic",
    });

    const result = await runD8Audit(dbPath);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("linked_event_sessions=0");
    expect(result.stdout).toContain("invalid_token_ledger_refs=1");
    expect(result.stdout).toContain(
      "provider events have token_ledger_ref values with mismatched/weak token_ledger rows",
    );
  });

  it("D8 audit rejects a run_id shared by multiple provider sessions", async () => {
    const tempRoot = makeTempRoot();
    const dbPath = join(tempRoot, "d8-duplicate-run-id.sqlite");
    createD8FixtureDb(dbPath, "friday://agent-run/run-1", {
      addDuplicateRunSession: true,
    });

    const result = await runD8Audit(dbPath);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("duplicate_session_run_ids=1");
    expect(result.stdout).toContain(
      "token_ledger run_id values are shared by multiple provider sessions",
    );
  });

  it("D8 audit rejects multiple sessions proved by one completed WorkItem", async () => {
    const tempRoot = makeTempRoot();
    const dbPath = join(tempRoot, "d8-single-workitem-multiple-runs.sqlite");
    createD8FixtureDb(dbPath, "friday://agent-run/run-1", {
      addSecondDistinctRunSession: true,
      addUnrelatedCompletedWorkItem: true,
      workItemUpdatedAt: 1002,
      workItemProofReceipts: [
        "friday://agent-run/run-1",
        "friday://agent-run/run-2",
      ],
    });

    const result = await runD8Audit(dbPath, "2");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("last_2_completed_proof_sessions=2");
    expect(result.stdout).toContain("last_2_completed_proof_work_items=1");
    expect(result.stdout).toContain(
      "last 2 linked provider sessions do not have distinct completed WorkItem proofs",
    );
  });

  it("D8 audit rejects a completed WorkItem reused across sessions", async () => {
    const tempRoot = makeTempRoot();
    const dbPath = join(tempRoot, "d8-reused-workitem-across-sessions.sqlite");
    createD8FixtureDb(dbPath, "friday://agent-run/run-1", {
      addSecondDistinctRunSession: true,
      addExtraMatchingWorkItemForFirstRun: true,
      workItemUpdatedAt: 1002,
      workItemProofReceipts: [
        "friday://agent-run/run-1",
        "friday://agent-run/run-2",
      ],
    });

    const result = await runD8Audit(dbPath, "2");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("last_2_completed_proof_sessions=2");
    expect(result.stdout).toContain("last_2_completed_proof_work_items=2");
    expect(result.stdout).toContain("multi_session_proof_work_items=1");
    expect(result.stdout).toContain(
      "completed WorkItem proofs are reused across multiple provider sessions",
    );
  });

  it("D8 audit rejects scoped session links that have no linked provider event", async () => {
    const tempRoot = makeTempRoot();
    const dbPath = join(tempRoot, "d8-incomplete-session.sqlite");
    createD8FixtureDb(dbPath, "friday://agent-run/run-1", {
      addOlderIncompleteSession: true,
    });

    const result = await runD8Audit(dbPath);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("incomplete_session_links=1");
    expect(result.stdout).toContain(
      "scoped provider session links without linked provider events found",
    );
  });

  it("D8 audit rejects provider session links whose sync mode is not a D8 observe source", async () => {
    const tempRoot = makeTempRoot();
    const dbPath = join(tempRoot, "d8-unqualified-session.sqlite");
    createD8FixtureDb(dbPath, "friday://agent-run/run-1", {
      addUnqualifiedLinkedSession: true,
    });

    const result = await runD8Audit(dbPath);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("provider_session_links=1");
    expect(result.stdout).toContain("unqualified_session_links=1");
    expect(result.stdout).toContain(
      "scoped provider_session_link rows use non-D8 sync_mode values",
    );
  });

  it("D8 audit rejects token ledger rows that were never referenced by provider events", async () => {
    const tempRoot = makeTempRoot();
    const dbPath = join(tempRoot, "d8-unreferenced-ledger.sqlite");
    createD8FixtureDb(dbPath, "friday://agent-run/run-1", {
      addUnreferencedLedger: true,
    });

    const result = await runD8Audit(dbPath);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("unreferenced_ledger_rows=1");
    expect(result.stdout).toContain(
      "Codex/Claude token_ledger rows without matching provider_session_event refs",
    );
  });

  it("D8 audit rejects ledger-linked session runs without matching completed WorkItem proof", async () => {
    const tempRoot = makeTempRoot();
    const dbPath = join(tempRoot, "d8-unproved-run-in-same-session.sqlite");
    createD8FixtureDb(dbPath, "friday://agent-run/run-1", {
      addUnprovedRunInSameSession: true,
    });

    const result = await runD8Audit(dbPath);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("last_1_completed_proof_sessions=1");
    expect(result.stdout).toContain("unreferenced_ledger_rows=0");
    expect(result.stdout).toContain("unproved_linked_session_runs=1");
    expect(result.stdout).toContain(
      "ledger-linked Codex/Claude session runs without matching completed WorkItem proof found",
    );
  });

  it("single proof and D8 soak keep partial evidence out of strong success by default", () => {
    const proofSource = readFileSync(proofScript, "utf8");
    const routedProofSource = readFileSync(routedProofScript, "utf8");
    const routedProofKeychainWrapperSource = readFileSync(
      routedProofKeychainWrapper,
      "utf8",
    );
    const proofMacosWrapperSource = readFileSync(proofMacosWrapper, "utf8");
    const proofKeychainWrapperSource = readFileSync(
      proofKeychainWrapper,
      "utf8",
    );
    const proofProvisionPassphraseSource = readFileSync(
      proofProvisionPassphraseScript,
      "utf8",
    );
    const soakSource = readFileSync(soakScript, "utf8");
    const soakMacosWrapperSource = readFileSync(soakMacosWrapper, "utf8");
    const soakKeychainWrapperSource = readFileSync(soakKeychainWrapper, "utf8");

    expect(proofSource).toContain("WORK_ITEM_COMPLETED");
    expect(proofSource).toContain(
      'readonly FRIDAY_CONVERSATION_ID="fconv_${ID_PREFIX//-/_}_${RUN_TAG//-/_}"',
    );
    expect(proofSource).not.toContain(
      'readonly FRIDAY_CONVERSATION_ID="codex-proof-conv-${RUN_TAG}"',
    );
    expect(proofSource).toContain('readonly ID_PREFIX="codex-proof"');
    expect(proofSource).toContain('readonly ID_PREFIX="codex-organic"');
    expect(proofSource).toContain("status='completed_with_proof'");
    expect(proofSource).toContain("WORK_ITEM_LINKED_PROOF");
    expect(proofSource).toContain(
      "proof.value = 'friday://agent-run/' || ledger.run_id",
    );
    expect(proofSource).toContain(
      'require_schema_column "token_ledger" "run_id"',
    );
    expect(proofSource).toContain(
      'require_schema_column "provider_session_event" "token_ledger_ref"',
    );
    expect(proofSource).toContain(
      'require_schema_column "work_item" "proof_receipts"',
    );
    expect(proofSource).toContain(
      'require_schema_column "work_item" "mission_id"',
    );
    expect(proofSource).toContain(
      'require_schema_column "work_item" "updated_at_ms"',
    );
    expect(proofSource).toContain(
      'require_schema_column "mission" "mission_id"',
    );
    expect(proofSource).toContain(
      'require_schema_column "mission" "friday_conversation_id"',
    );
    expect(proofSource).toContain(
      'require_schema_column "surface_thread" "surface_thread_id"',
    );
    expect(proofSource).toContain(
      'require_schema_column "surface_thread" "mission_id"',
    );
    expect(proofSource).toContain(
      'require_schema_column "surface_thread" "surface_kind"',
    );
    expect(proofSource).toContain(
      'require_schema_column "surface_thread" "delivery_route"',
    );
    expect(proofSource).toContain(
      'require_schema_column "workspace_claim" "claim_id"',
    );
    expect(proofSource).toContain(
      'require_schema_column "workspace_claim" "work_item_id"',
    );
    expect(proofSource).toContain(
      'require_schema_column "process_observation" "matched_claim_id"',
    );
    expect(proofSource).toContain(
      'require_schema_column "process_observation" "port_bindings"',
    );
    expect(proofSource).toContain(
      "observation.port_bindings LIKE '%\\\"friday://provider-session/' || p.friday_session_id || '\\\"%'",
    );
    for (const source of [proofSource, routedProofSource]) {
      expect(source).toContain("curl_bearer_json()");
      expect(source).toContain("curl --config -");
      expect(source).not.toContain('-H "Authorization: Bearer');
      expect(source).not.toContain("-H 'Authorization: Bearer");
      expect(source).not.toContain("Authorization: Bearer ${TOKEN}");
    }
    expect(
      spawnSync("bash", ["-n", routedProofKeychainWrapper], {
        cwd: repoRoot,
        encoding: "utf8",
      }).status,
    ).toBe(0);
    expect(routedProofSource).toContain(
      'readonly PASSPHRASE_STDIN="${FRIDAY_DEEPSEEK_PROOF_PASSPHRASE_STDIN:-0}"',
    );
    expect(routedProofSource).toContain(
      'readonly PREFLIGHT_ONLY="${FRIDAY_DEEPSEEK_PROOF_PREFLIGHT_ONLY:-0}"',
    );
    expect(routedProofSource).toContain("DeepSeek route proof preflight OK.");
    expect(
      routedProofSource.indexOf('if [ "${PREFLIGHT_ONLY}" = "1" ]; then'),
    ).toBeLessThan(
      routedProofSource.indexOf('if [ "${PASSPHRASE_STDIN}" = "1" ]; then'),
    );
    expect(routedProofKeychainWrapperSource).toContain(
      'readonly KEYCHAIN_SERVICE="${FRIDAY_DEEPSEEK_PROOF_KEYCHAIN_SERVICE:-${FRIDAY_CODEX_MISSION_PROOF_KEYCHAIN_SERVICE:-friday-proof-passphrase}}"',
    );
    expect(routedProofKeychainWrapperSource).toContain(
      'readonly PASSPHRASE_FILE="${FRIDAY_DEEPSEEK_PROOF_PASSPHRASE_FILE:-${FRIDAY_CODEX_MISSION_PROOF_PASSPHRASE_FILE:-${HOME}/.friday/friday-proof-passphrase}}"',
    );
    expect(routedProofKeychainWrapperSource).toContain("passphrase_file_ok()");
    expect(routedProofKeychainWrapperSource).toContain(
      "read_provisioned_passphrase()",
    );
    expect(routedProofKeychainWrapperSource).toContain("stat -f '%Lp'");
    expect(routedProofKeychainWrapperSource).toContain("stat -f '%u'");
    expect(routedProofKeychainWrapperSource).toContain("400|600) ;;");
    expect(routedProofKeychainWrapperSource).toContain(
      "FRIDAY_DEEPSEEK_PROOF_PREFLIGHT_ONLY=1",
    );
    expect(
      routedProofKeychainWrapperSource.indexOf(
        "FRIDAY_DEEPSEEK_PROOF_PREFLIGHT_ONLY=1",
      ),
    ).toBeLessThan(
      routedProofKeychainWrapperSource.indexOf(
        'PASSPHRASE="$(read_provisioned_passphrase)"',
      ),
    );
    expect(routedProofKeychainWrapperSource).toContain(
      "trap 'unset PASSPHRASE' EXIT",
    );
    expect(routedProofKeychainWrapperSource).toContain(
      'FRIDAY_DEEPSEEK_PROOF_PASSPHRASE_STDIN=1 "${PROOF_SCRIPT}"',
    );
    expect(proofSource).toContain(
      'readonly EXPECTED_CODEX_CLI_VERSION="${FRIDAY_CODEX_MISSION_PROOF_CODEX_VERSION:-codex-cli 0.142.5}"',
    );
    expect(proofSource).toContain('CODEX_VERSION="$(codex --version');
    expect(proofSource).toContain("codex CLI version mismatch");
    expect(proofSource).toContain("RUST_WS_LAUNCH_WRAPPER");
    expect(proofSource).toContain('readonly RUST_WS_HOST="127.0.0.1"');
    expect(proofSource).toContain('readonly RUST_WS_PORT="48750"');
    expect(proofSource).toContain("tcp_port_ok()");
    expect(proofSource).toContain('"/dev/tcp/${host}/${port}"');
    expect(proofSource).toContain(
      'tcp_port_ok "${RUST_WS_HOST}" "${RUST_WS_PORT}"',
    );
    expect(proofSource).toContain(
      "Rust sealed WS server did not accept a local TCP connection",
    );
    expect(proofSource).toContain("rustWsPort: ok");
    expect(proofSource).toContain(
      'require_file_contains "${RUST_WS_LAUNCH_WRAPPER}" "export FRIDAY_CODEX_ROUTE_ENABLED=1"',
    );
    expect(proofSource).toContain(
      'require_file_contains "${RUST_WS_LAUNCH_WRAPPER}" "export FRIDAY_OBSERVE_WRAPPER_ENABLED=1"',
    );
    expect(proofSource).toContain(
      'require_file_contains "${RUST_WS_LAUNCH_WRAPPER}" "--validate-codex"',
    );
    expect(proofSource).toContain(
      "readonly DEFAULT_CODEX_APP_SERVER_TIMEOUT_MS=300000",
    );
    expect(proofSource).toContain(
      "readonly CODEX_MISSION_DISPATCH_TIMEOUT_MS=300000",
    );
    const proofTimeoutDefault = proofSource.match(
      /readonly TIMEOUT_SEC="\$\{FRIDAY_CODEX_MISSION_PROOF_TIMEOUT_SEC:-(\d+)\}"/,
    );
    expect(proofTimeoutDefault).not.toBeNull();
    expect(Number(proofTimeoutDefault?.[1])).toBeGreaterThanOrEqual(300);
    expect(proofSource).toContain(
      "readonly PROOF_TIMEOUT_MS=$((TIMEOUT_SEC * 1000))",
    );
    expect(
      proofSource.indexOf(
        'require_positive_int "FRIDAY_CODEX_MISSION_PROOF_TIMEOUT_SEC"',
      ),
    ).toBeLessThan(
      proofSource.indexOf(
        "readonly PROOF_TIMEOUT_MS=$((TIMEOUT_SEC * 1000))",
      ),
    );
    expect(proofSource).toContain("REQUIRED_CODEX_APP_SERVER_TIMEOUT_MS");
    expect(proofSource).toContain(
      'require_codex_app_server_timeout "Rust default" "${DEFAULT_CODEX_APP_SERVER_TIMEOUT_MS}"',
    );
    expect(proofSource).toContain("CODEX_APP_SERVER_TIMEOUT_EFFECTIVE_SOURCE_SEEN");
    expect(proofSource).toContain("RUST_WS_LAUNCH_PLIST");
    expect(proofSource).toContain("RUST_WS_LAUNCH_LABEL");
    expect(proofSource).toContain("RUST_WS_LAUNCH_DOMAIN");
    expect(proofSource).toContain('rust_ws_export_value()');
    expect(proofSource).toContain("plist_optional_env_value()");
    expect(proofSource).toContain("launchctl_optional_env_value()");
    expect(proofSource).toContain("Rust WS LaunchAgent plist");
    expect(proofSource).toContain("live Rust WS LaunchAgent");
    expect(proofSource).toContain("FRIDAY_CODEX_APP_SERVER_TIMEOUT_MS");
    expect(proofSource).toContain("shorter than required");
    expect(proofSource).toContain("TS_HUB_LAUNCH_PLIST");
    expect(proofSource).toContain(
      'check_optional_plist_env_equals "${TS_HUB_LAUNCH_PLIST}" "FRIDAY_MISSION_AUTO_DISPATCH" "1"',
    );
    expect(proofSource).toContain(
      'check_optional_plist_env_equals "${TS_HUB_LAUNCH_PLIST}" "FRIDAY_MISSION_SPINE_ROUTES_VIA_RUST" "1"',
    );
    expect(proofSource).toContain(
      'check_optional_plist_env_equals "${TS_HUB_LAUNCH_PLIST}" "FRIDAY_ROUTE_AGENT_RUN_VIA_RUST" "1"',
    );
    expect(proofSource).toContain(
      'check_optional_plist_env_equals "${TS_HUB_LAUNCH_PLIST}" "FRIDAY_HUB_AGENT_RUN_WS_PORT" "48750"',
    );
    expect(proofSource).toContain(
      'check_optional_plist_env_equals "${TS_HUB_LAUNCH_PLIST}" "FRIDAY_HUB_AGENT_RUN_DB_PATH" "${RUST_HUB_DB}"',
    );
    expect(proofSource).toContain(
      'check_optional_plist_path_contains "${TS_HUB_LAUNCH_PLIST}" "PATH" "${HOME}/.local/bin"',
    );
    expect(proofSource).toContain(
      'if TS_HUB_NODE_BIN="$(plist_optional_env_value "${TS_HUB_LAUNCH_PLIST}" "FRIDAY_NODE_BIN")"; then',
    );
    expect(proofSource).toContain("tsHubLaunchFlags: ok");
    expect(proofSource).toContain("TS_HUB_LAUNCH_LABEL");
    expect(proofSource).toContain("TS_HUB_LAUNCH_DOMAIN");
    expect(proofSource).toContain(
      'launchctl print "${TS_HUB_LAUNCH_DOMAIN}/${TS_HUB_LAUNCH_LABEL}"',
    );
    expect(proofSource).toContain(
      'launchctl print "${RUST_WS_LAUNCH_DOMAIN}/${RUST_WS_LAUNCH_LABEL}"',
    );
    expect(proofSource).toContain(
      '$1 == "environment" && $2 == "=" && $3 == "{"',
    );
    expect(proofSource).toContain(
      'require_launchctl_env_equals "${TS_HUB_LAUNCHCTL_PRINT}" "FRIDAY_MISSION_AUTO_DISPATCH" "1"',
    );
    expect(proofSource).toContain(
      'require_launchctl_env_equals "${TS_HUB_LAUNCHCTL_PRINT}" "FRIDAY_MISSION_SPINE_ROUTES_VIA_RUST" "1"',
    );
    expect(proofSource).toContain(
      'require_launchctl_env_equals "${TS_HUB_LAUNCHCTL_PRINT}" "FRIDAY_ROUTE_AGENT_RUN_VIA_RUST" "1"',
    );
    expect(proofSource).toContain(
      'require_launchctl_env_equals "${TS_HUB_LAUNCHCTL_PRINT}" "FRIDAY_HUB_AGENT_RUN_WS_PORT" "48750"',
    );
    expect(proofSource).toContain(
      'require_launchctl_env_equals "${TS_HUB_LAUNCHCTL_PRINT}" "FRIDAY_HUB_AGENT_RUN_DB_PATH" "${RUST_HUB_DB}"',
    );
    expect(proofSource).toContain(
      'require_launchctl_path_contains "${TS_HUB_LAUNCHCTL_PRINT}" "PATH" "${HOME}/.local/bin"',
    );
    expect(proofSource).toContain(
      'TS_HUB_RUNTIME_NODE_BIN="$(launchctl_env_value "${TS_HUB_LAUNCHCTL_PRINT}" "FRIDAY_NODE_BIN" "TS hub")"',
    );
    expect(proofSource).toContain("tsHubLaunchRuntime: ok");
    expect(
      proofSource.indexOf('require_schema_column "token_ledger" "run_id"'),
    ).toBeLessThan(proofSource.indexOf("read -rs PASSPHRASE"));
    expect(
      proofSource.indexOf('CODEX_VERSION="$(codex --version'),
    ).toBeLessThan(proofSource.indexOf("read -rs PASSPHRASE"));
    expect(
      proofSource.indexOf('tcp_port_ok "${RUST_WS_HOST}" "${RUST_WS_PORT}"'),
    ).toBeLessThan(proofSource.indexOf("read -rs PASSPHRASE"));
    expect(
      proofSource.indexOf(
        'check_optional_plist_env_equals "${TS_HUB_LAUNCH_PLIST}" "FRIDAY_MISSION_AUTO_DISPATCH" "1"',
      ),
    ).toBeLessThan(proofSource.indexOf("read -rs PASSPHRASE"));
    expect(
      proofSource.indexOf(
        'require_launchctl_env_equals "${TS_HUB_LAUNCHCTL_PRINT}" "FRIDAY_MISSION_AUTO_DISPATCH" "1"',
      ),
    ).toBeLessThan(proofSource.indexOf("read -rs PASSPHRASE"));
    expect(
      proofSource.indexOf("RUST_WS_RUNTIME_CODEX_APP_SERVER_TIMEOUT_MS"),
    ).toBeLessThan(proofSource.indexOf("read -rs PASSPHRASE"));
    expect(proofSource).toContain("WORK_ITEM_CLAIM_BOUND_PROCESS_PROOF");
    expect(proofSource).toContain("WORK_ITEM_SURFACE_BOUND_PROOF");
    expect(proofSource).toContain("UNPROVED_LINKED_SESSION_RUNS");
    expect(proofSource).toContain("w.updated_at_ms >= ledger.created_at");
    expect(proofSource).toContain(
      "surface.surface_thread_id = '${SURFACE_THREAD_ID}'",
    );
    expect(proofSource).toContain("surface.surface_kind = '${SURFACE_KIND}'");
    expect(proofSource).toContain(
      "surface.delivery_route = '${DELIVERY_ROUTE}'",
    );
    expect(proofSource).toContain("Mission row:");
    expect(proofSource).toContain("Surface thread row:");
    expect(proofSource).toContain(
      "observation.matched_claim_id = claim.claim_id",
    );
    expect(proofSource).toContain("bound Mission SurfaceThread");
    expect(proofSource).toContain("claim-bound Codex process observation");
    expect(proofSource).toContain("per-run proof reconciliation");
    expect(proofSource).toContain(
      "completed WorkItem did not have a matching ledger-linked friday://agent-run proof receipt",
    );
    expect(proofSource).toContain("FRIDAY_CODEX_MISSION_PROOF_PREFLIGHT_ONLY");
    expect(
      proofSource.indexOf('if [ "${PREFLIGHT_ONLY}" = "1" ]; then'),
    ).toBeLessThan(proofSource.indexOf("read -rs PASSPHRASE"));
    const d8Source = readFileSync(d8AuditScript, "utf8");
    expect(d8Source).toContain(
      'require_schema_column "provider_session_link" "friday_session_id"',
    );
    expect(d8Source).toContain(
      'require_schema_column "provider_session_event" "token_ledger_ref"',
    );
    expect(d8Source).toContain('require_schema_column "token_ledger" "run_id"');
    expect(d8Source).toContain(
      'require_schema_column "work_item" "mission_id"',
    );
    expect(d8Source).toContain(
      'require_schema_column "mission" "friday_conversation_id"',
    );
    expect(d8Source).toContain(
      'require_schema_column "surface_thread" "surface_kind"',
    );
    expect(d8Source).toContain(
      'require_schema_column "surface_thread" "delivery_route"',
    );
    expect(d8Source).toContain(
      'require_schema_column "process_observation" "matched_claim_id"',
    );
    expect(d8Source).toContain(
      'require_schema_column "process_observation" "port_bindings"',
    );
    expect(d8Source).toContain(
      "(provider = 'codex' AND sync_mode = 'provider_app_server_local')",
    );
    expect(d8Source).toContain(
      "(provider = 'claude' AND sync_mode = 'friday_local_mirror')",
    );
    expect(d8Source).toContain("invalid_token_ledger_refs");
    expect(d8Source).toContain("duplicate_session_run_ids");
    expect(d8Source).toContain("unproved_linked_session_runs");
    expect(d8Source).toContain(
      "last_${REQUIRED_SESSIONS}_completed_proof_work_items",
    );
    expect(d8Source).toContain("multi_session_proof_work_items");
    expect(d8Source).toContain(
      "last_${REQUIRED_SESSIONS}_surface_bound_proof_sessions",
    );
    expect(d8Source).toContain("surface_unbound_proof_session_runs");
    expect(d8Source).toContain("JOIN mission m");
    expect(d8Source).toContain("JOIN surface_thread surface");
    expect(d8Source).toContain("surface.mission_id = w.mission_id");
    expect(d8Source).toContain(
      "surface.friday_conversation_id = m.friday_conversation_id",
    );
    expect(d8Source).toContain("surface.surface_kind = 'mobile'");
    expect(d8Source).toContain("COALESCE(surface.delivery_route,'') <> ''");
    expect(d8Source).toContain(
      "e.provider = 'codex' AND ledger.provider_kind = 'codex'",
    );
    expect(d8Source).toContain(
      "w.lane = r.provider OR w.target_provider_or_agent = r.provider",
    );
    expect(d8Source).toContain(
      "ledger.created_at AS ledger_created_at",
    );
    expect(d8Source).toContain("w.updated_at_ms >= r.ledger_created_at");
    expect(d8Source).toContain("rust_agent_run_ws_port_ok");
    expect(d8Source).toContain(
      "Rust agent-run WS port did not accept a local TCP connection",
    );
    expect(d8Source).toContain(
      "last_${REQUIRED_SESSIONS}_process_proved_sessions",
    );
    expect(d8Source).toContain(
      "last_${REQUIRED_SESSIONS}_claim_bound_process_proved_sessions",
    );
    expect(d8Source).toContain("observation.observed_at_ms <= n.seen_at");
    expect(d8Source).toContain("observation.matched_claim_id = claim.claim_id");
    expect(d8Source).toContain(
      "observation.port_bindings LIKE '%\\\"friday://provider-session/' || n.friday_session_id || '\\\"%'",
    );
    expect(d8Source).toContain(
      "observation.port_bindings LIKE '%\\\"friday://provider-session/' || p.friday_session_id || '\\\"%'",
    );
    expect(d8Source).toContain("claim.work_item_id = p.work_item_id");
    expect(d8Source).toContain(
      "qualified Claude sessions found without claimed Claude process observation",
    );
    expect(soakSource).toContain("FRIDAY_CODEX_MISSION_PROOF_PREFLIGHT_ONLY=1");
    expect(
      soakSource.indexOf("FRIDAY_CODEX_MISSION_PROOF_PREFLIGHT_ONLY=1"),
    ).toBeLessThan(
      soakSource.indexOf('if [ "${PASSPHRASE_STDIN}" = "1" ]; then'),
    );
    expect(soakSource).toContain(
      'readonly PREFLIGHT_ONLY="${FRIDAY_CODEX_MISSION_D8_PREFLIGHT_ONLY:-0}"',
    );
    expect(soakSource).toContain("Codex mission D8 soak preflight OK.");
    expect(
      soakSource.indexOf('if [ "${PREFLIGHT_ONLY}" = "1" ]; then'),
    ).toBeLessThan(
      soakSource.indexOf('if [ "${PASSPHRASE_STDIN}" = "1" ]; then'),
    );
    expect(soakSource).toContain(
      'readonly ACCEPT_PARTIAL="${FRIDAY_CODEX_MISSION_D8_ACCEPT_PARTIAL:-0}"',
    );
    expect(soakSource).toContain(
      '[ "${proof_status}" -eq 2 ] && [ "${ACCEPT_PARTIAL}" = "1" ]',
    );
    expect(proofMacosWrapperSource).toContain(
      "FRIDAY_CODEX_MISSION_PROOF_PREFLIGHT_ONLY=1",
    );
    expect(
      proofMacosWrapperSource.indexOf(
        "FRIDAY_CODEX_MISSION_PROOF_PREFLIGHT_ONLY=1",
      ),
    ).toBeLessThan(
      proofMacosWrapperSource.indexOf("osascript <<'APPLESCRIPT'"),
    );
    expect(proofKeychainWrapperSource).toContain(
      'readonly KEYCHAIN_SERVICE="${FRIDAY_CODEX_MISSION_PROOF_KEYCHAIN_SERVICE:-friday-proof-passphrase}"',
    );
    expect(proofKeychainWrapperSource).toContain(
      'readonly PASSPHRASE_FILE="${FRIDAY_CODEX_MISSION_PROOF_PASSPHRASE_FILE:-${HOME}/.friday/friday-proof-passphrase}"',
    );
    expect(proofKeychainWrapperSource).toContain("passphrase_file_ok()");
    expect(proofKeychainWrapperSource).toContain(
      "read_provisioned_passphrase()",
    );
    expect(proofKeychainWrapperSource).toContain("stat -f '%Lp'");
    expect(proofKeychainWrapperSource).toContain("stat -f '%u'");
    expect(proofKeychainWrapperSource).toContain("400|600) ;;");
    expect(proofKeychainWrapperSource).toContain(
      "passphrase file must be owned by the current user",
    );
    expect(proofKeychainWrapperSource).toContain(
      "passphrase file must be mode 0600 or 0400",
    );
    expect(proofKeychainWrapperSource).toContain("sed -n '1p'");
    expect(proofKeychainWrapperSource).toContain(
      "FRIDAY_CODEX_MISSION_PROOF_PREFLIGHT_ONLY=1",
    );
    expect(
      proofKeychainWrapperSource.indexOf(
        "FRIDAY_CODEX_MISSION_PROOF_PREFLIGHT_ONLY=1",
      ),
    ).toBeLessThan(
      proofKeychainWrapperSource.indexOf(
        'PASSPHRASE="$(read_provisioned_passphrase)"',
      ),
    );
    expect(proofKeychainWrapperSource).toContain(
      "trap 'unset PASSPHRASE' EXIT",
    );
    expect(proofKeychainWrapperSource).toContain(
      'security find-generic-password -a "${KEYCHAIN_ACCOUNT}" -s "${KEYCHAIN_SERVICE}" -w >/dev/null 2>&1',
    );
    expect(proofKeychainWrapperSource).toContain(
      'FRIDAY_CODEX_MISSION_PROOF_PASSPHRASE_STDIN=1 "${PROOF_SCRIPT}"',
    );
    expect(proofProvisionPassphraseSource).toContain(
      'readonly KEYCHAIN_SERVICE="${FRIDAY_CODEX_MISSION_PROOF_KEYCHAIN_SERVICE:-friday-proof-passphrase}"',
    );
    expect(proofProvisionPassphraseSource).toContain(
      'readonly PASSPHRASE_FILE="${FRIDAY_CODEX_MISSION_PROOF_PASSPHRASE_FILE:-${HOME}/.friday/friday-proof-passphrase}"',
    );
    expect(proofProvisionPassphraseSource).toContain(
      'security add-generic-password -U -a "${KEYCHAIN_ACCOUNT}" -s "${KEYCHAIN_SERVICE}" -w',
    );
    expect(proofProvisionPassphraseSource).toContain("read -rs first");
    expect(proofProvisionPassphraseSource).toContain("read -rs second");
    expect(proofProvisionPassphraseSource).toContain("chmod 600");
    expect(proofProvisionPassphraseSource).toContain("check_status()");
    expect(proofProvisionPassphraseSource).toContain(
      "check_keychain_present()",
    );
    expect(proofProvisionPassphraseSource).toContain("check_file_present()");
    expect(proofProvisionPassphraseSource).toContain(
      "passphrase file path must not be a symlink",
    );
    expect(proofProvisionPassphraseSource).toContain(
      "Do not pass the passphrase as an argument",
    );
    expect(soakMacosWrapperSource).toContain(
      "FRIDAY_CODEX_MISSION_D8_PREFLIGHT_ONLY=1",
    );
    expect(
      soakMacosWrapperSource.indexOf(
        "FRIDAY_CODEX_MISSION_D8_PREFLIGHT_ONLY=1",
      ),
    ).toBeLessThan(soakMacosWrapperSource.indexOf("osascript <<'APPLESCRIPT'"));
    expect(soakKeychainWrapperSource).toContain(
      'readonly KEYCHAIN_SERVICE="${FRIDAY_CODEX_MISSION_PROOF_KEYCHAIN_SERVICE:-friday-proof-passphrase}"',
    );
    expect(soakKeychainWrapperSource).toContain(
      'readonly PASSPHRASE_FILE="${FRIDAY_CODEX_MISSION_PROOF_PASSPHRASE_FILE:-${HOME}/.friday/friday-proof-passphrase}"',
    );
    expect(soakKeychainWrapperSource).toContain("passphrase_file_ok()");
    expect(soakKeychainWrapperSource).toContain(
      "read_provisioned_passphrase()",
    );
    expect(soakKeychainWrapperSource).toContain("stat -f '%Lp'");
    expect(soakKeychainWrapperSource).toContain("stat -f '%u'");
    expect(soakKeychainWrapperSource).toContain("400|600) ;;");
    expect(soakKeychainWrapperSource).toContain(
      "passphrase file must be owned by the current user",
    );
    expect(soakKeychainWrapperSource).toContain(
      "passphrase file must be mode 0600 or 0400",
    );
    expect(soakKeychainWrapperSource).toContain("sed -n '1p'");
    expect(soakKeychainWrapperSource).toContain(
      "FRIDAY_CODEX_MISSION_D8_PREFLIGHT_ONLY=1",
    );
    expect(
      soakKeychainWrapperSource.indexOf(
        "FRIDAY_CODEX_MISSION_D8_PREFLIGHT_ONLY=1",
      ),
    ).toBeLessThan(
      soakKeychainWrapperSource.indexOf(
        'PASSPHRASE="$(read_provisioned_passphrase)"',
      ),
    );
    expect(soakKeychainWrapperSource).toContain("trap 'unset PASSPHRASE' EXIT");
    expect(soakKeychainWrapperSource).toContain(
      'security find-generic-password -a "${KEYCHAIN_ACCOUNT}" -s "${KEYCHAIN_SERVICE}" -w >/dev/null 2>&1',
    );
    expect(soakKeychainWrapperSource).toContain(
      'FRIDAY_CODEX_MISSION_D8_SOAK_PASSPHRASE_STDIN=1 "${SOAK_SCRIPT}" "$@"',
    );
  });
});
