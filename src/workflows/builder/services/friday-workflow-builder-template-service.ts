import { FridayDomainError } from "#errors";
import type { FridaySqliteLayer } from "#state";
import type { UUID } from "../../model/friday-workflow.types.js";
import type { FridayWorkflowSpecV1 } from "../../model/friday-workflow-spec.types.js";
import type { FridayWorkflowVisualGraphV1 } from "../model/friday-workflow-builder-canvas.types.js";
import type {
  FridayWorkflowTemplateEntity,
  FridayWorkflowTemplateScope,
} from "../model/friday-workflow-builder-template.types.js";
import type { FridayWorkflowDraftEntity } from "../model/friday-workflow-builder-draft.types.js";
import type { FridayWorkflowBuilderTemplateRepository } from "../persistence/friday-workflow-builder-template-repository.js";
import type { FridayWorkflowBuilderDraftService } from "./friday-workflow-builder-draft-service.js";
import type { FridaySkillRepository } from "#skills";
import type { FridaySkillRegistry } from "#skills";

// ─── Interface ───

export interface FridayWorkflowBuilderTemplateService {
  listTemplates(scope?: FridayWorkflowTemplateScope, ownerUserId?: UUID): FridayWorkflowTemplateEntity[];
  getTemplate(templateId: string): FridayWorkflowTemplateEntity | null;
  createUserTemplate(input: {
    name: string;
    description?: string;
    tags: string[];
    ownerUserId: UUID;
    spec: FridayWorkflowSpecV1;
    visual: FridayWorkflowVisualGraphV1;
  }): FridayWorkflowTemplateEntity;
  updateUserTemplate(templateId: string, update: {
    name?: string;
    description?: string;
    tags?: string[];
  }): FridayWorkflowTemplateEntity;
  deleteUserTemplate(templateId: string): void;
  instantiateTemplate(templateId: string, workflowId: UUID, title: string, ownerUserId?: UUID): FridayWorkflowDraftEntity;
}

// ─── Dependencies ───

export interface CreateTemplateServiceDeps {
  db: FridaySqliteLayer;
  templateRepo: FridayWorkflowBuilderTemplateRepository;
  draftService: FridayWorkflowBuilderDraftService;
  builtinTemplates: FridayWorkflowTemplateEntity[];
  skillRepo?: FridaySkillRepository;
  skillRegistry?: FridaySkillRegistry;
  idGenerator: () => string;
  nowIso: () => string;
}

// ─── Factory ───

