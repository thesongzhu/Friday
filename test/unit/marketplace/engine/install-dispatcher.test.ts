import { describe, expect, it } from "vitest";
import { dispatchInstall } from "../../../../src/marketplace/engine/install-dispatcher.js";

describe("dispatchInstall", () => {
  const baseListing = {
    id: "listing-1",
    publisherId: "pub-1",
    slug: "agent-a",
    status: "published",
    currentVersionId: "ver-1",
    pendingVersionId: null,
    tenantId: "tenant-a",
    tags: [],
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
  } as const;

  const baseVersion = {
    id: "ver-1",
    listingId: "listing-1",
    versionNumber: 1,
    status: "approved",
    title: "Agent A",
    description: "desc",
    longDescription: null,
    screenshotUrls: [],
    packageName: "@friday/agent-a",
    packageVersion: "1.0.0",
    assetType: "agent",
    distributionMode: "declarative_public" as const,
    permissionManifest: {
      permissions: [],
      requiresExplicitApproval: false,
    },
    pricingPlan: { type: "free" as const },
    releaseNotes: null,
    createdAt: "2026-03-01T00:00:00.000Z",
  } as const;

  const deps = {
    generateId: () => "inst-1",
    now: () => "2026-03-01T00:10:00.000Z",
  };

  it("returns installed record for valid input", () => {
    const result = dispatchInstall(
      {
        tenantId: "tenant-b",
        principalId: "user-b",
        listing: baseListing,
        version: baseVersion,
      },
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.idempotent).toBe(false);
    expect(result.value.installation.status).toBe("installed");
    expect(result.value.installation.id).toBe("inst-1");
  });

  it("returns idempotent when same version is already installed", () => {
    const existing = {
      id: "inst-existing",
      tenantId: "tenant-b",
      principalId: "user-b",
      listingId: "listing-1",
      assetType: "agent" as const,
      packageName: "@friday/agent-a",
      packageVersion: "1.0.0",
      status: "installed" as const,
      lastError: null,
      installedAt: "2026-03-01T00:00:00.000Z",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    };

    const result = dispatchInstall(
      {
        tenantId: "tenant-b",
        principalId: "user-b",
        listing: baseListing,
        version: baseVersion,
        existingInstallation: existing,
      },
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.idempotent).toBe(true);
    expect(result.value.installation).toEqual(existing);
  });

  it("rejects listing that is not published", () => {
    const result = dispatchInstall(
      {
        tenantId: "tenant-b",
        principalId: "user-b",
        listing: { ...baseListing, status: "draft" },
        version: baseVersion,
      },
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INSTALL_LISTING_NOT_INSTALLABLE");
  });

  it("rejects version that is not approved", () => {
    const result = dispatchInstall(
      {
        tenantId: "tenant-b",
        principalId: "user-b",
        listing: baseListing,
        version: { ...baseVersion, status: "draft" },
      },
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INSTALL_VERSION_NOT_APPROVED");
  });

  it("rejects agent installs when disabled by policy", () => {
    const result = dispatchInstall(
      {
        tenantId: "tenant-b",
        principalId: "user-b",
        listing: baseListing,
        version: baseVersion,
      },
      { ...deps, agentAssetEnabled: false },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INSTALL_AGENT_ASSET_DISABLED");
  });

  it("rejects legacy executable assets from public install flow", () => {
    const result = dispatchInstall(
      {
        tenantId: "tenant-b",
        principalId: "user-b",
        listing: baseListing,
        version: { ...baseVersion, distributionMode: "legacy_executable" },
      },
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INSTALL_LEGACY_EXECUTABLE_ASSET");
  });
});
