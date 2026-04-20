import { FridayDomainError } from "#errors";

export interface FridayCapabilityDisabledInput {
  capability: string;
  surface: string;
  message: string;
  details?: Record<string, unknown>;
}

export function throwFridayCapabilityDisabled(input: FridayCapabilityDisabledInput): never {
  throw new FridayDomainError("CAPABILITY_DISABLED", input.message, {
    httpStatus: 501,
    details: {
      capability: input.capability,
      surface: input.surface,
      state: "disabled",
      ...(input.details ?? {}),
    },
  });
}
