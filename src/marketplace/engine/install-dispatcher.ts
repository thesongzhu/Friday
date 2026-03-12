/**
 * Marketplace install dispatcher.
 *
 * Performs minimal install-safety checks and produces deterministic
 * installation state transitions for skill/workflow/agent assets.
 */

import { FRIDAY_MARKETPLACE_ASSET_TYPES } from "../model/friday-marketplace.types.js";
import type {
  FridayInstallation,
  FridayListing,
  FridayListingVersion,
  ISODateTime,
  UUID,
} from "../model/friday-marketplace.types.js";

export const INSTALL_DISPATCH_ERROR_CODES = {
  LISTING_NOT_INSTALLABLE: "INSTALL_LISTING_NOT_INSTALLABLE",
  VERSION_LISTING_MISMATCH: "INSTALL_VERSION_LISTING_MISMATCH",
  VERSION_NOT_APPROVED: "INSTALL_VERSION_NOT_APPROVED",
  LEGACY_EXECUTABLE_ASSET: "INSTALL_LEGACY_EXECUTABLE_ASSET",
  UNSUPPORTED_ASSET_TYPE: "INSTALL_UNSUPPORTED_ASSET_TYPE",
  AGENT_ASSET_DISABLED: "INSTALL_AGENT_ASSET_DISABLED",
} as const;

export type InstallDispatchErrorCode =
  (typeof INSTALL_DISPATCH_ERROR_CODES)[keyof typeof INSTALL_DISPATCH_ERROR_CODES];

export interface InstallDispatchError {
  readonly code: InstallDispatchErrorCode;
  readonly message: string;
}

export type InstallDispatchResult =
  | {
    readonly ok: true;
    readonly value: {
      readonly installation: FridayInstallation;
      readonly idempotent: boolean;
    };
  }
  | {
    readonly ok: false;
    readonly error: InstallDispatchError;
  };

export interface DispatchInstallInput {
  readonly tenantId: string;
  readonly principalId: string;
  readonly listing: FridayListing;
  readonly version: FridayListingVersion;
  readonly existingInstallation?: FridayInstallation | null;
}

export interface InstallDispatcherDeps {
  readonly generateId: () => UUID;
  readonly now: () => ISODateTime;
  readonly agentAssetEnabled?: boolean;
}

function normalizeDistributionMode(
  version: FridayListingVersion,
): FridayListingVersion["distributionMode"] {
  if (
    version.distributionMode === "declarative_public"
    || version.distributionMode === "legacy_executable"
  ) {
    return version.distributionMode;
  }
  return version.assetType === "skill" ? "legacy_executable" : "declarative_public";
}

export function dispatchInstall(
  input: DispatchInstallInput,
  deps: InstallDispatcherDeps,
): InstallDispatchResult {
  if (input.listing.status !== "published") {
    return {
      ok: false,
      error: {
        code: INSTALL_DISPATCH_ERROR_CODES.LISTING_NOT_INSTALLABLE,
        message: `Listing "${input.listing.id}" is not installable in status "${input.listing.status}"`,
      },
    };
  }

  if (input.version.listingId !== input.listing.id) {
    return {
      ok: false,
      error: {
        code: INSTALL_DISPATCH_ERROR_CODES.VERSION_LISTING_MISMATCH,
        message: `Version "${input.version.id}" does not belong to listing "${input.listing.id}"`,
      },
    };
  }

  if (input.version.status !== "approved") {
    return {
      ok: false,
      error: {
        code: INSTALL_DISPATCH_ERROR_CODES.VERSION_NOT_APPROVED,
        message: `Version "${input.version.id}" must be approved before installation`,
      },
    };
  }

  const distributionMode = normalizeDistributionMode(input.version);
  if (distributionMode !== "declarative_public") {
    return {
      ok: false,
      error: {
        code: INSTALL_DISPATCH_ERROR_CODES.LEGACY_EXECUTABLE_ASSET,
        message: `Version "${input.version.id}" is not installable through the public marketplace because it is classified as "${distributionMode}"`,
      },
    };
  }

  if (!(FRIDAY_MARKETPLACE_ASSET_TYPES as readonly string[]).includes(input.version.assetType)) {
    return {
      ok: false,
      error: {
        code: INSTALL_DISPATCH_ERROR_CODES.UNSUPPORTED_ASSET_TYPE,
        message: `Asset type "${input.version.assetType}" is not supported`,
      },
    };
  }

  const agentAssetEnabled = deps.agentAssetEnabled ?? true;
  if (input.version.assetType === "agent" && !agentAssetEnabled) {
    return {
      ok: false,
      error: {
        code: INSTALL_DISPATCH_ERROR_CODES.AGENT_ASSET_DISABLED,
        message: "Agent asset installation is disabled by runtime policy",
      },
    };
  }

  if (
    input.existingInstallation
    && input.existingInstallation.status === "installed"
    && input.existingInstallation.packageVersion === input.version.packageVersion
  ) {
    return {
      ok: true,
      value: {
        installation: input.existingInstallation,
        idempotent: true,
      },
    };
  }

  const now = deps.now();
  const previous = input.existingInstallation ?? null;
  const installation: FridayInstallation = {
    id: previous?.id ?? deps.generateId(),
    tenantId: input.tenantId,
    principalId: input.principalId,
    listingId: input.listing.id,
    assetType: input.version.assetType,
    packageName: input.version.packageName,
    packageVersion: input.version.packageVersion,
    status: "installed",
    lastError: null,
    installedAt: now,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };

  return {
    ok: true,
    value: {
      installation,
      idempotent: false,
    },
  };
}
