/**
 * Workflow filesystem-write evidence verifier (audit C, Stage 2A).
 *
 * Stage 1 truth-labels every side-effect node `proof_pending` because no
 * deterministic evidence plumbs through. Stage 2A closes the FIRST concrete
 * side-effect class — a bounded filesystem WRITE — by re-reading the node's
 * DECLARED write target after the skill runs and proving an independent
 * on-disk state delta. Only then does the node's completion upgrade to
 * `verified`; everything else (skill lied / wrote nothing / wrote elsewhere /
 * out-of-scope / its own receipt / an evidence-export mirror) stays
 * `proof_pending`.
 *
 * Scope of Stage 2A (deliberately narrow — see stage2a-plan.md):
 *  - Candidate ONLY when the node's skill grants are write-class with NO
 *    send/connect/capture/execute grant (a pure local file write — the only
 *    side effect a runtime fs re-read can independently witness). A
 *    write+send/connect/etc node is NOT a candidate and stays `proof_pending`.
 *  - The write target is sourced ONLY from TRUSTED node/manifest inputs (a
 *    reserved `config.args` key, or a single concrete manifest `pathPrefixes`
 *    file) — NEVER from the (untrusted) skill output. The skill's returned
 *    artifact URIs are used only to REFUSE a self-receipt / circular proof.
 *  - No skill-adapter / invokeSkill / FridaySkillExecuteResult signature
 *    change; no new persistence (verified flows through the existing
 *    record→persist path).
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { FridayWorkflowNode } from "../model/friday-workflow-graph.types.js";
import { validateFridayFilesystemScope } from "../../skills/validation/friday-skill-filesystem-scope-validator.js";

/**
 * Reserved `node.config.args` key declaring the CONCRETE filesystem path the
 * action node's skill is expected to write. This is the minimal binding-target
 * convention (requirement 1): it lives in the workflow node definition (trusted
 * input), is bounded by the skill's declared `pathPrefixes` scope, and requires
 * NO adapter contract change. The key is also passed through to the skill input
 * (the skill executor tolerates unknown args), so a skill can read it to know
 * exactly where to write.
 */
export const FRIDAY_FS_WRITE_TARGET_ARG_KEY = "__fridayWriteTarget";

/**
 * Permission `action`s that denote a real external side effect / state mutation
 * (mirrors the Stage-1 classifier's danger set). The ONLY one a runtime
 * filesystem re-read can independently witness is a `filesystem` `write`; every
 * other side-effecting grant — including `memory` `write` (a separate durable,
 * UNwitnessed mutation, since `write` is resource-overloaded), and
 * connect/send/capture/execute — disqualifies the node from fs-write
 * verification. We therefore WHITELIST (candidate ⇒ every side-effecting grant
 * is exactly `filesystem.write`), never blacklist a fixed verb set.
 */
const SIDE_EFFECTING_PERMISSION_ACTIONS: ReadonlySet<string> = new Set([
  "write",
  "connect",
  "send",
  "capture",
  "execute",
]);

export interface FridayFilesystemWriteTarget {
  /** The action node's skill id. */
  skillId: string;
  /** The skill install directory (manifest-relative scope root). */
  skillDir: string;
  /**
   * The declared write target, exactly as sourced from the node/manifest
   * (relative or absolute). Containment is enforced by the verifier, never
   * here.
   */
  declaredTarget: string;
  /**
   * Where the target was declared, which determines how a BARE-RELATIVE target
   * resolves: a `node-arg` target (the workflow author's reserved config.args
   * key) resolves relative to the WORKSPACE root; a `manifest-prefix` target
   * resolves with the same skill-relative semantics `validateFridayFilesystemScope`
   * uses. (`${workspaceDir}`-prefixed and absolute targets resolve identically
   * for both.)
   */
  targetSource: "node-arg" | "manifest-prefix";
  /**
   * The skill's declared filesystem write scope prefixes (manifest
   * `pathPrefixes`), used for containment + (when there is exactly one concrete
   * prefix) as the fallback binding target.
   */
  writePathPrefixes: string[];
}

