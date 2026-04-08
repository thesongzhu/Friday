export type BuiltInPackKind = "industry" | "task";

export interface BuiltInPackCatalogEntry {
  packId: string;
  kind: BuiltInPackKind;
  builtIn: true;
  defaultWizardId: string;
}

export const FRIDAY_BUILT_IN_PACK_CATALOG: BuiltInPackCatalogEntry[] = [
  { packId: "industry-creator-media", kind: "industry", builtIn: true, defaultWizardId: "content-social" },
  { packId: "industry-cross-border-ecommerce", kind: "industry", builtIn: true, defaultWizardId: "ecommerce" },
  { packId: "industry-operations", kind: "industry", builtIn: true, defaultWizardId: "automate-work" },
  { packId: "industry-sales", kind: "industry", builtIn: true, defaultWizardId: "team-management" },
  { packId: "industry-small-business-owner", kind: "industry", builtIn: true, defaultWizardId: "team-management" },
  { packId: "industry-personal-investing", kind: "industry", builtIn: true, defaultWizardId: "invest-trade" },
  { packId: "task-build-new", kind: "task", builtIn: true, defaultWizardId: "build-new" },
  { packId: "task-fix-broken", kind: "task", builtIn: true, defaultWizardId: "fix-broken" },
  { packId: "task-ship-fast", kind: "task", builtIn: true, defaultWizardId: "ship-fast" },
  { packId: "task-understand-system", kind: "task", builtIn: true, defaultWizardId: "understand-system" },
  { packId: "task-automate-work", kind: "task", builtIn: true, defaultWizardId: "automate-work" },
  { packId: "task-content-social", kind: "task", builtIn: true, defaultWizardId: "content-social" },
  { packId: "task-ecommerce", kind: "task", builtIn: true, defaultWizardId: "ecommerce" },
  { packId: "task-team-management", kind: "task", builtIn: true, defaultWizardId: "team-management" },
  { packId: "task-ai-saas-build", kind: "task", builtIn: true, defaultWizardId: "ai-saas-build" },
  { packId: "task-invest-trade", kind: "task", builtIn: true, defaultWizardId: "invest-trade" },
];

const BUILT_IN_PACK_CATALOG_BY_ID = new Map(
  FRIDAY_BUILT_IN_PACK_CATALOG.map((entry) => [entry.packId, entry] as const),
);

export function getBuiltInPackCatalogEntry(packId: string): BuiltInPackCatalogEntry | undefined {
  return BUILT_IN_PACK_CATALOG_BY_ID.get(packId);
}

export function requireBuiltInPackCatalogEntry(packId: string): BuiltInPackCatalogEntry {
  const entry = getBuiltInPackCatalogEntry(packId);
  if (!entry) {
    throw new Error(`Unknown built-in pack: ${packId}`);
  }
  return entry;
}

export function listBuiltInPackCatalogEntries(): BuiltInPackCatalogEntry[] {
  return [...FRIDAY_BUILT_IN_PACK_CATALOG];
}
