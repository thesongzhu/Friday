import { describe, expect, it } from "vitest";
import { recommendFridayIntegrationMode } from "#agent";

describe("recommendFridayIntegrationMode", () => {
  it("prefers workflow nodes for multi-step local token-sensitive flows", () => {
    expect(
      recommendFridayIntegrationMode({
        localExecutable: true,
        requiresRemoteAuth: false,
        sharedAcrossUsers: false,
        tokenSensitive: true,
        needsStructuredResources: false,
        multiStepWorkflow: true,
      }).recommendation,
    ).toBe("prefer_workflow_node");
  });

  it("keeps MCP when remote auth or shared transport is needed", () => {
    expect(
      recommendFridayIntegrationMode({
        localExecutable: false,
        requiresRemoteAuth: true,
        sharedAcrossUsers: true,
        tokenSensitive: false,
        needsStructuredResources: true,
        multiStepWorkflow: false,
      }).recommendation,
    ).toBe("keep_mcp");
  });
});
