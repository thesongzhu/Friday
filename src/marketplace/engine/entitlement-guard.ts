import type {
  FridayEntitlement,
  FridayInstallation,
  UUID,
} from "../model/friday-marketplace.types.js";

export const ENTITLEMENT_GUARD_ERROR_CODES = {
  ENTITLEMENT_REQUIRED: "MARKETPLACE_ENTITLEMENT_REQUIRED",
  INSTALL_REQUIRED: "MARKETPLACE_INSTALL_REQUIRED",
} as const;

export type EntitlementGuardErrorCode =
  (typeof ENTITLEMENT_GUARD_ERROR_CODES)[keyof typeof ENTITLEMENT_GUARD_ERROR_CODES];

export interface EntitlementGuardError {
  readonly code: EntitlementGuardErrorCode;
  readonly message: string;
  readonly httpStatus: 403;
}

export type EntitlementGuardResult =
  | {
    readonly ok: true;
    readonly value: {
      readonly entitlement: FridayEntitlement;
      readonly installation: FridayInstallation | null;
    };
  }
  | {
    readonly ok: false;
    readonly error: EntitlementGuardError;
  };

export interface EntitlementGuardInput {
  readonly listingId: UUID;
  readonly tenantId: string;
  readonly principalId: string;
}

export interface EntitlementGuardDeps {
  readonly listEntitlements: (filters: { tenantId: string; listingId: UUID }) => Promise<FridayEntitlement[]>;
  readonly listInstallations: (filters: {
    tenantId: string;
    listingId: UUID;
    status: "installed";
  }) => Promise<FridayInstallation[]>;
  readonly requireInstallation?: boolean;
}

export async function assertListingExecutionReady(
  input: EntitlementGuardInput,
  deps: EntitlementGuardDeps,
): Promise<EntitlementGuardResult> {
  const entitlements = await deps.listEntitlements({
    tenantId: input.tenantId,
    listingId: input.listingId,
  });
  const active = entitlements.find((entitlement) =>
    entitlement.principalId === input.principalId
    && (entitlement.status === "active" || entitlement.status === "grace")
  );
  if (!active) {
    return {
      ok: false,
      error: {
        code: ENTITLEMENT_GUARD_ERROR_CODES.ENTITLEMENT_REQUIRED,
        message: "Listing entitlement required before execution",
        httpStatus: 403,
      },
    };
  }

  const requireInstallation = deps.requireInstallation ?? true;
  if (!requireInstallation) {
    return {
      ok: true,
      value: {
        entitlement: active,
        installation: null,
      },
    };
  }

  const installations = await deps.listInstallations({
    tenantId: input.tenantId,
    listingId: input.listingId,
    status: "installed",
  });
  const installation = installations.find((candidate) => candidate.principalId === input.principalId) ?? null;
  if (!installation) {
    return {
      ok: false,
      error: {
        code: ENTITLEMENT_GUARD_ERROR_CODES.INSTALL_REQUIRED,
        message: "Listing installation required before execution",
        httpStatus: 403,
      },
    };
  }

  return {
    ok: true,
    value: {
      entitlement: active,
      installation,
    },
  };
}
