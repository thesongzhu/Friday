import { beforeEach, describe, expect, it } from "vitest";

import { AuditLogger } from "../../../../../src/security/multi-tenant/engine/audit-logger.js";
import { TenantManager } from "../../../../../src/security/multi-tenant/engine/tenant-manager.js";
import { SecretManager } from "../../../../../src/security/multi-tenant/engine/secret-manager.js";
import { RbacEngine } from "../../../../../src/security/multi-tenant/engine/rbac-engine.js";
import { PolicyEngine } from "../../../../../src/security/multi-tenant/engine/policy-engine.js";
import { SecurityEngineError } from "../../../../../src/security/multi-tenant/engine/utils.js";

describe("Multi-tenant security KPI assertions", () => {
  let auditLogger: AuditLogger;
  let tenantManager: TenantManager;
  let secretManager: SecretManager;
  let rbacEngine: RbacEngine;
  let policyEngine: PolicyEngine;
  const superadminActor = { principalId: "root", roles: ["superadmin"] };

  beforeEach(() => {
    auditLogger = new AuditLogger();
    tenantManager = new TenantManager(auditLogger);
    secretManager = new SecretManager(auditLogger);
    rbacEngine = new RbacEngine(auditLogger);
    policyEngine = new PolicyEngine(auditLogger);
  });

  it("KPI: cross-tenant access violations = 0", () => {
    const tenantA = tenantManager.createTenant({ name: "Tenant A", slug: "kpi-a" }, superadminActor);
    const tenantB = tenantManager.createTenant({ name: "Tenant B", slug: "kpi-b" }, superadminActor);

    const workspaceA = tenantManager.createWorkspace(tenantA.id, { name: "Workspace A", slug: "ws-a" }, superadminActor);
    const secretA = secretManager.createSecret(tenantA.id, {
      name: "KPI_SECRET",
      value: "redacted",
      scope: { scopeType: "tenant" },
    });
    const roleA = rbacEngine.createRole(tenantA.id, {
      name: "tenant-a-role",
      scopeType: "tenant",
      permissions: [],
    });
    const policyA = policyEngine.createPolicy(tenantA.id, {
      name: "tenant-a-policy",
      rules: [],
    });

    const deniedReads: Array<() => unknown> = [
      () => tenantManager.getWorkspace(tenantB.id, workspaceA.id, superadminActor),
      () => secretManager.getSecret(tenantB.id, secretA.id),
      () => rbacEngine.getRole(tenantB.id, roleA.id),
      () => policyEngine.getPolicy(tenantB.id, policyA.id),
    ];

    let unauthorizedAccessSuccessCount = 0;
    for (const read of deniedReads) {
      try {
        read();
        unauthorizedAccessSuccessCount += 1;
      } catch (error) {
        expect(error).toBeInstanceOf(SecurityEngineError);
      }
    }

    expect(unauthorizedAccessSuccessCount).toBe(0);
  });

  it("KPI: permission-denied audit coverage = 100%", () => {
    const tenantA = tenantManager.createTenant({ name: "Audit A", slug: "kpi-audit-a" }, superadminActor);
    const tenantB = tenantManager.createTenant({ name: "Audit B", slug: "kpi-audit-b" }, superadminActor);

    const workspaceA = tenantManager.createWorkspace(tenantA.id, { name: "Workspace A", slug: "audit-ws-a" }, superadminActor);
    const secretA = secretManager.createSecret(tenantA.id, {
      name: "AUDIT_SECRET",
      value: "sensitive",
      scope: { scopeType: "tenant" },
    });
    const roleA = rbacEngine.createRole(tenantA.id, {
      name: "audit-role",
      scopeType: "tenant",
      permissions: [],
    });
    const policyA = policyEngine.createPolicy(tenantA.id, {
      name: "audit-policy",
      rules: [],
    });

    const deniedOperations: Array<{ action: string; run: () => unknown }> = [
      { action: "workspace.get", run: () => tenantManager.getWorkspace(tenantB.id, workspaceA.id, superadminActor) },
      { action: "secret.get", run: () => secretManager.getSecret(tenantB.id, secretA.id) },
      { action: "role.get", run: () => rbacEngine.getRole(tenantB.id, roleA.id) },
      { action: "policy.get", run: () => policyEngine.getPolicy(tenantB.id, policyA.id) },
    ];

    for (const deniedOperation of deniedOperations) {
      expect(deniedOperation.run).toThrow(SecurityEngineError);
    }

    const deniedAuditEntries = auditLogger.queryAuditLog({
      tenantId: tenantB.id,
      decision: "deny",
    });

    const coveredEntries = deniedAuditEntries.filter((entry) =>
      deniedOperations.some((operation) => operation.action === entry.action)
    );

    expect(coveredEntries).toHaveLength(deniedOperations.length);
  });

  it("KPI: secret exposure incidents = 0", () => {
    const tenant = tenantManager.createTenant({ name: "Exposure", slug: "kpi-exposure" }, superadminActor);

    const created = secretManager.createSecret(tenant.id, {
      name: "NO_EXPOSE",
      value: "plaintext-secret",
      scope: { scopeType: "tenant" },
    });
    const fetched = secretManager.getSecret(tenant.id, created.id);
    const listed = secretManager.listSecrets(tenant.id);
    const rotated = secretManager.rotateSecret(tenant.id, created.id, {
      newValue: "plaintext-secret-2",
      etag: fetched.etag,
      initiatedBy: "admin",
    }).secret;

    const payloads = [fetched, listed, rotated];

    let exposureIncidents = 0;
    for (const payload of payloads) {
      const serialised = JSON.stringify(payload);
      if (
        serialised.includes("encryptedValue") ||
        serialised.includes("encryptionKeyId") ||
        serialised.includes("plaintext-secret") ||
        serialised.includes("plaintext-secret-2")
      ) {
        exposureIncidents += 1;
      }
    }

    expect(exposureIncidents).toBe(0);
  });
});
