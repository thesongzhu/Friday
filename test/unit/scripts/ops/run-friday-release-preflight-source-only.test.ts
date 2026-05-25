/**
 * R1 — run-friday-release-preflight source-only mode. Locks down:
 *   - FRIDAY_RELEASE_MODE=source-only is recorded in the report;
 *   - cross-platform release-inputs check is skipped (status=skipped_source_only)
 *     because the npm/source release does not promise iOS/Android/Windows/macOS;
 *   - the duplicate `checks.cross_platform_check` field is NOT emitted (drift
 *     prevention — the canonical location is `crossPlatformReleaseInputs.status`).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "ops", "run-friday-release-preflight.mjs");

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "preflight-source-only-"));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function readReport(): Promise<Record<string, unknown>> {
  const reportPath = path.join(tmpDir, "report.json");
  const raw = await fs.readFile(reportPath, "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("run-friday-release-preflight source-only mode", () => {
  it("FRIDAY_RELEASE_MODE=source-only: report.releaseMode === 'source-only' and cross-platform check is skipped", async () => {
    const tag = await getTagMatchingPackageVersion();
    const result = spawnSync("node", [SCRIPT_PATH], {
      env: {
        ...process.env,
        FRIDAY_RELEASE_MODE: "source-only",
        FRIDAY_RELEASE_TAG: tag,
        FRIDAY_RELEASE_PREFLIGHT_REPO_ROOT: REPO_ROOT,
        FRIDAY_RELEASE_PREFLIGHT_ARTIFACT_DIR: tmpDir,
      },
      encoding: "utf8",
    });
    expect(result.status, `preflight stderr: ${result.stderr}`).toBe(0);
    const report = await readReport();
    expect(report.releaseMode).toBe("source-only");
    const checks = report.checks as Record<string, unknown>;
    expect(checks.cross_platform_check).toBeUndefined();
    const cross = checks.crossPlatformReleaseInputs as { status: string; exitCode: unknown };
    expect(cross.status).toBe("skipped_source_only");
    expect(cross.exitCode).toBeNull();
  });
});

async function getTagMatchingPackageVersion(): Promise<string> {
  const pkg = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "package.json"), "utf8"));
  return `v${pkg.version}`;
}
