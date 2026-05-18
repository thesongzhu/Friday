import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { FridayDomainError } from "#errors";
import {
  createFridayCliTuiAuthCoordinator,
  type FridayCliTuiAuthCoordinatorDeps,
} from "../../../src/cli/friday-cli-tui.js";

const FRIDAY_CLI_TUI_SOURCE_PATH = resolve(
  __dirname,
  "../../../src/cli/friday-cli-tui.ts",
);

const LOOPBACK_BASE_URL = "http://127.0.0.1:4145";
const REMOTE_BASE_URL = "https://hub.example.com";

function makeJsonResponse(body: unknown, init: { status?: number } = {}): Response {
  const status = init.status ?? 200;
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeDeps(
  overrides: Partial<FridayCliTuiAuthCoordinatorDeps> & {
    env?: NodeJS.ProcessEnv;
  } = {},
): FridayCliTuiAuthCoordinatorDeps {
  return {
    apiBaseUrl: LOOPBACK_BASE_URL,
    env: {},
    fetchFn: vi.fn(),
    ...overrides,
  };
}

describe("CLAW-013 — TUI first-run auth never uses a hard-coded fallback passphrase", () => {
  it("source no longer contains the historical fallback literal", () => {
    const src = readFileSync(FRIDAY_CLI_TUI_SOURCE_PATH, "utf8");
    expect(src).not.toContain("friday-cli-tui-passphrase-123");
  });

  it("fails closed with a clear non-secret error when no env credential is configured", async () => {
    const fetchFn = vi.fn();
    const coordinator = createFridayCliTuiAuthCoordinator(
      makeDeps({ env: {}, fetchFn }),
    );

    expect(coordinator.hasConfiguredAccessToken).toBe(false);
    expect(coordinator.isLoopback).toBe(true);

    await expect(coordinator.resolveAccessToken()).rejects.toBeInstanceOf(FridayDomainError);
    await expect(coordinator.resolveAccessToken()).rejects.toMatchObject({
      code: "TUI_AUTH_NOT_CONFIGURED",
    });

    expect(fetchFn).not.toHaveBeenCalled();
    const errorMessage = await coordinator
      .resolveAccessToken()
      .catch((err: Error) => err.message);
    expect(errorMessage).not.toContain("friday-cli-tui-passphrase-123");
  });

  it("does not invent a passphrase when no env credential is set on a remote base URL", async () => {
    const fetchFn = vi.fn();
    const coordinator = createFridayCliTuiAuthCoordinator(
      makeDeps({ apiBaseUrl: REMOTE_BASE_URL, env: {}, fetchFn }),
    );

    await expect(coordinator.resolveAccessToken()).resolves.toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("CLAW-013 — explicit env credentials still flow through existing auth paths", () => {
  it("explicit FRIDAY_TUI_ACCESS_TOKEN bypasses local passphrase login entirely", async () => {
    const fetchFn = vi.fn();
    const coordinator = createFridayCliTuiAuthCoordinator(
      makeDeps({
        env: { FRIDAY_TUI_ACCESS_TOKEN: "tok-explicit-123" },
        fetchFn,
      }),
    );

    expect(coordinator.hasConfiguredAccessToken).toBe(true);
    await expect(coordinator.resolveAccessToken()).resolves.toBe("tok-explicit-123");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("explicit FRIDAY_LOCAL_PASSPHRASE reaches bootstrap + login on a loopback base URL", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(makeJsonResponse({ ok: true, data: { bootstrapRequired: true } }))
      .mockResolvedValueOnce(makeJsonResponse({ ok: true }))
      .mockResolvedValueOnce(makeJsonResponse({ ok: true, data: { accessToken: "tok-from-login" } }));

    const coordinator = createFridayCliTuiAuthCoordinator(
      makeDeps({
        env: { FRIDAY_LOCAL_PASSPHRASE: "operator-supplied-passphrase" },
        fetchFn,
      }),
    );

    await expect(coordinator.resolveAccessToken()).resolves.toBe("tok-from-login");

    expect(fetchFn).toHaveBeenCalledTimes(3);
    const [statusCall, bootstrapCall, loginCall] = fetchFn.mock.calls;
    expect(statusCall[0]).toBe(`${LOOPBACK_BASE_URL}/v1/auth/bootstrap/status`);
    expect(bootstrapCall[0]).toBe(`${LOOPBACK_BASE_URL}/v1/auth/bootstrap/local-passphrase`);
    expect(loginCall[0]).toBe(`${LOOPBACK_BASE_URL}/v1/auth/login`);

    const bootstrapBody = JSON.parse(bootstrapCall[1].body) as { localPassphrase?: string };
    const loginBody = JSON.parse(loginCall[1].body) as { localPassphrase?: string };
    expect(bootstrapBody.localPassphrase).toBe("operator-supplied-passphrase");
    expect(loginBody.localPassphrase).toBe("operator-supplied-passphrase");
  });

  it("FRIDAY_TEST_LOCAL_PASSPHRASE takes precedence over FRIDAY_LOCAL_PASSPHRASE and is used at login", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(makeJsonResponse({ ok: true, data: { bootstrapRequired: false } }))
      .mockResolvedValueOnce(makeJsonResponse({ ok: true, data: { accessToken: "tok-test-env" } }));

    const coordinator = createFridayCliTuiAuthCoordinator(
      makeDeps({
        env: {
          FRIDAY_TEST_LOCAL_PASSPHRASE: "test-passphrase-explicit",
          FRIDAY_LOCAL_PASSPHRASE: "should-be-ignored",
        },
        fetchFn,
      }),
    );

    await expect(coordinator.resolveAccessToken()).resolves.toBe("tok-test-env");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const loginBody = JSON.parse(fetchFn.mock.calls[1][1].body) as { localPassphrase?: string };
    expect(loginBody.localPassphrase).toBe("test-passphrase-explicit");
  });
});