/** Defensive narrow of whatever `resolveSkill` returns into manifest grants + skillDir. */
function readSkillShape(skill: unknown): {
  grants: Array<{ resource?: unknown; action?: unknown; selectors?: unknown }>;
  skillDir: string | null;
} | null {
  if (skill == null || typeof skill !== "object") return null;
  const manifest = (skill as { manifest?: unknown }).manifest;
  if (manifest == null || typeof manifest !== "object") return null;
  const permissions = (manifest as { permissions?: unknown }).permissions;
  if (permissions == null || typeof permissions !== "object") return null;
  const rawGrants = (permissions as { grants?: unknown }).grants;
  if (!Array.isArray(rawGrants)) return null;
  const grants = rawGrants.filter(
    (g): g is { resource?: unknown; action?: unknown; selectors?: unknown } =>
      g != null && typeof g === "object",
  );
  const skillDirRaw = (skill as { skillDir?: unknown }).skillDir;
  const skillDir = typeof skillDirRaw === "string" && skillDirRaw.length > 0 ? skillDirRaw : null;
  return { grants, skillDir };
}

/** Collect filesystem.write `pathPrefixes` selectors from the grants. */
function collectWritePathPrefixes(
  grants: Array<{ resource?: unknown; action?: unknown; selectors?: unknown }>,
): string[] {
  const prefixes: string[] = [];
  for (const grant of grants) {
    if (grant.resource !== "filesystem" || grant.action !== "write") continue;
    const selectors = grant.selectors;
    if (selectors == null || typeof selectors !== "object") continue;
    const pathPrefixes = (selectors as { pathPrefixes?: unknown }).pathPrefixes;
    if (!Array.isArray(pathPrefixes)) continue;
    for (const p of pathPrefixes) {
      if (typeof p === "string" && p.length > 0) prefixes.push(p);
    }
  }
  return prefixes;
}

/** Does the path prefix denote exactly one concrete file (no glob / trailing slash)? */
function isConcreteFilePrefix(prefix: string): boolean {
  if (prefix.includes("*")) return false;
  if (prefix.endsWith("/")) return false;
  return prefix.length > 0;
}

/**
 * Resolve the BINDING filesystem-write target for an action node, sourced ONLY
 * from trusted node/manifest inputs. Returns non-null ONLY when:
 *  - the node is an `action` node with a resolvable skill id;
 *  - the skill's grants contain a filesystem `write` action;
 *  - the skill's grants contain NO disqualifying side-effect action
 *    (send/connect/capture/execute);
 *  - a concrete binding target is resolvable, either:
 *      (a) the reserved `config.args.__fridayWriteTarget` key (a string), OR
 *      (b) the manifest declares EXACTLY ONE concrete (non-glob) write
 *          `pathPrefixes` entry.
 *
 * Otherwise returns null (the node is not an fs-write verification candidate
 * and stays `proof_pending`).
 */
