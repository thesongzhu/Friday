function normalizeSegment(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export interface GuidedAssistantSessionKeyInput {
  wizardId: string;
  userId?: string | null;
}

export function buildGuidedAssistantSessionKey(input: GuidedAssistantSessionKeyInput): string {
  const normalizedWizardId = normalizeSegment(input.wizardId || "unknown") || "unknown";
  const normalizedUserId = normalizeSegment(input.userId ?? "");
  const chatId = normalizedUserId
    ? `${normalizedUserId}-${normalizedWizardId}`
    : normalizedWizardId;
  return `guided:default:${chatId}`;
}
