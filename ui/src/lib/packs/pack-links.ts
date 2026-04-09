import { getPackById, type FridayPackDefinition } from "./pack-registry";

export function buildPackAssistantHref(packId: string): string {
  return `/assistant?packId=${encodeURIComponent(packId)}`;
}

export function buildPackChatHref(packId: string, prompt?: string): string {
  const searchParams = new URLSearchParams({
    packId,
  });
  if (typeof prompt === "string" && prompt.trim().length > 0) {
    searchParams.set("prompt", prompt);
  }
  return `/chat?${searchParams.toString()}`;
}

export function buildPackFlowHref(
  pack: FridayPackDefinition,
  options?: {
    mode?: "adjust";
  },
): string {
  if (pack.id === "industry-cross-border-ecommerce") {
    const searchParams = new URLSearchParams({
      packId: pack.id,
    });
    if (options?.mode === "adjust") {
      searchParams.set("mode", "adjust");
    }
    return `/packs/cross-border/setup?${searchParams.toString()}`;
  }
  const searchParams = new URLSearchParams({
    packId: pack.id,
  });
  if (options?.mode === "adjust") {
    searchParams.set("mode", "adjust");
  }
  return `/flow/${encodeURIComponent(pack.defaultLauncher.wizardId)}?${searchParams.toString()}`;
}

export function resolvePackLaunchContext(
  wizardId: string | undefined,
  packId: string | null | undefined,
): FridayPackDefinition | null {
  if (!wizardId || !packId) {
    return null;
  }

  const pack = getPackById(packId) ?? null;
  if (!pack || pack.defaultLauncher.wizardId !== wizardId) {
    return null;
  }

  return pack;
}
