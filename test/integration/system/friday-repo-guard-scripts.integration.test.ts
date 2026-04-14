import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

type ExecFailure = Error & {
  code?: number;
  stdout?: string;
  stderr?: string;
};

async function writeFileWithParents(root: string, relativePath: string, content: string) {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

async function createArchitectureFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "friday-arch-guard-"));
  await writeFileWithParents(root, "src/state/index.ts", 'import { loadFridayConfig } from "#config";\nexport { loadFridayConfig };\n');
  await writeFileWithParents(root, "src/state/sqlite.ts", 'export const sqlite = true;\n');
  await writeFileWithParents(root, "src/security/index.ts", 'import { FridayDomainError } from "#errors";\nvoid FridayDomainError;\n');
  await writeFileWithParents(root, "src/channels/index.ts", 'import type { FridayAgentEventEmitter } from "#agent";\nexport type { FridayAgentEventEmitter };\n');
  await writeFileWithParents(root, "src/providers/index.ts", 'import type { FridaySqliteLayer } from "#state";\nexport type { FridaySqliteLayer };\n');
  return root;
}

async function createSecurityFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "friday-security-guard-"));
  await writeFileWithParents(root, "package.json", JSON.stringify({
    name: "friday-security-fixture",
    version: "1.0.0",
    scripts: {
      "ops:doctor:runtime": "node scripts/ops/friday-local-runtime-doctor.mjs",
      "check:provider-reliability": "vitest run test/unit/providers/model/friday-provider-templates.test.ts",
      "check:desktop-release-pipeline": "node scripts/ops/check-friday-desktop-release-pipeline.mjs",
    },
  }, null, 2));
  await writeFileWithParents(root, "src/security/friday-secret-ref.ts", 'const refs = ["secret://", "env:", "file:", "command:"];\nexport { refs };\n');
  await writeFileWithParents(root, "src/security/friday-audit-log.ts", "export const audit = true;\n");
  await writeFileWithParents(root, "scripts/ops/friday-local-runtime-doctor.mjs", "console.log('ok');\n");
  await writeFileWithParents(
    root,
    "src/agent/runtime/friday-agent-runtime.ts",
    'const names = ["agent.run.awaiting_tool_approval", "agent.run.capability_grant_used", "grantId"];\nexport { names };\n',
  );
  await writeFileWithParents(
    root,
    "src/api/http/routes/friday-provider-routes.ts",
    'export const routes = [{ operationId: "providers.doctor" }];\n',
  );
  await writeFileWithParents(
    root,
    "src/api/http/routes/friday-channel-routes.ts",
    'export const routes = [{ operationId: "channels.list" }, { operationId: "channels.get" }];\n',
  );
  await writeFileWithParents(
    root,
    "docs/current-source-of-truth.md",
    "- `/v1/channels*` route\n- canonical `preflight` summary\n",
  );
  return root;
}

async function createAuditFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "friday-audit-guard-"));
  await writeFileWithParents(
    root,
    "src/security/friday-audit-log.ts",
    [
      "const writeLocks = new Map();",
      'const line = JSON.stringify(entry) + "\\n";',
      "await fs.appendFile(filePath, line, { mode: FILE_MODE });",
      "await fs.writeFile(filePath, line, { mode: FILE_MODE });",
      "interface FridayAuditRecord {",
      "  id: string;",
      "  ts: string;",
      "  action: string;",
      "  resourceType: string;",
      "}",
    ].join("\n"),
  );
  await writeFileWithParents(root, "src/hub/services/friday-hub-audit-log-writer.ts", "export const audit = true;\n");
  await writeFileWithParents(root, "test/unit/security/friday-audit-log.test.ts", "export {};\n");
  await writeFileWithParents(root, "test/unit/hub/services/friday-hub-audit-log-writer.test.ts", "export {};\n");
  await writeFileWithParents(root, "docs/TROUBLESHOOTING.md", "Audit log path: audit.jsonl\n");
  await writeFileWithParents(root, "test/e2e/mock/friday-openclaw-parity-closure.e2e.test.ts", "const auditPath = 'audit.jsonl';\n");
  return root;
}

