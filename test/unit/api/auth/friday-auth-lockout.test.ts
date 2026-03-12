import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridayRateLimitService, AUTH_LOCKOUT_SCOPE_SHARED_SECRET, AUTH_LOCKOUT_SCOPE_DEVICE_TOKEN } from "#api";
import type { FridayRateLimitService } from "#api";

describe("FridayAuthLockout", () => {
  let db: FridaySqliteLayer;
  let service: FridayRateLimitService;
  let currentTime: string;

  beforeEach(() => {
    db = createTestDb();
    currentTime = "2025-06-15T10:00:00.000Z";
    service = createFridayRateLimitService({
      db,
      nowIso: () => currentTime,
      authLockoutConfig: {
        maxAttempts: 3,
        windowMs: 60_000,
        lockoutMs: 10_000,
        maxLockoutLevel: 3,
      },
    });
  });

  afterEach(() => {
    service.dispose?.();
    db.close();
  });

  it("allows login below threshold", () => {
    service.recordAuthFailure("user:test");
    service.recordAuthFailure("user:test");
    const status = service.checkAuthLockout("user:test");
    expect(status.locked).toBe(false);
    expect(status.failureCount).toBe(2);
  });

  it("locks out after reaching threshold", () => {
    service.recordAuthFailure("user:test");
    service.recordAuthFailure("user:test");
    const status = service.recordAuthFailure("user:test"); // 3rd = threshold
    expect(status.locked).toBe(true);
    expect(status.retryAfterMs).toBeGreaterThan(0);
  });

  it("returns locked status on subsequent checks", () => {
    for (let i = 0; i < 3; i++) {
      service.recordAuthFailure("user:test");
    }
    const status = service.checkAuthLockout("user:test");
    expect(status.locked).toBe(true);
  });

  it("unlocks after lockout period expires", () => {
    for (let i = 0; i < 3; i++) {
      service.recordAuthFailure("user:test");
    }
    // Advance time past lockout duration (10s)
    currentTime = "2025-06-15T10:00:11.000Z";
    const status = service.checkAuthLockout("user:test");
    expect(status.locked).toBe(false);
  });

  it("escalates lockout duration on repeated lockouts", () => {
    // First lockout
    for (let i = 0; i < 3; i++) {
      service.recordAuthFailure("user:test");
    }
    const first = service.checkAuthLockout("user:test");
    expect(first.locked).toBe(true);
    expect(first.lockoutLevel).toBe(1);

    // Advance past first lockout
    currentTime = "2025-06-15T10:00:11.000Z";

    // Second lockout
    for (let i = 0; i < 3; i++) {
      service.recordAuthFailure("user:test");
    }
    const second = service.checkAuthLockout("user:test");
    expect(second.locked).toBe(true);
    expect(second.lockoutLevel).toBe(2);
    // Second lockout should be longer (10s * 2^1 = 20s)
    expect(second.retryAfterMs!).toBeGreaterThan(first.retryAfterMs!);
  });

  it("isolates principals", () => {
    for (let i = 0; i < 3; i++) {
      service.recordAuthFailure("user:a");
    }
    const statusA = service.checkAuthLockout("user:a");
    const statusB = service.checkAuthLockout("user:b");
    expect(statusA.locked).toBe(true);
    expect(statusB.locked).toBe(false);
  });

  it("isolates by email principal — two users from same IP have independent counters", () => {
    const emailKeyAlice = "email:alice@example.com";
    const emailKeyBob = "email:bob@example.com";

    // Alice fails 3 times → locked out
    for (let i = 0; i < 3; i++) {
      service.recordAuthFailure(emailKeyAlice);
    }

    // Bob has NOT failed — should NOT be locked
    const bobStatus = service.checkAuthLockout(emailKeyBob);
    expect(bobStatus.locked).toBe(false);
    expect(bobStatus.failureCount).toBe(0);

    // Alice IS locked
    const aliceStatus = service.checkAuthLockout(emailKeyAlice);
    expect(aliceStatus.locked).toBe(true);

    // Bob can fail independently without affecting Alice
    service.recordAuthFailure(emailKeyBob);
    service.recordAuthFailure(emailKeyBob);
    const bobStatus2 = service.checkAuthLockout(emailKeyBob);
    expect(bobStatus2.locked).toBe(false);
    expect(bobStatus2.failureCount).toBe(2);
  });

  it("resets failures on success", () => {
    service.recordAuthFailure("user:test");
    service.recordAuthFailure("user:test");
    service.resetAuthFailures("user:test");
    const status = service.checkAuthLockout("user:test");
    expect(status.locked).toBe(false);
    expect(status.failureCount).toBe(0);
  });

  it("resets lockout level on resetAuthFailures", () => {
    // Trigger lockout
    for (let i = 0; i < 3; i++) {
      service.recordAuthFailure("user:test");
    }
    // Reset
    service.resetAuthFailures("user:test");
    const status = service.checkAuthLockout("user:test");
    expect(status.lockoutLevel).toBe(0);
  });

  it("prunes expired failures outside window", () => {
    service.recordAuthFailure("user:test");
    service.recordAuthFailure("user:test");

    // Advance time past the window (60s)
    currentTime = "2025-06-15T10:01:01.000Z";

    // Old failures should be pruned — this should NOT trigger lockout
    service.recordAuthFailure("user:test");
    const status = service.checkAuthLockout("user:test");
    expect(status.locked).toBe(false);
    expect(status.failureCount).toBe(1);
  });

  // ─── Scope isolation tests ───

  describe("scope partitioning", () => {
    it("shared-secret failures do not lock device-token flow", () => {
      // Lock out shared-secret scope
      for (let i = 0; i < 3; i++) {
        service.recordAuthFailure("user:test", AUTH_LOCKOUT_SCOPE_SHARED_SECRET);
      }
      const sharedStatus = service.checkAuthLockout("user:test", AUTH_LOCKOUT_SCOPE_SHARED_SECRET);
      expect(sharedStatus.locked).toBe(true);

      // device-token scope should still be open
      const deviceStatus = service.checkAuthLockout("user:test", AUTH_LOCKOUT_SCOPE_DEVICE_TOKEN);
      expect(deviceStatus.locked).toBe(false);
      expect(deviceStatus.failureCount).toBe(0);
    });

    it("device-token failures do not lock shared-secret flow", () => {
      for (let i = 0; i < 3; i++) {
        service.recordAuthFailure("user:test", AUTH_LOCKOUT_SCOPE_DEVICE_TOKEN);
      }
      const deviceStatus = service.checkAuthLockout("user:test", AUTH_LOCKOUT_SCOPE_DEVICE_TOKEN);
      expect(deviceStatus.locked).toBe(true);

      const sharedStatus = service.checkAuthLockout("user:test", AUTH_LOCKOUT_SCOPE_SHARED_SECRET);
      expect(sharedStatus.locked).toBe(false);
    });

    it("reset only clears the specified scope", () => {
      service.recordAuthFailure("user:test", AUTH_LOCKOUT_SCOPE_SHARED_SECRET);
      service.recordAuthFailure("user:test", AUTH_LOCKOUT_SCOPE_SHARED_SECRET);
      service.recordAuthFailure("user:test", AUTH_LOCKOUT_SCOPE_DEVICE_TOKEN);
      service.recordAuthFailure("user:test", AUTH_LOCKOUT_SCOPE_DEVICE_TOKEN);

      service.resetAuthFailures("user:test", AUTH_LOCKOUT_SCOPE_SHARED_SECRET);

      const sharedStatus = service.checkAuthLockout("user:test", AUTH_LOCKOUT_SCOPE_SHARED_SECRET);
      expect(sharedStatus.failureCount).toBe(0);

      const deviceStatus = service.checkAuthLockout("user:test", AUTH_LOCKOUT_SCOPE_DEVICE_TOKEN);
      expect(deviceStatus.failureCount).toBe(2);
    });

    it("default scope is shared-secret when not specified", () => {
      // Record failures without explicit scope
      service.recordAuthFailure("user:test");
      service.recordAuthFailure("user:test");

      // Should be visible in the shared-secret scope
      const status = service.checkAuthLockout("user:test", AUTH_LOCKOUT_SCOPE_SHARED_SECRET);
      expect(status.failureCount).toBe(2);
    });
  });

  // ─── Loopback exemption tests ───

  describe("loopback exemption", () => {
    it("does NOT exempt 127.0.0.1 from IP lockout by default", () => {
      for (let i = 0; i < 5; i++) {
        service.recordIpFailure("127.0.0.1");
      }
      const status = service.checkIpLockout("127.0.0.1");
      expect(status.locked).toBe(true);
    });

    it("does NOT exempt ::1 from IP lockout by default", () => {
      for (let i = 0; i < 5; i++) {
        service.recordIpFailure("::1");
      }
      const status = service.checkIpLockout("::1");
      expect(status.locked).toBe(true);
    });

    it("does NOT exempt ::ffff:127.0.0.1 from IP lockout by default", () => {
      for (let i = 0; i < 5; i++) {
        service.recordIpFailure("::ffff:127.0.0.1");
      }
      const status = service.checkIpLockout("::ffff:127.0.0.1");
      expect(status.locked).toBe(true);
    });

    it("exempts loopback when exemptLoopback is true", () => {
      service.dispose?.();
      service = createFridayRateLimitService({
        db,
        nowIso: () => currentTime,
        authLockoutConfig: {
          maxAttempts: 3,
          windowMs: 60_000,
          lockoutMs: 10_000,
          maxLockoutLevel: 3,
          exemptLoopback: true,
        },
      });

      for (let i = 0; i < 3; i++) {
        service.recordIpFailure("127.0.0.1");
      }
      const status = service.checkIpLockout("127.0.0.1");
      expect(status.locked).toBe(false);
    });

    it("loopback exemption does not affect principal lockout", () => {
      // Principal lockout is NOT exempted by loopback
      for (let i = 0; i < 3; i++) {
        service.recordAuthFailure("user:local");
      }
      const status = service.checkAuthLockout("user:local");
      expect(status.locked).toBe(true);
    });
  });

  // ─── IP lockout tests ───

  describe("IP-based lockout", () => {
    it("locks out an IP after reaching threshold", () => {
      for (let i = 0; i < 3; i++) {
        service.recordIpFailure("10.0.0.1");
      }
      const status = service.checkIpLockout("10.0.0.1");
      expect(status.locked).toBe(true);
      expect(status.retryAfterMs).toBeGreaterThan(0);
    });

    it("different IPs are tracked independently", () => {
      for (let i = 0; i < 3; i++) {
        service.recordIpFailure("10.0.0.1");
      }
      expect(service.checkIpLockout("10.0.0.1").locked).toBe(true);
      expect(service.checkIpLockout("10.0.0.2").locked).toBe(false);
    });

    it("resets IP lockout on success", () => {
      for (let i = 0; i < 3; i++) {
        service.recordIpFailure("10.0.0.1");
      }
      expect(service.checkIpLockout("10.0.0.1").locked).toBe(true);

      service.resetIpFailures("10.0.0.1");
      expect(service.checkIpLockout("10.0.0.1").locked).toBe(false);
    });

    it("normalizes undefined IP to 'unknown'", () => {
      for (let i = 0; i < 3; i++) {
        service.recordIpFailure(undefined);
      }
      const status = service.checkIpLockout(undefined);
      expect(status.locked).toBe(true);
    });

    it("IP lockout includes retryAfterMs", () => {
      for (let i = 0; i < 3; i++) {
        service.recordIpFailure("10.0.0.5");
      }
      const status = service.checkIpLockout("10.0.0.5");
      expect(status.locked).toBe(true);
      expect(status.retryAfterMs).toBeGreaterThan(0);
      expect(status.retryAfter).toBeTruthy();
    });
  });
});
