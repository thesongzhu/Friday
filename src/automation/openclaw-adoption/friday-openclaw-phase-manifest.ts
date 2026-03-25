import { readFileSync } from "node:fs";
import { z } from "zod";
import type { FridayPhaseManifest } from "./friday-openclaw-phase.types.js";

const FridayPhaseCommandSchema = z.object({
  label: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  optional: z.boolean().optional(),
}).strict();

const FridayPhaseDefinitionSchema = z.object({
  id: z.string().min(1),
  number: z.number().int().min(0),
  slug: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  dependsOn: z.array(z.string()),
  allowedPaths: z.array(z.string()),
  successCriteria: z.array(z.string()),
  implementation: z.object({
    mode: z.enum(["manual", "shell"]),
    command: FridayPhaseCommandSchema.optional(),
  }).strict(),
  gates: z.object({
    fastLocal: z.array(FridayPhaseCommandSchema),
    prePr: z.array(FridayPhaseCommandSchema),
    postMerge: z.array(FridayPhaseCommandSchema),
  }).strict(),
}).strict();

export const FRIDAY_OPENCLAW_PHASE_MANIFEST_SCHEMA: z.ZodType<FridayPhaseManifest> = z.object({
  schemaVersion: z.literal("1.0"),
  programId: z.literal("openclaw-adoption"),
  title: z.string().min(1),
  repo: z.object({
    mainBranch: z.string().min(1),
    branchPrefix: z.string().min(1),
    mergeStrategy: z.enum(["squash", "merge", "rebase"]),
    requiredChecks: z.array(z.string().min(1)).min(1),
    failurePolicy: z.enum(["limited-self-heal-then-pause", "pause-immediately"]),
    maxAutoRepairAttempts: z.number().int().min(0),
  }).strict(),
  guardrails: z.array(z.string().min(1)),
  phases: z.array(FridayPhaseDefinitionSchema).min(1),
}).strict();

export function parseFridayOpenClawPhaseManifest(input: unknown): FridayPhaseManifest {
  return FRIDAY_OPENCLAW_PHASE_MANIFEST_SCHEMA.parse(input);
}

export function loadFridayOpenClawPhaseManifest(manifestPath: string): FridayPhaseManifest {
  const raw = readFileSync(manifestPath, "utf-8");
  return parseFridayOpenClawPhaseManifest(JSON.parse(raw));
}
