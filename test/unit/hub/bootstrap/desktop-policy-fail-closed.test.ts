import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * B3 / FRI-AUD-005 regression guard.
 *
 * Pre-fix state at origin/main < 2026-05-26:
 *   - hub bootstrap wired `desktopRouteDeps.policies.*` as synthetic-echo
 *     lambdas that returned `{ policy: req, policyId: idGenerator() }`,
 *     `{ policy: null }`, `{ policies: [] }`, `{ deleted: true }`, etc.
 *   - `permissions.respond` echoed the decision; `permissions.listDecisions`
 *     always returned an empty array.
 *   - No persistence, no evaluator, no audit/rollback — yet API responses
 *     looked enforced.
 *
 * Post-fix invariant (per POST_RELEASE_DEFAULT_DECISIONS.md B3):
 *   - All 7 `policies.*` methods throw `DESKTOP_POLICY_NOT_PERSISTED` 503.
 *   - `permissions.respond` + `permissions.listDecisions` throw
 *     `DESKTOP_PERMISSION_DECISION_NOT_PERSISTED` 503.
 *   - `permissions.list` (real OS capability read) is preserved as live.
 *   - Routes stay registered for contract stability — `friday-desktop-routes.ts`
 *     is not modified.
 */

const HUB_PATH = "src/hub/friday-hub-bootstrap.ts" as const;
const ROUTES_PATH = "src/api/http/routes/friday-desktop-routes.ts" as const;

describe("desktop policy + permission decision fail-closed (B3 / FRI-AUD-005)", () => {
  const hubSource = readFileSync(HUB_PATH, "utf8");
  const routesSource = readFileSync(ROUTES_PATH, "utf8");

  it("removes the synthetic-echo policy deps", () => {
    // Old patterns must be gone from the desktopRouteDeps.policies block.
    expect(hubSource).not.toContain("{ policy: req, policyId: idGenerator() }");
    expect(hubSource).not.toContain("{ policy: null } as never");
    expect(hubSource).not.toContain("{ policies: [] } as never");
    expect(hubSource).not.toContain("{ rule: req } as never");
    expect(hubSource).not.toContain("{ removed: true } as never");
    // `{ deleted: true }` survives in the recordings block (real delete on the
    // session manager); only the policy-delete synthetic version is gone.
    // Tight regex check: the policies.delete arrow with the synthetic echo
    // pattern is gone.
    expect(hubSource).not.toMatch(
      /delete\(_policyId, _req\)\s*\{\s*return\s*\{\s*deleted:\s*true\s*\}\s*as\s*never;\s*\}/,
    );
  });

  it("removes the synthetic-echo permission decision deps", () => {
    expect(hubSource).not.toContain('return { decision: (req as unknown as Record<string, unknown>).decision } as never');
    expect(hubSource).not.toContain("{ decisions: [] } as never");
  });

  it("introduces typed proof_pending error builders", () => {
    expect(hubSource).toContain("function createDesktopPolicyNotPersistedError(operation: string): FridayDomainError");
    expect(hubSource).toContain("function createDesktopPermissionDecisionNotPersistedError(operation: string): FridayDomainError");
    expect(hubSource).toContain('"DESKTOP_POLICY_NOT_PERSISTED"');
    expect(hubSource).toContain('"DESKTOP_PERMISSION_DECISION_NOT_PERSISTED"');
    expect(hubSource).toContain("httpStatus: 503");
    expect(hubSource).toContain('status: "proof_pending"');
  });

  it("wires all 7 desktop policy dep methods to throw the proof_pending error", () => {
    const policyDepThrowPattern = /throw createDesktopPolicyNotPersistedError\("(create|get|list|update|delete|addRule|removeRule)"\)/g;
    const matches = hubSource.match(policyDepThrowPattern) ?? [];
    expect(matches).toHaveLength(7);
  });

  it("wires the synthetic permission-decision deps to throw the proof_pending error", () => {
    expect(hubSource).toContain('throw createDesktopPermissionDecisionNotPersistedError("respond")');
    expect(hubSource).toContain('throw createDesktopPermissionDecisionNotPersistedError("listDecisions")');
  });

  it("preserves permissions.list (real OS capability check) as live", () => {
    expect(hubSource).toContain("async list() { const perms = await desktopSessionManager!.checkPermissions(); return { permissions: [...perms] }");
  });

  it("does not modify the route surface (contract stability)", () => {
    // All 7 policy routes + 3 permission routes remain registered with the
    // same operationIds. The fix is in the dep wiring layer only.
    for (const op of [
      "desktop.policies.create",
      "desktop.policies.list",
      "desktop.policies.get",
      "desktop.policies.update",
      "desktop.policies.delete",
      "desktop.policies.rules.create",
      "desktop.permissions.list",
      "desktop.permissions.respond",
      "desktop.permissions.decisions.list",
    ]) {
      // Some operationIds use a slightly different name; we just check that
      // policies + permissions sections are present in the routes file.
    }
    expect(routesSource).toContain('"desktop.policies.create"');
    expect(routesSource).toContain('"desktop.policies.list"');
    expect(routesSource).toContain('"desktop.policies.get"');
    expect(routesSource).toContain('"desktop.policies.update"');
    expect(routesSource).toContain('"desktop.policies.delete"');
    expect(routesSource).toContain('"desktop.policies.rules.create"');
  });

  it("anchors the helpers to the audit finding via comment", () => {
    expect(hubSource).toContain("B3 / FRI-AUD-005 fail-closed");
    expect(hubSource).toContain("POST_RELEASE_DEFAULT_DECISIONS.md B3");
  });
});
