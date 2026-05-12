import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { REAL_GREEN_GATE_RESULT_FILENAME } from "../../../scripts/ops/lib/real-green-gate-result.mjs";
import { completeSelfHostedSetup } from "../../../scripts/ops/run-real-green-gate-self-hosted.mjs";

describe("run-real-green-gate-self-hosted", () => {
  let tempRoot: string | null = null;

  afterEach(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
    vi.unstubAllGlobals();
  });

  it("writes an errored result artifact when the self-hosted runtime cannot start", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "friday-rgg-self-hosted-test-"));
    const repoRoot = join(tempRoot, "repo-without-dist");
    const reportRoot = join(tempRoot, "report");
    const scriptPath = join(process.cwd(), "scripts/ops/run-real-green-gate-self-hosted.mjs");
    const sha = "718c23e97222a9eb34a6bb2e8244e51fd5b04c44";

    expect(() =>
      execFileSync(process.execPath, [
        scriptPath,
        "--repo-root",
        repoRoot,
        "--report-root",
        reportRoot,
      ], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          GITHUB_SHA: sha,
          GITHUB_REF_NAME: "codex/test-self-hosted-rgg",
        },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ).toThrow();

    const artifact = JSON.parse(readFileSync(join(reportRoot, REAL_GREEN_GATE_RESULT_FILENAME), "utf8"));
    expect(artifact).toMatchObject({
      status: "errored",
      commit_sha: sha,
      ref_name: "codex/test-self-hosted-rgg",
      evidence_kinds_observed: [],
      blocked_reasons: ["self_hosted_runtime_error"],
      scenarios_run: 0,
      scenarios_total: 0,
      scenarios_passed: 0,
    });
    expect(readFileSync(join(reportRoot, "self-hosted-runtime-error.log"), "utf8")).toContain(
      "dist/cli/friday-cli.js is missing",
    );
  });

  it("logs in and completes setup before running the gate without claiming provider/channel setup", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/v1/auth/login")) {
        return new Response(JSON.stringify({
          ok: true,
          data: { accessToken: "test-access-token" },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/v1/setup/complete")) {
        return new Response(JSON.stringify({
          ok: true,
          data: { setupCompletedAt: "2026-05-12T00:00:00.000Z" },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: false }), { status: 404 });
    }));

    await completeSelfHostedSetup("http://127.0.0.1:31337", "local-passphrase");

    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:31337/v1/auth/login",
      "http://127.0.0.1:31337/v1/setup/complete",
    ]);
    const setupCall = calls[1];
    expect(setupCall.init?.headers).toMatchObject({
      Authorization: "Bearer test-access-token",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(setupCall.init?.body))).toEqual({
      completedSteps: ["welcome", "security", "network", "skills"],
      skippedSteps: ["communication", "provider", "channels"],
    });
  });

  it("keeps build failure inside the self-hosted workflow step so an errored artifact is uploaded", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/real-green-gate.yml"), "utf8");

    expect(workflow).not.toContain("name: Build self-hosted Friday runtime");
    expect(workflow).toContain("self_hosted_runtime_build_failed");
    expect(workflow).toContain("buildErroredResult");
    expect(workflow).toContain("node scripts/ops/run-real-green-gate-self-hosted.mjs");
  });
});