export function createFridayWorkflowBuilderTemplateService(
  deps: CreateTemplateServiceDeps,
): FridayWorkflowBuilderTemplateService {
  /** Derive templates from installed skills that support workflow mode. */
  function getSkillDerivedTemplates(): FridayWorkflowTemplateEntity[] {
    const installed = deps.skillRepo
      ? deps.db.withReadConnection((db) => deps.skillRepo!.listInstalled(db))
      : [];
    const registered = deps.skillRegistry
      ? deps.skillRegistry.list().map((skill) => ({
        id: skill.manifest.id,
        currentManifest: skill.manifest,
      }))
      : [];
    const discovered = [...installed, ...registered];
    const seenSkillIds = new Set<string>();
    return discovered
      .filter((s) => {
        if (!s.currentManifest) {
          return false;
        }
        if (seenSkillIds.has(s.id)) {
          return false;
        }
        if (!s.currentManifest.invocation.modes.includes("workflow")) {
          return false;
        }
        seenSkillIds.add(s.id);
        return true;
      })
      .map((s) => {
        const manifest = s.currentManifest!;
        const now = deps.nowIso();
        return {
          templateId: `skill-${s.id}`,
          kind: "skill" as const,
          scope: "global" as const,
          sourceSkillId: s.id,
          name: manifest.name,
          description: manifest.description,
          tags: manifest.tags,
          spec: {
            schemaVersion: "1.0" as const,
            workflowId: "",
            name: manifest.name,
            description: manifest.description,
            startStepId: "step-1",
            trigger: { type: "manual" as const },
            inputs: manifest.inputs.map((inp) => ({
              key: inp.key,
              type: (
                inp.type === "file" || inp.type === "secret"
                  ? "string"
                  : inp.type
              ) as "string" | "number" | "boolean" | "object" | "array",
              required: inp.required,
              defaultValue: inp.defaultValue,
            })),
            steps: [
              {
                id: "step-1",
                type: "skill_call" as const,
                ref: s.id,
              },
            ],
            edges: [],
            outputs: manifest.outputs.map((o) => ({
              key: o.key,
              fromStep: "step-1",
              path: o.key,
            })),
            errorPolicy: { onFailure: "fail_fast" as const, notifyUser: false },
            tests: [],
          },
          visual: {
            schemaVersion: "1.0" as const,
            workflowId: "",
            viewport: { x: 0, y: 0, zoom: 1 },
            panelLayout: { leftOpen: true, rightOpen: false, bottomOpen: false },
            nodes: [
              { nodeId: "__trigger__", x: 0, y: 0 },
              { nodeId: "step-1", x: 250, y: 0 },
            ],
            edges: [],
          },
          createdAt: now,
          updatedAt: now,
        } satisfies FridayWorkflowTemplateEntity;
      });
  }

  return {
    listTemplates(scope, ownerUserId) {
      const userTemplates = deps.db.withReadConnection((db) =>
        deps.templateRepo.list(db, scope, ownerUserId),
      );

      // Merge with skill-derived and builtins if no scope filter or scope is "global"
      if (!scope || scope === "global") {
        const skillTemplates = getSkillDerivedTemplates();

        // Precedence: user > skill > builtin
        const userNames = new Set(userTemplates.map((t) => t.name));
        const skillFiltered = skillTemplates.filter(
          (st) => !userNames.has(st.name),
        );
        const mergedNames = new Set([
          ...userNames,
          ...skillFiltered.map((t) => t.name),
        ]);
        const builtinFiltered = deps.builtinTemplates.filter(
          (bt) => !mergedNames.has(bt.name),
        );
        return [...builtinFiltered, ...skillFiltered, ...userTemplates];
      }

      return userTemplates;
    },

    getTemplate(templateId) {
      // Check user templates first (highest precedence)
      const userTemplate = deps.db.withReadConnection((db) =>
        deps.templateRepo.getById(db, templateId),
      );
      if (userTemplate) return userTemplate;

      // Check skill-derived templates
      const skillTemplates = getSkillDerivedTemplates();
      const skillMatch = skillTemplates.find((t) => t.templateId === templateId);
      if (skillMatch) return skillMatch;

      // Check builtins last
      const builtin = deps.builtinTemplates.find((t) => t.templateId === templateId);
      if (builtin) return builtin;

      return null;
    },

    createUserTemplate(input) {
      const now = deps.nowIso();
      const template: FridayWorkflowTemplateEntity = {
        templateId: deps.idGenerator(),
        kind: "user",
        scope: "user",
        ownerUserId: input.ownerUserId,
        name: input.name,
        description: input.description,
        tags: input.tags,
        spec: input.spec,
        visual: input.visual,
        createdAt: now,
        updatedAt: now,
      };

      deps.db.withWriteTransaction((db) => {
        deps.templateRepo.create(db, template);
      });

      return template;
    },

    updateUserTemplate(templateId, update) {
      return deps.db.withWriteTransaction((db) => {
        const existing = deps.templateRepo.getById(db, templateId);
        if (!existing) throw new FridayDomainError("TEMPLATE_NOT_FOUND", "Template not found", { httpStatus: 404 });
        if (existing.kind !== "user") throw new FridayDomainError("TEMPLATE_NOT_USER_OWNED", "Template is not user-owned", { httpStatus: 403 });

        const updated: FridayWorkflowTemplateEntity = {
          ...existing,
          name: update.name ?? existing.name,
          description: update.description ?? existing.description,
          tags: update.tags ?? existing.tags,
          updatedAt: deps.nowIso(),
        };

        deps.templateRepo.update(db, updated);
        return updated;
      });
    },

    deleteUserTemplate(templateId) {
      deps.db.withWriteTransaction((db) => {
        const existing = deps.templateRepo.getById(db, templateId);
        if (!existing) throw new FridayDomainError("TEMPLATE_NOT_FOUND", "Template not found", { httpStatus: 404 });
        if (existing.kind !== "user") throw new FridayDomainError("TEMPLATE_NOT_USER_OWNED", "Template is not user-owned", { httpStatus: 403 });
        deps.templateRepo.delete(db, templateId);
      });
    },

    instantiateTemplate(templateId, workflowId, title, ownerUserId) {
      const template = this.getTemplate(templateId);
      if (!template) throw new FridayDomainError("TEMPLATE_NOT_FOUND", "Template not found", { httpStatus: 404 });

      // Clone spec and visual, rebind workflowId
      const spec: FridayWorkflowSpecV1 = {
        ...JSON.parse(JSON.stringify(template.spec)) as FridayWorkflowSpecV1,
        workflowId,
      };

      const visual: FridayWorkflowVisualGraphV1 = {
        ...JSON.parse(JSON.stringify(template.visual)) as FridayWorkflowVisualGraphV1,
        workflowId,
      };

      return deps.draftService.createDraft({
        workflowId,
        title,
        spec,
        visual,
        ownerUserId,
      });
    },
  };
}
