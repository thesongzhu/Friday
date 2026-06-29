import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { REAL_GREEN_GATE_RESULT_FILENAME } from "../../../scripts/ops/lib/real-green-gate-result.mjs";
import {
  completeSelfHostedSetup,
  configureExplicitDeepSeekRouting,
  createGateEnv,
  createRuntimeEnv,
} from "../../../scripts/ops/run-real-green-gate-self-hosted.mjs";
import { PHASE24_CHANNEL_ENV_REQUIREMENTS } from "../../../validation/real-world/lib/env-truth.mjs";

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
    const sha = "test-self-hosted-rgg-sha";

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

  it("pins explicit DeepSeek routing (no fallback) and never selects OpenAI for the default proof", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/v1/auth/login")) {
        return new Response(JSON.stringify({ ok: true, data: { accessToken: "tok" } }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/v1/providers")) {
        return new Response(JSON.stringify({
          ok: true,
          data: {
            items: [
              { id: "oai-1", kind: "openai", enabled: true, defaultModel: "gpt-4o-mini" },
              { id: "ds-1", kind: "deepseek", enabled: true, defaultModel: "deepseek-v4-pro" },
            ],
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/v1/model-routing")) {
        return new Response(JSON.stringify({ ok: true, data: { routing: {} } }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: false }), { status: 404 });
    }));

    const result = await configureExplicitDeepSeekRouting("http://127.0.0.1:31337", "pass");

    expect(result).toEqual({ configured: true, providerId: "ds-1" });
    const routingCall = calls.find((c) => c.url.endsWith("/v1/model-routing"));
    expect(routingCall?.init?.method).toBe("PUT");
    const body = JSON.parse(String(routingCall?.init?.body));
    expect(body).toEqual({
      defaultProviderId: "ds-1",
      defaultModel: "deepseek-v4-pro",
      fallbackProviderIds: [],
    });
    // OpenAI is registered but must never be selected as default or fallback.
    expect(body.defaultProviderId).not.toBe("oai-1");
    expect(body.fallbackProviderIds).not.toContain("oai-1");
  });

  it("leaves routing unset (configured:false) when no DeepSeek provider is present", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      if (url.endsWith("/v1/auth/login")) {
        return new Response(JSON.stringify({ ok: true, data: { accessToken: "tok" } }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/v1/providers")) {
        return new Response(JSON.stringify({
          ok: true,
          data: { items: [{ id: "oai-1", kind: "openai", enabled: true }] },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: false }), { status: 404 });
    }));

    const result = await configureExplicitDeepSeekRouting("http://127.0.0.1:31337", "pass");

    expect(result).toEqual({ configured: false });
    // No routing PUT is made — action-required is surfaced honestly.
    expect(calls.some((url) => url.endsWith("/v1/model-routing"))).toBe(false);
  });

  it("injects OPENAI_API_KEY only on the explicit C3/C4 fallback drill lane", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/real-green-gate.yml"), "utf8");
    const injections = workflow.match(/OPENAI_API_KEY: \$\{\{ secrets\.OPENAI_API_KEY \}\}/g) ?? [];
    // Only c3c4-provider-routing-proof carries OpenAI for the explicit fallback drill.
    expect(injections).toHaveLength(1);
    // The default proof job must not carry an OpenAI key.
    const mainJobSection = workflow.slice(
      workflow.indexOf("real-green-gate:"),
      workflow.indexOf("phase24b-discord-trusted-inbound:"),
    );
    expect(mainJobSection).not.toContain("OPENAI_API_KEY");
    const c45JobSection = workflow.slice(
      workflow.indexOf("c45-real-user-intelligence-proof:"),
      workflow.indexOf("phase24e-telegram-workflow-candidate:"),
    );
    expect(c45JobSection).not.toContain("OPENAI_API_KEY");
  });

  it("makes Phase24E Telegram workflow candidate ids deterministic for manual proof prompts", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/real-green-gate.yml"), "utf8");
    const phase24eSection = workflow.slice(
      workflow.indexOf("phase24e-telegram-workflow-candidate:"),
      workflow.indexOf("phase24f-discord-workflow-candidate:"),
    );

    expect(phase24eSection).toContain(
      "PHASE24E_TELEGRAM_REJECT_CANDIDATE_ID: phase24e-reject-run-${{ github.run_id }}",
    );
    expect(phase24eSection).toContain(
      "PHASE24E_TELEGRAM_APPROVE_CANDIDATE_ID: phase24e-approve-run-${{ github.run_id }}",
    );
  });

  it("passes an explicit workspace root while keeping runtime state isolated", () => {
    const paths = {
      stateDir: "/tmp/friday-rgg-runtime/state",
    };
    const workspaceRoot = "/home/runner/work/Friday/Friday";

    const runtimeEnv = createRuntimeEnv(
      {},
      paths,
      3141,
      "passphrase-placeholder",
      "token-placeholder",
      workspaceRoot,
    );
    const gateEnv = createGateEnv(
      {},
      paths,
      "http://127.0.0.1:3141",
      "passphrase-placeholder",
      "token-placeholder",
      workspaceRoot,
    );

    expect(runtimeEnv.FRIDAY_STATE_DIR).toBe(paths.stateDir);
    expect(runtimeEnv.FRIDAY_WORKSPACE_ROOT).toBe(workspaceRoot);
    expect(gateEnv.FRIDAY_STATE_DIR).toBe(paths.stateDir);
    expect(gateEnv.FRIDAY_WORKSPACE_ROOT).toBe(workspaceRoot);
    expect(gateEnv.FRIDAY_BASE_URL).toBe("http://127.0.0.1:3141");
    expect(runtimeEnv.FRIDAY_CHANNELS_JSON).toBeUndefined();
    expect(gateEnv.FRIDAY_CHANNELS_JSON).toBeUndefined();
  });

  it("preserves an explicitly provided channel config for self-hosted runs", () => {
    const paths = {
      stateDir: "/tmp/friday-rgg-runtime/state",
    };
    const explicitChannelsJson = '{"enabled":true,"instances":[{"kind":"discord","enabled":true}]}';

    const runtimeEnv = createRuntimeEnv(
      { FRIDAY_CHANNELS_JSON: explicitChannelsJson },
      paths,
      3141,
      "passphrase-placeholder",
      "token-placeholder",
      "/home/runner/work/Friday/Friday",
    );
    const gateEnv = createGateEnv(
      { FRIDAY_CHANNELS_JSON: explicitChannelsJson },
      paths,
      "http://127.0.0.1:3141",
      "passphrase-placeholder",
      "token-placeholder",
      "/home/runner/work/Friday/Friday",
    );

    expect(runtimeEnv.FRIDAY_CHANNELS_JSON).toBe(explicitChannelsJson);
    expect(gateEnv.FRIDAY_CHANNELS_JSON).toBe(explicitChannelsJson);
  });

  it("keeps build failure inside the self-hosted workflow step so an errored artifact is uploaded", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/real-green-gate.yml"), "utf8");

    expect(workflow).not.toContain("name: Build self-hosted Friday runtime");
    expect(workflow).toContain("self_hosted_runtime_build_failed");
    expect(workflow).toContain("buildErroredResult");
    expect(workflow).toContain("node scripts/ops/run-real-green-gate-self-hosted.mjs");
  });

  it("binds the Phase24 live-channel environment and exposes only env names to RGG", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/real-green-gate.yml"), "utf8");

    expect(workflow).toContain("environment: phase-24-live-channels");
    for (const envName of Object.values(PHASE24_CHANNEL_ENV_REQUIREMENTS).flat()) {
      expect(workflow).toContain(`${envName}:`);
    }
    expect(workflow).not.toContain("FRIDAY_WHATSAPP");
  });
});