export function resolveFilesystemWriteTarget(
  node: Pick<FridayWorkflowNode, "type" | "config">,
  resolveSkill: (skillId: string) => unknown,
): FridayFilesystemWriteTarget | null {
  if (node.type !== "action") return null;
  const cfg = (node.config ?? {}) as Record<string, unknown>;
  const skillId = typeof cfg.skillId === "string"
    ? cfg.skillId
    : typeof cfg.ref === "string"
      ? cfg.ref
      : undefined;
  if (!skillId) return null;

  const shape = readSkillShape(resolveSkill(skillId));
  if (!shape) return null;

  // WHITELIST gate (not blacklist): a runtime fs re-read can independently witness ONLY a
  // filesystem WRITE. So a candidate must declare a `filesystem.write` grant AND every one of
  // its side-effecting grants must be EXACTLY `filesystem.write`. Any other side-effecting
  // grant — `memory.write` (resource-overloaded `write`, a separate UNwitnessed durable
  // mutation), `network.connect`, `channel.send`, `device.capture`, `shell.execute`, or any
  // future resource×side-effect-action — disqualifies the node (it stays proof_pending).
  // Read-only grants (filesystem.read, *.receive, memory.read, …) do NOT disqualify.
  const sideEffectingGrants = shape.grants.filter(
    (g) => typeof g.action === "string" && SIDE_EFFECTING_PERMISSION_ACTIONS.has(g.action),
  );
  const hasFilesystemWrite = sideEffectingGrants.some(
    (g) => g.resource === "filesystem" && g.action === "write",
  );
  if (!hasFilesystemWrite) return null;
  const everySideEffectIsFilesystemWrite = sideEffectingGrants.every(
    (g) => g.resource === "filesystem" && g.action === "write",
  );
  if (!everySideEffectIsFilesystemWrite) return null;

  // skillDir is required to anchor manifest-relative scope containment.
  if (!shape.skillDir) return null;

  const writePathPrefixes = collectWritePathPrefixes(shape.grants);

  // (a) Reserved binding-target key in the node definition (trusted input).
  // NOTE: this value is also passed through to the skill payload via the node
  // executor's `resolveArgs`, which evaluates any `$`-prefixed string as a
  // workflow expression. The binding target is therefore an ABSOLUTE path or a
  // WORKSPACE-RELATIVE path (NOT `$`-prefixed); the verifier resolves it against
  // the workspace root.
  const args = (cfg.args ?? {}) as Record<string, unknown>;
  const reservedTarget = args[FRIDAY_FS_WRITE_TARGET_ARG_KEY];
  if (typeof reservedTarget === "string" && reservedTarget.trim().length > 0) {
    return {
      skillId,
      skillDir: shape.skillDir,
      declaredTarget: reservedTarget.trim(),
      targetSource: "node-arg",
      writePathPrefixes,
    };
  }

  // (b) Manifest declares exactly one concrete (non-glob) write file. This is a
  // manifest scope value, so it resolves with `validateFridayFilesystemScope`'s
  // skill-relative semantics.
  const concretePrefixes = writePathPrefixes.filter(isConcreteFilePrefix);
  if (concretePrefixes.length === 1) {
    return {
      skillId,
      skillDir: shape.skillDir,
      declaredTarget: concretePrefixes[0]!,
      targetSource: "manifest-prefix",
      writePathPrefixes,
    };
  }

  // No binding target → not a candidate (inert, stays proof_pending).
  return null;
}

// ─── snapshot / verify ───

export interface FridayFsVerifierDeps {
  /** Reads file bytes as utf8; returns null when the path does not exist. */
  readFile?: (absPath: string) => string | null;
  /** Existence + canonicalization probe; returns the real absolute path or null. */
  realpath?: (absPath: string) => string | null;
  /** Content checksum (same impl as the runtime's computeChecksum). */
  computeChecksum: (content: string) => string;
}

/** Default fs deps backed by node:fs (injectable for tests). */
export function defaultFsVerifierIo(): Pick<FridayFsVerifierDeps, "readFile" | "realpath"> {
  return {
    readFile: (absPath) => {
      try {
        return fs.readFileSync(absPath, "utf8");
      } catch {
        return null;
      }
    },
    realpath: (absPath) => {
      try {
        return fs.realpathSync(absPath);
      } catch {
        return null;
      }
    },
  };
}

/**
 * Resolve a declared target to a canonical absolute path. Uses the SAME scope
 * semantics as `validateFridayFilesystemScope`: `${workspaceDir}` prefix and
 * skill-relative resolution. Symlinks are canonicalized when the file exists;
 * a not-yet-existing target resolves to its absolute (un-canonicalized) path so
 * a newly-created file is detected post-exec.
 */
