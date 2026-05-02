import type { FridayProviderAuthMode, FridayProviderKind, FridayProviderTemplate } from "@/lib/api/types";

export type ProviderConnectionMode = "api-key" | "use-my-plan";

const KEY_AUTH_MODE_ORDER: FridayProviderAuthMode[] = ["api-key", "bearer-token", "token"];

export function supportsUseMyPlan(kind: FridayProviderKind, template?: Pick<FridayProviderTemplate, "authModes"> | null): boolean {
  return kind === "openai-codex" && (template ? template.authModes.includes("oauth") : true);
}

export function resolveKeyAuthMode(template?: Pick<FridayProviderTemplate, "authModes"> | null): FridayProviderAuthMode {
  return KEY_AUTH_MODE_ORDER.find((mode) => template?.authModes.includes(mode)) ?? "api-key";
}

export function supportsKeyConnection(template?: Pick<FridayProviderTemplate, "authModes"> | null): boolean {
  if (!template) return true;
  return KEY_AUTH_MODE_ORDER.some((mode) => template.authModes.includes(mode));
}

export function defaultConnectionModeForProvider(
  kind: FridayProviderKind,
  template?: Pick<FridayProviderTemplate, "authModes"> | null,
): ProviderConnectionMode {
  return supportsUseMyPlan(kind, template) && template?.authModes[0] === "oauth"
    ? "use-my-plan"
    : "api-key";
}