describe("repo guard scripts", () => {
  it("architecture boundary guard passes for allowed aliases and fails on cross-layer imports", async () => {
    const repoRoot = await createArchitectureFixture();
    const passing = await execFileAsync(
      "node",
      [path.join(process.cwd(), "scripts/quality/check-architecture-boundaries.mjs"), repoRoot],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    const passingReport = JSON.parse(passing.stdout) as { status: string };
    expect(passingReport.status).toBe("passed");

    await writeFileWithParents(repoRoot, "src/state/bad.ts", 'import "#channels";\n');
    const failure = await execFileAsync(
      "node",
      [path.join(process.cwd(), "scripts/quality/check-architecture-boundaries.mjs"), repoRoot],
      { cwd: process.cwd(), encoding: "utf8" },
    ).then(
      () => null,
      (error) => error as ExecFailure,
    );

    expect(failure).not.toBeNull();
    const report = JSON.parse(failure!.stdout ?? "{}") as {
      status: string;
      checks: Array<{ target: string; violations: Array<{ specifier: string }> }>;
    };
    expect(report.status).toBe("failed");
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "src/state",
          violations: expect.arrayContaining([
            expect.objectContaining({ specifier: "#channels" }),
          ]),
        }),
      ]),
    );
  });

  it("security doctor passes when the canonical files and fragments are present", async () => {
    const repoRoot = await createSecurityFixture();
    const result = await execFileAsync(
      "node",
      [path.join(process.cwd(), "scripts/ops/check-friday-security-doctor.mjs"), repoRoot, "--skip-tests"],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    const report = JSON.parse(result.stdout) as { status: string; summary: { failed: number } };
    expect(report.status).toBe("passed");
    expect(report.summary.failed).toBe(0);
  });

  it("security doctor fails when a canonical route fragment is missing", async () => {
    const repoRoot = await createSecurityFixture();
    await writeFileWithParents(rootOrThrow(repoRoot), "src/api/http/routes/friday-channel-routes.ts", 'export const routes = [{ operationId: "channels.list" }];\n');
    const failure = await execFileAsync(
      "node",
      [path.join(process.cwd(), "scripts/ops/check-friday-security-doctor.mjs"), repoRoot, "--skip-tests"],
      { cwd: process.cwd(), encoding: "utf8" },
    ).then(
      () => null,
      (error) => error as ExecFailure,
    );

    expect(failure).not.toBeNull();
    const report = JSON.parse(failure!.stdout ?? "{}") as {
      status: string;
      checks: Array<{ target: string; missingFragments?: string[]; status: string }>;
    };
    expect(report.status).toBe("failed");
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "src/api/http/routes/friday-channel-routes.ts",
          status: "failed",
        }),
      ]),
    );
  });

  it("audit integrity guard passes when canonical audit files are present", async () => {
    const repoRoot = await createAuditFixture();
    const result = await execFileAsync(
      "node",
      [path.join(process.cwd(), "scripts/ops/check-friday-audit-integrity.mjs"), repoRoot, "--skip-tests"],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    const report = JSON.parse(result.stdout) as { status: string; summary: { failed: number } };
    expect(report.status).toBe("passed");
    expect(report.summary.failed).toBe(0);
  });

  it("audit integrity guard fails when the JSONL append fragment is missing", async () => {
    const repoRoot = await createAuditFixture();
    await writeFileWithParents(
      repoRoot,
      "src/security/friday-audit-log.ts",
      [
        "const writeLocks = new Map();",
        "await fs.appendFile(filePath, line);",
        "interface FridayAuditRecord {",
        "  id: string;",
        "  ts: string;",
        "  action: string;",
        "  resourceType: string;",
        "}",
      ].join("\n"),
    );

    const failure = await execFileAsync(
      "node",
      [path.join(process.cwd(), "scripts/ops/check-friday-audit-integrity.mjs"), repoRoot, "--skip-tests"],
      { cwd: process.cwd(), encoding: "utf8" },
    ).then(
      () => null,
      (error) => error as ExecFailure,
    );

    expect(failure).not.toBeNull();
    const report = JSON.parse(failure!.stdout ?? "{}") as {
      status: string;
      checks: Array<{ target: string; status: string }>;
    };
    expect(report.status).toBe("failed");
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "src/security/friday-audit-log.ts",
          status: "failed",
        }),
      ]),
    );
  });
});

function rootOrThrow(root: string): string {
  if (!root) {
    throw new Error("fixture root is required");
  }
  return root;
}