export function resolveCanonicalTargetPath(
  declaredTarget: string,
  skillDir: string,
  workspaceDir: string,
  realpath: (absPath: string) => string | null,
  targetSource: FridayFilesystemWriteTarget["targetSource"] = "node-arg",
): string {
  // A `${workspaceDir}`-prefixed or absolute target resolves identically for
  // either source. A BARE-RELATIVE target anchors on the WORKSPACE root for a
  // node-author-declared `node-arg` target, and on the SKILL dir for a
  // `manifest-prefix` target (matching `validateFridayFilesystemScope`).
  const relativeAnchor = targetSource === "manifest-prefix" ? skillDir : workspaceDir;
  const resolvedRaw = declaredTarget.startsWith("${workspaceDir}")
    ? declaredTarget.replace("${workspaceDir}", workspaceDir)
    : path.isAbsolute(declaredTarget)
      ? declaredTarget
      : path.join(relativeAnchor, declaredTarget);
  const abs = path.resolve(resolvedRaw);
  return realpath(abs) ?? abs;
}

export interface FridaySnapshot {
  /** Canonical absolute target path the snapshot was taken at. */
  canonicalPath: string;
  /**
   * Whether the target EXISTED pre-exec (independent of readability). Used to
   * distinguish a genuinely newly-created file (`!existed` → a real delta) from
   * an existing-but-unreadable file (`existed && checksum==null` → no provable
   * content delta → NOT verified), so a permission flip alone can't pass.
   */
  existed: boolean;
  /** Content checksum, or null if the file did not exist / was unreadable at snapshot time. */
  checksum: string | null;
}

/**
 * Pre-exec snapshot of the declared target: its canonical path + a checksum (or
 * null when the file does not yet exist). The post-exec verify compares against
 * this to require either a checksum change or a newly-created file.
 */
export function snapshotTarget(
  target: FridayFilesystemWriteTarget,
  workspaceDir: string,
  deps: FridayFsVerifierDeps,
): FridaySnapshot {
  const io = { ...defaultFsVerifierIo(), ...deps };
  const canonicalPath = resolveCanonicalTargetPath(
    target.declaredTarget,
    target.skillDir,
    workspaceDir,
    io.realpath!,
    target.targetSource,
  );
  const content = io.readFile!(canonicalPath);
  // Existence is independent of readability: a file that exists but is unreadable
  // (content==null yet realpath resolves) must NOT later look "newly created".
  const existed = content != null || io.realpath!(canonicalPath) != null;
  return {
    canonicalPath,
    existed,
    checksum: content == null ? null : deps.computeChecksum(content),
  };
}

export type FridayFsWriteVerifyOutcome =
  | { verified: true }
  | { verified: false; reason: string };

export interface VerifyFsWriteEvidenceInput {
  target: FridayFilesystemWriteTarget;
  snapshot: FridaySnapshot;
  /** Absolute root the evidence-export mirror lives under — a target here is REFUSED. */
  evidenceExportRootDir: string;
  /** The workspace root used for scope containment. */
  workspaceDir: string;
  /**
   * URIs / paths the skill RETURNED as its own artifacts/receipts (untrusted).
   * If the declared target equals any of these, the "evidence" is the skill's
   * own self-written receipt / a returned artifact — REFUSED (circular proof).
   */
  returnedArtifactUris: string[];
}

/** Normalize a possibly-`file://` / relative artifact URI to a canonical absolute path. */
function normalizeArtifactPath(
  uri: string,
  workspaceDir: string,
  skillDir: string,
  realpath: (absPath: string) => string | null,
): string | null {
  if (typeof uri !== "string" || uri.length === 0) return null;
  let raw = uri;
  if (raw.startsWith("file://")) {
    try {
      raw = new URL(raw).pathname;
    } catch {
      raw = raw.slice("file://".length);
    }
  } else if (/^[a-z]+:\/\//i.test(raw)) {
    // A non-file scheme (friday://, https://, etc.) can never equal a local
    // filesystem write target by path; skip it.
    return null;
  }
  const resolvedRaw = raw.startsWith("${workspaceDir}")
    ? raw.replace("${workspaceDir}", workspaceDir)
    : path.isAbsolute(raw)
      ? raw
      : path.join(skillDir, raw);
  const abs = path.resolve(resolvedRaw);
  return realpath(abs) ?? abs;
}

