import { readFileSync } from "node:fs";
import { z } from "zod";
import type { FridayPhaseTaskpack } from "./friday-openclaw-phase.types.js";

const FridayPhaseCommandSchema = z.object({
  label: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  optional: z.boolean().optional(),
}).strict();

const FridayPhaseWorkerSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  runner: z.literal("command"),
  mode: z.enum(["implementation", "repair", "stabilize", "closure"]).optional(),
  steps: z.array(FridayPhaseCommandSchema).min(1),
  allowedPaths: z.array(z.string().min(1)).optional(),
  successCriteria: z.array(z.string().min(1)).optional(),
  outputContract: z.array(z.string().min(1)).optional(),
  continueOnFailure: z.boolean().optional(),
}).strict();

const FridayArchitectureBoundaryRuleSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  pathPrefixes: z.array(z.string().min(1)).min(1),
  verdict: z.enum(["no_impact", "additive_internal", "additive_public", "blocked"]).optional(),
}).strict();

export const FRIDAY_OPENCLAW_PHASE_TASKPACK_SCHEMA: z.ZodType<FridayPhaseTaskpack> = z.object({
  schemaVersion: z.literal("1.0"),
  phaseId: z.string().min(1),
  title: z.string().min(1),
  executionMode: z.enum(["automated", "spec_only"]),
  goal: z.string().min(1),
  allowedPaths: z.array(z.string().min(1)).min(1),
  implementationWorkers: z.array(FridayPhaseWorkerSchema).min(1),
  repairWorker: FridayPhaseWorkerSchema.optional(),
  successCriteria: z.array(z.string().min(1)).min(1),
  gates: z.object({
    fastLocal: z.array(FridayPhaseCommandSchema).optional(),
    prePr: z.array(FridayPhaseCommandSchema).optional(),
    postMerge: z.array(FridayPhaseCommandSchema).optional(),
    finalClosure: z.array(FridayPhaseCommandSchema).optional(),
  }).strict().optional(),
  closureEvidence: z.array(z.string().min(1)).optional(),
  forbiddenBoundaries: z.array(FridayArchitectureBoundaryRuleSchema).min(1),
  notes: z.array(z.string().min(1)).optional(),
}).strict();

export function parseFridayOpenClawPhaseTaskpack(input: unknown): FridayPhaseTaskpack {
  return FRIDAY_OPENCLAW_PHASE_TASKPACK_SCHEMA.parse(input);
}

export function loadFridayOpenClawPhaseTaskpack(taskpackPath: string): FridayPhaseTaskpack {
  const raw = readFileSync(taskpackPath, "utf-8");
  return parseFridayOpenClawPhaseTaskpack(JSON.parse(raw));
}
