import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import { FridayDomainError } from "#errors";
import type { FridayMutatingActionTicket } from "../../../security/friday-mutating-action-gate.js";
import { resolveSafePath, safeDirName } from "#utilities";
import { loadFridaySkillPackage } from "../../manifest/friday-skill-package-loader.js";
import { validateFridaySkillPackage } from "../../validation/friday-skill-validation-pipeline.js";
import type { FridaySkillValidationIssue } from "../../validation/friday-skill-validation.types.js";
import type {
  FridayConvertedSkillDraft,
  FridaySkillConversionSource,
  FridaySkillConverterContext,
  FridaySkillSourceFormat,
} from "../model/friday-skill-converter.types.js";
export interface FridaySkillCandidateValidation {
  ok: boolean;
  issues: FridaySkillValidationIssue[];
  verifiedAt: string;
}

export interface FridaySkillCandidateApprovalProof {
  gateId: "friday_canonical_mutating_action_gate";
  ticketId: string;
  actionDigest: string;
  action: string;
  surface: string;
  resource: FridayMutatingActionTicket["resource"];
  risk: FridayMutatingActionTicket["risk"];
  approvalId: string;
  approvedByPrincipalId: string;
  issuedAt: string;
  expiresAt?: string;
  planDigest?: string;
  childOfLifecycleTicketId?: string;
  idempotencyKey?: string;
}

export interface FridaySkillCandidateSourceProvenance {
  sourceKind: "uri" | "contentBase64";
  sourceDigest: string;
  redactedUri?: string;
  formatHint?: FridaySkillSourceFormat | "auto";
}

export interface FridayExternalSkillCandidate {
  candidateId: string;
  shadowVersionId: string;
  skillId: string;
  version: string;
  converterId: string;
  detectedFormat: FridaySkillSourceFormat;
  sourceProvenance: FridaySkillCandidateSourceProvenance;
  canonicalApprovalProof: FridaySkillCandidateApprovalProof;
  candidateDir: string;
  filesDir: string;
  stagedAt: string;
  validation: FridaySkillCandidateValidation;
}

export interface CreateFridaySkillCandidateStoreDeps {
  context: FridaySkillConverterContext;
  hubVersion: string;
  supportedApiVersions: string[];
  onCandidateStaged?: (event: { candidate: FridayExternalSkillCandidate; draft: FridayConvertedSkillDraft }) => Promise<void> | void;
}

export interface FridaySkillCandidateStore {
  stage(input: {
    source: FridaySkillConversionSource;
    converterId: string;
    detectedFormat: FridaySkillSourceFormat;
    draft: FridayConvertedSkillDraft;
    validation: { ok: boolean; issues: FridaySkillValidationIssue[] };
    canonicalApprovalTicket: FridayMutatingActionTicket;
  }): Promise<FridayExternalSkillCandidate>;
  get(input: { skillId: string; candidateId: string }): FridayExternalSkillCandidate | null;
}

interface PersistedCandidate {
  candidate: FridayExternalSkillCandidate;
  draft: FridayConvertedSkillDraft;
}

export function createFridaySkillCandidateSourceProvenance(
  source: FridaySkillConversionSource,
): FridaySkillCandidateSourceProvenance {
  const rawSource = source.uri ?? source.contentBase64 ?? "";
  const sourceKind = source.uri ? "uri" : "contentBase64";
  return {
    sourceKind,
    sourceDigest: hashString(rawSource),
    redactedUri: source.uri ? redactFridaySkillCandidateSourceUri(source.uri) : undefined,
    formatHint: source.formatHint,
  };
}

export function formatFridaySkillCandidateSourceProvenance(
  provenance: FridaySkillCandidateSourceProvenance,
): string {
  return provenance.redactedUri ?? `${provenance.sourceKind}:${provenance.sourceDigest}`;
}

export function redactFridaySkillCandidateSourceUri(uri: string): string {
  const trimmed = uri.trim();
  if (trimmed.length === 0) {
    return "empty-uri";
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "file:") {
      return `file-uri:${hashString(trimmed).slice(0, 16)}`;
    }
    parsed.username = parsed.username ? "redacted" : "";
    parsed.password = parsed.password ? "redacted" : "";
    const hadSearch = parsed.search.length > 0;
    parsed.search = hadSearch ? "?redacted=1" : "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return `local-path:${hashString(trimmed).slice(0, 16)}`;
  }
}

export function redactFridaySkillSourceText(
  text: string,
  source: FridaySkillConversionSource,
  provenance = createFridaySkillCandidateSourceProvenance(source),
): string {
  const replacement = formatFridaySkillCandidateSourceProvenance(provenance);
  let redacted = text;
  for (const raw of collectSourceRedactionNeedles(source)) {
    if (raw && raw.length > 0) {
      redacted = redacted.split(raw).join(replacement);
    }
  }
  return redacted;
}

