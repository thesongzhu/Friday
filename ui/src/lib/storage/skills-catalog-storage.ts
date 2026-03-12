// ─── Skills catalog — local skill metadata ───

const STORAGE_KEY = "friday.skills.catalog.v1";

export interface SkillCatalogEntry {
  skillId: string;
  name: string;
  description: string;
  runtimeKind: string;
  icon?: string;
  installedAt: string;
  lastUsedAt?: string;
  source: "generator" | "import" | "server";
}

function load(): SkillCatalogEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as SkillCatalogEntry[];
  } catch {
    return [];
  }
}

function save(entries: SkillCatalogEntry[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

export const skillsCatalogStorage = {
  getAll(): SkillCatalogEntry[] {
    return load();
  },

  get(skillId: string): SkillCatalogEntry | undefined {
    return load().find((e) => e.skillId === skillId);
  },

  upsert(entries: SkillCatalogEntry[]): void {
    const existing = load();
    const map = new Map(existing.map((e) => [e.skillId, e]));
    for (const entry of entries) {
      map.set(entry.skillId, entry);
    }
    save([...map.values()]);
  },

  markUsed(skillId: string): void {
    const entries = load();
    const idx = entries.findIndex((e) => e.skillId === skillId);
    if (idx >= 0) {
      entries[idx] = { ...entries[idx], lastUsedAt: new Date().toISOString() };
      save(entries);
    }
  },

  remove(skillId: string): void {
    const entries = load().filter((e) => e.skillId !== skillId);
    save(entries);
  },
};
