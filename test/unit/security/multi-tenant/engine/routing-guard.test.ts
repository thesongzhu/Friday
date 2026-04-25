import { beforeEach, describe, expect, it } from "vitest";

import { AuditLogger } from "../../../../../src/security/multi-tenant/engine/audit-logger.js";
import { assertTenantRouteBoundary } from "../../../../../src/security/multi-tenant/engine/routing-guard.js";
import { SecurityEngineError } from "../../../../../src/security/multi-tenant/engine/utils.js";

describe("assertTenantRouteBoundary()", () => {
  let auditLogger: AuditLogger;

  beforeEach(() => {
    auditLogger = new AuditLogger();
  });

  it("blocks mismatched route tenant and auth tenant", () => {
    expect(() =>
      assertTenantRouteBoundary(
        "tenant-route",
        {
          principalId: "user-1",
          tenantId: "tenant-auth",
          roles: ["member"],
        },
        auditLogger,
      ),
    ).toThrow(SecurityEngineError);

    const denies = auditLogger.queryAuditLog({
      tenantId: "tenant-route",
      action: "routing.tenant.boundary",
      decision: "deny",
    });
    expect(denies).toHaveLength(1);
  });

  it("allows superadmin exception on cross-tenant route", () => {
    expect(() =>
      assertTenantRouteBoundary(
        "tenant-route",
        {
          principalId: "root",
          tenantId: "different-tenant",
          roles: ["superadmin"],
        },
        auditLogger,
      ),
    ).not.toThrow();

    const allows = auditLogger.queryAuditLog({
      tenantId: "tenant-route",
      action: "routing.tenant.boundary",
      decision: "allow",
    });
    expect(allows).toHaveLength(1);
  });

  it("does not allow cross-tenant routes for superadmin substrings", () => {
    expect(() =>
      assertTenantRouteBoundary(
        "tenant-route",
        {
          principalId: "fake-root",
          tenantId: "different-tenant",
          roles: ["not-superadmin"],
        },
        auditLogger,
      ),
    ).toThrow(SecurityEngineError);
  });
});
