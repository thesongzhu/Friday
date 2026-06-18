import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as crypto from "node:crypto";

import {
  FRIDAY_HUB_AGENT_RUN_WS_SESSION_KEY_PRESENT,
  resolveRustAgentRunWsSessionKey,
} from "../../../../src/api/mission-spine/friday-rust-hub-agent-run-ws-session-key.js";
import { resetMasterKeyCache } from "../../../../src/security/friday-secret-crypto.js";

// execrun-replacement S-F-compose (DARK): the SecureStore-backed WS session-key resolver.
// Fail-closed contract: a MISSING / disabled SecureStore key resolves to `null` so the
// composition never opens an unauthenticated WS connection. The key is NEVER logged.

describe("resolveRustAgentRunWsSessionKey (S-F-compose, dark, SecureStore-backed)", () => {
  const savedPresence = process.env[FRIDAY_HUB_AGENT_RUN_WS_SESSION_KEY_PRESENT];
  const savedMasterKey = process.env.FRIDAY_MASTER_KEY;
  const savedMasterKeySource = process.env.FRIDAY_MASTER_KEY_SOURCE;
  const savedKeychainService = process.env.FRIDAY_MASTER_KEY_KEYCHAIN_SERVICE;
  const savedKeychainAccount = process.env.FRIDAY_MASTER_KEY_KEYCHAIN_ACCOUNT;

  beforeEach(() => {
    delete process.env[FRIDAY_HUB_AGENT_RUN_WS_SESSION_KEY_PRESENT];
    delete process.env.FRIDAY_MASTER_KEY;
    resetMasterKeyCache();
  });

  afterEach(() => {
    if (savedPresence === undefined) {
      delete process.env[FRIDAY_HUB_AGENT_RUN_WS_SESSION_KEY_PRESENT];
    } else {
      process.env[FRIDAY_HUB_AGENT_RUN_WS_SESSION_KEY_PRESENT] = savedPresence;
    }
    if (savedMasterKey === undefined) {
      delete process.env.FRIDAY_MASTER_KEY;
    } else {
      process.env.FRIDAY_MASTER_KEY = savedMasterKey;
    }
    if (savedMasterKeySource === undefined) {
      delete process.env.FRIDAY_MASTER_KEY_SOURCE;
    } else {
      process.env.FRIDAY_MASTER_KEY_SOURCE = savedMasterKeySource;
    }
    if (savedKeychainService === undefined) {
      delete process.env.FRIDAY_MASTER_KEY_KEYCHAIN_SERVICE;
    } else {
      process.env.FRIDAY_MASTER_KEY_KEYCHAIN_SERVICE = savedKeychainService;
    }
    if (savedKeychainAccount === undefined) {
      delete process.env.FRIDAY_MASTER_KEY_KEYCHAIN_ACCOUNT;
    } else {
      process.env.FRIDAY_MASTER_KEY_KEYCHAIN_ACCOUNT = savedKeychainAccount;
    }
    resetMasterKeyCache();
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
    process.env.FRIDAY_MASTER_KEY_SOURCE = "keychain";
    process.env.FRIDAY_MASTER_KEY_KEYCHAIN_SERVICE = `Friday Test Missing ${crypto.randomUUID()}`;
    process.env.FRIDAY_MASTER_KEY_KEYCHAIN_ACCOUNT = `friday-test-${crypto.randomUUID()}`;

    expect(resolveRustAgentRunWsSessionKey()).toBeNull();
  });
});
