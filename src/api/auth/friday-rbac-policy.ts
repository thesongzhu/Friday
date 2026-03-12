import type { FridayRole, FridayScope } from "../model/friday-api-auth.types.js";

// ─── Role → Scope mapping ───

const ROLE_SCOPES: Record<FridayRole, readonly FridayScope[]> = {
  owner: [
    "hub.admin",
    "workflow.read",
    "workflow.write",
    "workflow.run",
    "workflow.conflict.resolve",
    "satellite.read",
    "satellite.write",
    "fleet.read",
    "security.read",
    "security.write",
    "session.read",
    "session.write",
    "diagnosis.read",
    "diagnosis.write",
    "agent.read",
    "agent.run",
    "agent.write",
    "skill.read",
    "skill.write",
    "plugin.read",
    "plugin.write",
    "plugin.install",
  ],
  admin: [
    "hub.admin",
    "workflow.read",
    "workflow.write",
    "workflow.run",
    "workflow.conflict.resolve",
    "satellite.read",
    "satellite.write",
    "fleet.read",
    "security.read",
    "security.write",
    "session.read",
    "session.write",
    "diagnosis.read",
    "diagnosis.write",
    "agent.read",
    "agent.run",
    "agent.write",
    "skill.read",
    "skill.write",
    "plugin.read",
    "plugin.write",
    "plugin.install",
  ],
  operator: [
    "workflow.read",
    "workflow.write",
    "workflow.run",
    "workflow.conflict.resolve",
    "satellite.read",
    "fleet.read",
    "session.read",
    "session.write",
    "diagnosis.read",
    "agent.read",
    "agent.run",
    "agent.write",
    "skill.read",
    "plugin.read",
  ],
  viewer: [
    "workflow.read",
    "satellite.read",
    "fleet.read",
    "security.read",
    "session.read",
    "diagnosis.read",
    "agent.read",
    "skill.read",
    "plugin.read",
  ],
};

/** Returns all scopes granted to a role. */
export function getScopesForRole(role: FridayRole): readonly FridayScope[] {
  return ROLE_SCOPES[role] ?? [];
}

/** Returns true if the role has the given scope. */
export function roleHasScope(role: FridayRole, scope: FridayScope): boolean {
  return ROLE_SCOPES[role]?.includes(scope) ?? false;
}

/** Returns true if the principal has any of the required scopes. */
export function principalHasAnyScope(
  principalScopes: readonly FridayScope[],
  requiredScopes: readonly FridayScope[],
): boolean {
  return requiredScopes.some((s) => principalScopes.includes(s));
}

/** Returns true if the principal has any of the required roles. */
export function principalHasAnyRole(
  principalRole: FridayRole | undefined,
  requiredRoles: readonly FridayRole[],
): boolean {
  if (!principalRole) return false;
  return requiredRoles.includes(principalRole);
}