export function redactFridaySkillSourceValue(
  value: unknown,
  source: FridaySkillConversionSource,
  provenance = createFridaySkillCandidateSourceProvenance(source),
): unknown {
  if (typeof value === "string") {
    return redactFridaySkillSourceText(value, source, provenance);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactFridaySkillSourceValue(item, source, provenance));
  }
  if (value && typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      redacted[key] = redactFridaySkillSourceValue(item, source, provenance);
    }
    return redacted;
  }
  return value;
}

function collectSourceRedactionNeedles(source: FridaySkillConversionSource): string[] {
  const needles = new Set<string>();
  if (source.uri) {
    needles.add(source.uri);
    try {
      const parsed = new URL(source.uri);
      if (parsed.username) needles.add(parsed.username);
      if (parsed.password) needles.add(parsed.password);
      for (const [key, value] of parsed.searchParams.entries()) {
        if (!value) continue;
        if (isSensitiveSourceParam(key) || value.length >= 12) {
          const pair = `${key}=${value}`;
          needles.add(pair);
          needles.add(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
        }
        if (value.length >= 12) {
          needles.add(value);
        }
      }
    } catch {
      // Non-URL local paths are already covered by the raw source string.
    }
  }
  if (source.contentBase64) {
    needles.add(source.contentBase64);
    try {
      const decoded = Buffer.from(source.contentBase64, "base64").toString("utf8");
      if (decoded.trim().length > 0) {
        needles.add(decoded);
      }
    } catch {
      // Invalid base64 is still covered by the raw string.
    }
  }
  return [...needles].sort((a, b) => b.length - a.length);
}

function isSensitiveSourceParam(key: string): boolean {
  return /^(?:access[_-]?token|api[_-]?key|apikey|auth|authorization|bearer|code|credential|key|password|refresh[_-]?token|secret|session|token)$/i.test(key);
}

export function createFridaySkillCandidateStore(
  deps: CreateFridaySkillCandidateStoreDeps,
): FridaySkillCandidateStore {
  const rootDir = join(deps.context.workspaceDir, "skill-candidates");

  function candidateIdForDraft(draft: FridayConvertedSkillDraft): string {
    const hash = createHash("sha256")
      .update(JSON.stringify({
        manifest: draft.manifest,
        files: draft.files.map((file) => ({
          path: file.path,
          content: file.content,
          executable: file.executable === true,
        })),
      }))
      .digest("hex")
      .slice(0, 16);
    return `${safeDirName(draft.manifest.id)}-${safeDirName(draft.manifest.version)}-${hash}`;
  }

  function candidateDir(candidateId: string): string {
    return resolveSafePath(rootDir, safeDirName(candidateId));
  }

  function metadataPath(dir: string): string {
    return join(dir, "candidate.json");
  }

  function filesDir(dir: string): string {
    return join(dir, "files");
  }

  function writeDraftFiles(dir: string, draft: FridayConvertedSkillDraft): void {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const file of draft.files) {
      const filePath = resolveSafePath(dir, file.path);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, file.content, "utf8");
      if (file.executable) {
        chmodSync(filePath, 0o755);
      }
    }
  }

  function readPersisted(input: { skillId: string; candidateId: string }): PersistedCandidate | null {
    const dir = candidateDir(input.candidateId);
    const path = metadataPath(dir);
    if (!existsSync(path)) {
      return null;
    }
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PersistedCandidate;
    if (parsed.candidate.skillId !== input.skillId || parsed.candidate.candidateId !== input.candidateId) {
      throw new FridayDomainError(
        "SKILL_CANDIDATE_MISMATCH",
        `Skill candidate "${input.candidateId}" does not belong to skill "${input.skillId}".`,
        { httpStatus: 409, details: { skillId: input.skillId, candidateId: input.candidateId } },
      );
    }
    if (normalizePersistedCandidate(parsed)) {
      persist(parsed);
    }
    return parsed;
  }

  function persist(record: PersistedCandidate): void {
    mkdirSync(record.candidate.candidateDir, { recursive: true });
    writeFileSync(metadataPath(record.candidate.candidateDir), JSON.stringify(record, null, 2), "utf8");
  }

  function validateFiles(dir: string, verifiedAt: string): FridaySkillCandidateValidation {
    const loaded = loadFridaySkillPackage({
      skillDir: dir,
      workspaceDir: deps.context.workspaceDir,
    });
    if (!loaded.ok) {
      return {
        ok: false,
        verifiedAt,
        issues: [{
          stage: "manifest",
          severity: "error",
          code: "PACKAGE_LOAD_FAILED",
          message: loaded.error.message,
        }],
      };
    }
    const validation = validateFridaySkillPackage({
      loaded: loaded.value,
      workspaceDir: deps.context.workspaceDir,
      hubVersion: deps.hubVersion,
      supportedApiVersions: deps.supportedApiVersions,
    });
    return {
      ok: validation.ok,
      issues: validation.issues,
      verifiedAt,
    };
  }

  return {
    async stage(input) {
      const sourceProvenance = createFridaySkillCandidateSourceProvenance(input.source);
      const draft = sanitizeDraftForCandidate(input.draft, input.source, sourceProvenance);
      const id = candidateIdForDraft(draft);
      const dir = candidateDir(id);
      const stagedFilesDir = filesDir(dir);
      mkdirSync(rootDir, { recursive: true });
      writeDraftFiles(stagedFilesDir, draft);
      const validation = validateFiles(stagedFilesDir, deps.context.nowIso());
      const combinedValidation = {
        ok: input.validation.ok && validation.ok,
        verifiedAt: validation.verifiedAt,
        issues: [...input.validation.issues, ...validation.issues],
      };
      const candidate: FridayExternalSkillCandidate = {
        candidateId: id,
        shadowVersionId: id,
        skillId: input.draft.manifest.id,
        version: input.draft.manifest.version,
        converterId: input.converterId,
        detectedFormat: input.detectedFormat,
        sourceProvenance,
        canonicalApprovalProof: createCandidateApprovalProof(input.canonicalApprovalTicket),
        candidateDir: dir,
        filesDir: stagedFilesDir,
        stagedAt: deps.context.nowIso(),
        validation: combinedValidation,
      };
      const record = { candidate, draft };
      persist(record);
      await deps.onCandidateStaged?.(record);
      return candidate;
    },

    get(input) {
      return readPersisted(input)?.candidate ?? null;
    },
  };
}

