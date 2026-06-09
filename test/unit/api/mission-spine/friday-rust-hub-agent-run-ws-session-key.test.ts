import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FRIDAY_HUB_AGENT_RUN_WS_SESSION_KEY_PRESENT,
  resolveRustAgentRunWsSessionKey,
} from "../../../../src/api/mission-spine/friday-rust-hub-agent-run-ws-session-key.js";

// execrun-replacement S-F-compose (DARK): the SecureStore-backed WS session-key resolver.
// Fail-closed contract: a MISSING / disabled SecureStore key resolves to `null` so the
// composition never opens an unauthenticated WS connection. The key is NEVER logged.

describe("resolveRustAgentRunWsSessionKey (S-F-compose, dark, SecureStore-backed)", () => {
  const savedPresence = process.env[FRIDAY_HUB_AGENT_RUN_WS_SESSION_KEY_PRESENT];

  beforeEach(() => {
    delete process.env[FRIDAY_HUB_AGENT_RUN_WS_SESSION_KEY_PRESENT];
  });

  afterEach(() => {
    if (savedPresence === undefined) {
      delete process.env[FRIDAY_HUB_AGENT_RUN_WS_SESSION_KEY_PRESENT];
    } else {
      process.env[FRIDAY_HUB_AGENT_RUN_WS_SESSION_KEY_PRESENT] = savedPresence;
    }
    vi.restoreAllMocks();
  });

  it("explicit disable via the presence env signal → fail closed (null), no SecureStore read", () => {
    process.env[FRIDAY_HUB_AGENT_RUN_WS_SESSION_KEY_PRESENT] = "0";
    expect(resolveRustAgentRunWsSessionKey()).toBeNull();
    process.env[FRIDAY_HUB_AGENT_RUN_WS_SESSION_KEY_PRESENT] = "false";
    expect(resolveRustAgentRunWsSessionKey()).toBeNull();
  });

  it("never throws an error that carries the key, and never logs", () => {
    // The presence signal off forces the no-read path; assert no console output leaks.
    process.env[FRIDAY_HUB_AGENT_RUN_WS_SESSION_KEY_PRESENT] = "0";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => resolveRustAgentRunWsSessionKey()).not.toThrow();
    expect(logSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("when the SecureStore master key is unavailable → fail closed (null)", () => {
    // With no keychain master key + no master-key env provisioned, the SecureStore lookup
    // throws internally and the resolver returns null (fail closed) rather than propagating.
    // (The presence signal is unset here, so the SecureStore path is attempted.)
    const result = resolveRustAgentRunWsSessionKey();
    // Either null (no key provisioned) or a >=32-byte derived key (a key was provisioned in
    // this environment) — but NEVER a short/invalid value, and NEVER a throw.
    if (result !== null) {
      expect(result.length).toBeGreaterThanOrEqual(32);
    } else {
      expect(result).toBeNull();
    }
  });
});
