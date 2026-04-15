export interface FridayCapabilityGates {
  desktopEnabled: boolean;
  systemEnabled: boolean;
  discoveryEnabled: boolean;
  mcpServerEnabled: boolean;
  marketplaceCommerceEnabled: boolean;
  marketplaceInstallRequired: boolean;
  marketplaceInstallMaterialize: boolean;
  heartbeatEnabled: boolean;
  heartbeatActiveHoursEnabled: boolean;
  autoFixDispatchEnabled: boolean;
}

function envEqualsTrue(raw: string | undefined): boolean {
  return raw === "true";
}

function envNotFalse(raw: string | undefined): boolean {
  return raw !== "false";
}

export function resolveFridayCapabilityGates(
  env: NodeJS.ProcessEnv = process.env,
): FridayCapabilityGates {
  return {
    desktopEnabled: envEqualsTrue(env.FRIDAY_DESKTOP_ENABLED),
    systemEnabled: envNotFalse(env.FRIDAY_SYSTEM_ENABLED),
    discoveryEnabled: envNotFalse(env.FRIDAY_DISCOVERY_ENABLED),
    mcpServerEnabled: envEqualsTrue(env.FRIDAY_MCP_SERVER_ENABLED),
    marketplaceCommerceEnabled: envNotFalse(env.FRIDAY_MARKETPLACE_COMMERCE_ENABLED),
    marketplaceInstallRequired: envNotFalse(env.FRIDAY_MARKETPLACE_INSTALL_REQUIRED),
    marketplaceInstallMaterialize: envNotFalse(env.FRIDAY_MARKETPLACE_INSTALL_MATERIALIZE),
    heartbeatEnabled: envEqualsTrue(env.FRIDAY_HEARTBEAT_ENABLED),
    heartbeatActiveHoursEnabled: envNotFalse(env.FRIDAY_HEARTBEAT_ACTIVE_HOURS_ENABLED),
    autoFixDispatchEnabled: envNotFalse(env.FRIDAY_AUTOFIX_DISPATCHER_ENABLED),
  };
}
