import { FridayDomainError } from "#errors";
import type { FridaySqliteLayer } from "#state";
import type { FridaySkillRepository } from "../../skills/persistence/friday-skill-repository.js";
import type { FridayAutonomyCanaryStats } from "../model/friday-autonomy-upgrade.types.js";
import type { FridaySkillEntity } from "../../skills/model/friday-skill-catalog.types.js";

export interface FridaySkillUpgradeLifecycleService {
  registerShadowVersion(input: {
    skillId: string;
    shadowVersionId: string;
    runtimeVersion: string;
    providerModel?: string;
  }): FridaySkillEntity;
  recordCanaryResult(input: {
    skillId: string;
    success: boolean;
    evaluatedAt?: string;
  }): FridaySkillEntity;
  promote(input: {
    skillId: string;
    runtimeVersion: string;
    providerModel?: string;
  }): FridaySkillEntity;
  rollback(input: {
    skillId: string;
    runtimeVersion: string;
    providerModel?: string;
  }): FridaySkillEntity;
}

export interface CreateFridaySkillUpgradeLifecycleServiceDeps {
  db: FridaySqliteLayer;
  skillRepo: FridaySkillRepository;
  nowIso: () => string;
}

export function createFridaySkillUpgradeLifecycleService(
  deps: CreateFridaySkillUpgradeLifecycleServiceDeps,
): FridaySkillUpgradeLifecycleService {
  function getSkill(skillId: string): FridaySkillEntity {
    const skill = deps.db.withReadConnection((db) => deps.skillRepo.getSkillById(db, skillId));
    if (!skill) {
      throw new FridayDomainError("SKILL_NOT_FOUND", `Skill "${skillId}" not found`, { httpStatus: 404 });
    }
    return skill;
  }

  function updateSkill(
    skillId: string,
    patch: Parameters<FridaySkillRepository["setUpgradeMetadata"]>[2],
  ): FridaySkillEntity {
    return deps.db.withWriteTransaction((db) => {
      const updated = deps.skillRepo.setUpgradeMetadata(db, skillId, patch, deps.nowIso());
      if (!updated) {
        throw new FridayDomainError("SKILL_NOT_FOUND", `Skill "${skillId}" not found`, { httpStatus: 404 });
      }
      return updated;
    });
  }

  return {
    registerShadowVersion(input) {
      return updateSkill(input.skillId, {
        compatibilityStatus: "adaptation_required",
        promotionChannel: "shadow",
        shadowVersionId: input.shadowVersionId,
        lastVerifiedRuntimeVersion: input.runtimeVersion,
        lastVerifiedProviderModel: input.providerModel,
      });
    },

    recordCanaryResult(input) {
      const skill = getSkill(input.skillId);
      const current = skill.canaryStats ?? {
        sampleSize: 0,
        successCount: 0,
        failureCount: 0,
        rollbackCount: 0,
      } satisfies FridayAutonomyCanaryStats;

      return updateSkill(input.skillId, {
        compatibilityStatus: input.success ? "compatible" : "adaptation_required",
        promotionChannel: "canary",
        canaryStats: {
          sampleSize: current.sampleSize + 1,
          successCount: current.successCount + (input.success ? 1 : 0),
          failureCount: current.failureCount + (input.success ? 0 : 1),
          rollbackCount: current.rollbackCount,
          lastEvaluatedAt: input.evaluatedAt ?? deps.nowIso(),
        },
      });
    },

    promote(input) {
      const skill = getSkill(input.skillId);
      return updateSkill(input.skillId, {
        compatibilityStatus: "compatible",
        promotionChannel: "active",
        shadowVersionId: skill.shadowVersionId,
        canaryStats: skill.canaryStats,
        lastVerifiedAt: deps.nowIso(),
        lastVerifiedRuntimeVersion: input.runtimeVersion,
        lastVerifiedProviderModel: input.providerModel,
      });
    },

    rollback(input) {
      const skill = getSkill(input.skillId);
      const current = skill.canaryStats ?? {
        sampleSize: 0,
        successCount: 0,
        failureCount: 0,
        rollbackCount: 0,
      } satisfies FridayAutonomyCanaryStats;

      return updateSkill(input.skillId, {
        compatibilityStatus: "adaptation_required",
        promotionChannel: "rolled_back",
        shadowVersionId: null,
        canaryStats: {
          sampleSize: current.sampleSize,
          successCount: current.successCount,
          failureCount: current.failureCount,
          rollbackCount: current.rollbackCount + 1,
          lastEvaluatedAt: deps.nowIso(),
        },
        lastVerifiedRuntimeVersion: input.runtimeVersion,
        lastVerifiedProviderModel: input.providerModel,
      });
    },
  };
}