function normalizePersistedCandidate(record: PersistedCandidate): boolean {
  const candidate = record.candidate as FridayExternalSkillCandidate & {
    source?: FridaySkillConversionSource;
  };
  let changed = false;
  if (!candidate.sourceProvenance && candidate.source) {
    candidate.sourceProvenance = createFridaySkillCandidateSourceProvenance(candidate.source);
    changed = true;
  }
  if (candidate.source) {
    record.draft = sanitizeDraftForCandidate(record.draft, candidate.source, candidate.sourceProvenance);
    changed = true;
  }
  delete candidate.source;
  return changed;
}

function createCandidateApprovalProof(ticket: FridayMutatingActionTicket): FridaySkillCandidateApprovalProof {
  return {
    gateId: "friday_canonical_mutating_action_gate",
    ticketId: ticket.ticketId,
    actionDigest: ticket.actionDigest,
    action: ticket.action,
    surface: ticket.surface,
    resource: ticket.resource,
    risk: ticket.risk,
    approvalId: ticket.approvalId,
    approvedByPrincipalId: ticket.approvedByPrincipalId,
    issuedAt: ticket.issuedAt,
    expiresAt: ticket.expiresAt,
    planDigest: ticket.planDigest,
    childOfLifecycleTicketId: ticket.childOfLifecycleTicketId,
    idempotencyKey: ticket.idempotencyKey,
  };
}

function sanitizeDraftForCandidate(
  draft: FridayConvertedSkillDraft,
  source: FridaySkillConversionSource,
  provenance: FridaySkillCandidateSourceProvenance,
): FridayConvertedSkillDraft {
  const sourceRef = formatFridaySkillCandidateSourceProvenance(provenance);
  const conversionReport = {
    ...draft.conversionReport,
    sourceRef,
  };

  return {
    ...draft,
    conversionReport,
    files: draft.files.map((file) => {
      const content = sanitizeCandidateFileContent(file.path, file.content, source, provenance, conversionReport);
      return content === file.content ? file : { ...file, content };
    }),
  };
}

function sanitizeCandidateFileContent(
  filePath: string,
  content: string,
  source: FridaySkillConversionSource,
  provenance: FridaySkillCandidateSourceProvenance,
  conversionReport: FridayConvertedSkillDraft["conversionReport"],
): string {
  if (filePath.endsWith("conversion.report.json")) {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      return redactFridaySkillSourceText(
        JSON.stringify({ ...parsed, ...conversionReport }, null, 2),
        source,
        provenance,
      );
    } catch {
      // Malformed legacy reports still get plain text source redaction below.
    }
  }
  return redactFridaySkillSourceText(content, source, provenance);
}

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
