import type { LoadedFridayConfig } from "#config";
import type { FridaySkillSecurityProfile } from "#skills";

export interface FridayConfigValidationError {
  field: string;
  rule: string;
  message: string;
}

export interface FridayConfigRevisionRecord {
  id: string;
  revision: number;
  patch: Record<string, unknown>;
  fullSnapshot: Record<string, unknown>;
  changedKeys: string[];
  changedByUserId?: string;
  reason?: string;
  createdAt: string;
}

export interface FridaySkillRegistrySettings {
  workspaceDir: string;
  bundledSkillsDir: string;
  managedSkillsDir: string;
  extraSkillDirs: string[];
  watchEnabled: boolean;
  watchDebounceMs: number;
}

export interface FridayHubConfigManagerService {
  /** Returns typed Phase 0 config snapshot from config IO subsystem. */
  getCurrentConfig(): Promise<LoadedFridayConfig>;
  getConfig(keys?: string[]): Promise<{ revision: number; settings: Record<string, unknown> }>;
  validatePatch(patch: Record<string, unknown>): Promise<{
    valid: boolean;
    errors: FridayConfigValidationError[];
  }>;
  applyPatch(params: {
    expectedRevision: number;
    patch: Record<string, unknown>;
    reason?: string;
  }): Promise<{ revision: number; changedKeys: string[] }>;
  listRevisions(cursor?: string, limit?: number): Promise<{
    items: FridayConfigRevisionRecord[];
    nextCursor?: string;
  }>;
  revertToRevision(toRevision: number): Promise<{
    revision: number;
    changedKeys: string[];
    revertedFrom: number;
  }>;
  /** Provides resolved roots and watch options for skill registry discovery. */
  getSkillRegistrySettings(workspaceDir: string): Promise<FridaySkillRegistrySettings>;
  /** Provides admin trust/sandbox overrides for trust enforcement. */
  getSkillSecurityProfile(): Promise<FridaySkillSecurityProfile>;
}
