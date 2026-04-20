import { describe, expect, it } from "vitest";

import { resolveFridayCapabilityGates } from "../../../../src/hub/bootstrap/friday-capability-gates.js";

describe("resolveFridayCapabilityGates", () => {
  it("uses safe defaults when env vars are missing", () => {
    const gates = resolveFridayCapabilityGates({});

    expect(gates.desktopEnabled).toBe(false);
    expect(gates.systemEnabled).toBe(true);
    expect(gates.discoveryEnabled).toBe(true);
    expect(gates.mcpServerEnabled).toBe(false);
    expect(gates.marketplaceCommerceEnabled).toBe(true);
    expect(gates.marketplaceInstallRequired).toBe(true);
    expect(gates.marketplaceInstallMaterialize).toBe(true);
    expect(gates.heartbeatEnabled).toBe(true);
    expect(gates.heartbeatActiveHoursEnabled).toBe(true);
    expect(gates.autoFixDispatchEnabled).toBe(true);
  });

  it("honors explicit overrides", () => {
    const gates = resolveFridayCapabilityGates({
      FRIDAY_DESKTOP_ENABLED: "true",
      FRIDAY_SYSTEM_ENABLED: "false",
      FRIDAY_DISCOVERY_ENABLED: "true",
      FRIDAY_MCP_SERVER_ENABLED: "true",
      FRIDAY_MARKETPLACE_COMMERCE_ENABLED: "false",
      FRIDAY_MARKETPLACE_INSTALL_REQUIRED: "false",
      FRIDAY_MARKETPLACE_INSTALL_MATERIALIZE: "false",
      FRIDAY_HEARTBEAT_ENABLED: "true",
      FRIDAY_HEARTBEAT_ACTIVE_HOURS_ENABLED: "false",
      FRIDAY_AUTOFIX_DISPATCHER_ENABLED: "false",
    });

    expect(gates.desktopEnabled).toBe(true);
    expect(gates.systemEnabled).toBe(false);
    expect(gates.discoveryEnabled).toBe(true);
    expect(gates.mcpServerEnabled).toBe(true);
    expect(gates.marketplaceCommerceEnabled).toBe(false);
    expect(gates.marketplaceInstallRequired).toBe(false);
    expect(gates.marketplaceInstallMaterialize).toBe(false);
    expect(gates.heartbeatEnabled).toBe(true);
    expect(gates.heartbeatActiveHoursEnabled).toBe(false);
    expect(gates.autoFixDispatchEnabled).toBe(false);
  });

  it("allows heartbeat to be explicitly disabled", () => {
    const gates = resolveFridayCapabilityGates({
      FRIDAY_HEARTBEAT_ENABLED: "false",
    });

    expect(gates.heartbeatEnabled).toBe(false);
  });
});
