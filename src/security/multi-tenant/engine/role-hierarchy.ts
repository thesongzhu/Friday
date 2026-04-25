import type { FridayRoleHierarchyLevel } from "../model/friday-multi-tenant-security.types.js";

const ROLE_ALIASES: Readonly<Record<FridayRoleHierarchyLevel, readonly string[]>> = {
  viewer: ["viewer", "role_viewer", "tenant_viewer", "workspace_viewer", "t_viewer", "ws_viewer"],
  member: ["member", "role_member", "tenant_member", "workspace_member", "t_member", "ws_member"],
  workspace_admin: ["workspace_admin", "workspaceadmin", "ws_admin"],
  tenant_admin: ["tenant_admin", "tenantadmin", "t_admin"],
  superadmin: ["superadmin", "system_superadmin", "role_superadmin", "globalsuperadmin", "global_superadmin", "superadmin_global"],
};

export function normalizeRoleLabel(role: string): string {
  return role.trim().toLowerCase().replaceAll(/[:\s-]+/g, "_");
}

export function resolveRoleHierarchyLevelFromLabel(role: string): FridayRoleHierarchyLevel | null {
  const normalized = normalizeRoleLabel(role);
  for (const [level, aliases] of Object.entries(ROLE_ALIASES) as Array<[FridayRoleHierarchyLevel, readonly string[]]>) {
    if (aliases.includes(normalized)) {
      return level;
    }
  }
  return null;
}

export function isSuperadminRoleLabel(role: string): boolean {
  return resolveRoleHierarchyLevelFromLabel(role) === "superadmin";
}
