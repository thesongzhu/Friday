import { FridayDomainError } from "#errors";

const LEARNED_FACT_ID_PREFIX = "learned-fact:";
const LEARNED_FACT_SOURCE = "learned_fact";
const LEARNED_FACT_METADATA_CLAIMS: Record<string, unknown> = {
  learnedFact: true,
  trustLevel: "confidence_scored_learning",
  memoryBoundary: "separate_from_durable_memory",
  evidenceBoundary: "preference_fact_evidence",
  contextUseBoundary: "learning_context_service_gated",
  promptInjectionBoundary: "not_direct_prompt_injection",
  reviewBoundary: "not_review_center_confirmed",
  revocationBoundary: "clear_delete_or_synthetic_memory_delete",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasReservedLearnedFactMetadata(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata) return false;
  for (const [key, value] of Object.entries(LEARNED_FACT_METADATA_CLAIMS)) {
    if (metadata[key] === value) return true;
  }
  return false;
}

export function assertFridayDurableMemoryBoundaryAllowed(input: {
  id?: string;
  source?: string;
  key?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}): void {
  if (input.source === LEARNED_FACT_SOURCE) {
    throw new FridayDomainError(
      "MEMORY_BOUNDARY_RESERVED",
      "Durable memory writes cannot use the synthetic learned-fact source.",
      { httpStatus: 409 },
    );
  }
  if (input.id?.startsWith(LEARNED_FACT_ID_PREFIX) || input.key?.startsWith(LEARNED_FACT_ID_PREFIX)) {
    throw new FridayDomainError(
      "MEMORY_BOUNDARY_RESERVED",
      "Durable memory writes cannot use synthetic learned-fact ids.",
      { httpStatus: 409 },
    );
  }
  if (input.tags?.includes("preference_fact")) {
    throw new FridayDomainError(
      "MEMORY_BOUNDARY_RESERVED",
      "Durable memory writes cannot claim the preference-fact evidence boundary.",
      { httpStatus: 409 },
    );
  }
  if (hasReservedLearnedFactMetadata(input.metadata)) {
    throw new FridayDomainError(
      "MEMORY_BOUNDARY_RESERVED",
      "Durable memory writes cannot claim synthetic learned-fact boundary metadata.",
      { httpStatus: 409 },
    );
  }
  const nestedBoundary = isRecord(input.metadata?.learnedFact)
    ? input.metadata.learnedFact
    : undefined;
  if (hasReservedLearnedFactMetadata(nestedBoundary)) {
    throw new FridayDomainError(
      "MEMORY_BOUNDARY_RESERVED",
      "Durable memory writes cannot claim synthetic learned-fact boundary metadata.",
      { httpStatus: 409 },
    );
  }
}