/** Is `candidate` equal to, or nested under, `root`? (both canonical absolute) */
function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Post-exec verification of a filesystem-write side effect. Returns
 * `{ verified: true }` ONLY when ALL hold:
 *  (a) the declared target EXISTS post-exec;
 *  (b) its content CHANGED vs the pre-exec snapshot, OR it is NEWLY created
 *      (snapshot checksum was null);
 *  (c) the target is WITHIN the skill's declared write scope
 *      (validateFridayFilesystemScope over each declared pathPrefix);
 *  (d) the target is NOT under `evidenceExportRootDir` (no evidence-export
 *      mirror / circular proof);
 *  (e) the target does NOT equal any skill-RETURNED artifact URI / receipt
 *      path (no self-receipt / circular proof).
 *
 * Any failure → `{ verified: false, reason }`; the caller maps this to
 * `proof_pending`. Reads are injected for testability; the runtime supplies the
 * real node:fs-backed deps.
 */
export function verifyFsWriteEvidence(
  input: VerifyFsWriteEvidenceInput,
  deps: FridayFsVerifierDeps,
): FridayFsWriteVerifyOutcome {
  const io = { ...defaultFsVerifierIo(), ...deps };
  const { target, snapshot, evidenceExportRootDir, workspaceDir, returnedArtifactUris } = input;

  // (a) target exists post-exec. Read via the snapshot path (which may be the
  // un-canonicalized absolute path of a not-yet-created file), then canonicalize
  // NOW that the file exists so all containment/equality comparisons below use
  // the same realpath form `validateFridayFilesystemScope` produces (this
  // matters on platforms where e.g. /tmp → /private/tmp).
  const postContent = io.readFile!(snapshot.canonicalPath);
  if (postContent == null) {
    return { verified: false, reason: "target-missing-post-exec" };
  }
  const canonicalPath = io.realpath!(snapshot.canonicalPath) ?? snapshot.canonicalPath;

  // (b) content changed OR genuinely newly created. A non-null pre-checksum requires the
  // content to differ. A null pre-checksum is only a real delta when the file did NOT exist
  // pre-exec; if it EXISTED but was unreadable at snapshot, we cannot prove a content delta
  // (a mere permission/readability flip is not evidence of a write) → refuse.
  if (snapshot.checksum != null) {
    const postChecksum = deps.computeChecksum(postContent);
    if (postChecksum === snapshot.checksum) {
      return { verified: false, reason: "target-unchanged" };
    }
  } else if (snapshot.existed) {
    return { verified: false, reason: "target-existed-unreadable-pre-exec" };
  }

  // (d) target not under the evidence-export mirror (circular proof).
  const evidenceRootCanonical = io.realpath!(evidenceExportRootDir) ?? path.resolve(evidenceExportRootDir);
  if (isWithin(evidenceRootCanonical, canonicalPath)) {
    return { verified: false, reason: "target-under-evidence-export-root" };
  }

  // (e) target not equal to any skill-returned artifact URI / receipt path.
  for (const uri of returnedArtifactUris) {
    const artifactPath = normalizeArtifactPath(uri, workspaceDir, target.skillDir, io.realpath!);
    if (artifactPath != null && artifactPath === canonicalPath) {
      return { verified: false, reason: "target-equals-returned-artifact" };
    }
  }

  // (c) target within declared write scope. With no declared prefixes there is
  // no scope to contain the write → refuse (fail-closed). With prefixes, the
  // target must be contained by at least one.
  if (target.writePathPrefixes.length === 0) {
    return { verified: false, reason: "no-declared-write-scope" };
  }
  const inScope = target.writePathPrefixes.some((prefix) => {
    const result = validateFridayFilesystemScope({
      scope: prefix,
      skillDir: target.skillDir,
      workspaceDir,
    });
    if (!result.ok || result.resolvedPath == null) return false;
    // The declared prefix may be the file itself (concrete) or a directory the
    // file lives under; accept the target if it equals or is nested under the
    // resolved scope path.
    return isWithin(result.resolvedPath, canonicalPath);
  });
  if (!inScope) {
    return { verified: false, reason: "target-out-of-scope" };
  }

  return { verified: true };
}
