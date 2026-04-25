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

export function resolveFridayCapabilityGates(
  env: NodeJS.ProcessEnv = process.env,
): FridayCapabilityGates {
  return {
    desktopEnabled: envEqualsTrue(env.FRIDAY_DESKTOP_ENABLED),
    systemEnabled: envEqualsTrue(env.FRIDAY_SYSTEM_ENABLED),
    discoveryEnabled: envEqualsTrue(env.FRIDAY_DISCOVERY_ENABLED),
    mcpServerEnabled: envEqualsTrue(env.FRIDAY_MCP_SERVER_ENABLED),
    marketplaceCommerceEnabled: envEqualsTrue(env.FRIDAY_MARKETPLACE_COMMERCE_ENABLED),
    marketplaceInstallRequired: envEqualsTrue(env.FRIDAY_MARKETPLACE_INSTALL_REQUIRED),
    marketplaceInstallMaterialize: envEqualsTrue(env.FRIDAY_MARKETPLACE_INSTALL_MATERIALIZE),
    heartbeatEnabled: envEqualsTrue(env.FRIDAY_HEARTBEAT_ENABLED),
    heartbeatActiveHoursEnabled: envEqualsTrue(env.FRIDAY_HEARTBEAT_ACTIVE_HOURS_ENABLED),
    autoFixDispatchEnabled: envEqualsTrue(env.FRIDAY_AUTOFIX_DISPATCHER_ENABLED),
  };
}
